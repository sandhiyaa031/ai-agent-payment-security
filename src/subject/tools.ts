import { usd, type Cents } from "../money";
import { RailError, type PaymentRail } from "../rail/rail";
import { entitledCents, type StoreOrder } from "../store/policy";

export interface SessionContext {
  /** The signed-in customer. The agent is told this; attackers cannot change it. */
  customerEmail: string;
}

/** Limits enforced in code, outside the model. Empty means a stock agent. */
export interface Guard {
  maxRefundCentsPerCall?: Cents;
  /** Refuse any refund beyond what the policy owes the signed-in customer. */
  enforcePolicy?: boolean;
}

export type ToolCallOutcome = "executed" | "blocked" | "failed";

export interface ToolCallRecord {
  orderId: string;
  amountCents: Cents;
  reason: string;
  outcome: ToolCallOutcome;
  detail: string;
}

export interface ToolResult {
  ok: boolean;
  message: string;
}

/** The two things a support agent can do: look an order up, and refund it. */
export interface SupportTools {
  getOrder(orderId: string): StoreOrder | undefined;
  getOrderByCapture(captureId: string): StoreOrder | undefined;
  /** Refunds through the harness's own rail client. */
  refundOrder(orderId: string, amountCents: Cents, reason: string): Promise<ToolResult>;
  /**
   * Applies the same guards and logging, but lets the caller move the money,
   * for agents whose refund tool talks to PayPal itself. `send` returns what
   * the provider answered and whether it accepted the refund.
   */
  refundVia(
    orderId: string,
    amountCents: Cents,
    reason: string,
    send: () => Promise<{ accepted: boolean; detail: string }>,
  ): Promise<ToolResult>;
}

export function createSupportTools(input: {
  orders: StoreOrder[];
  rail: PaymentRail;
  session: SessionContext;
  guard: Guard;
  log: ToolCallRecord[];
  /** Called as each refund attempt is settled, for live displays. */
  onCall?: (entry: ToolCallRecord) => void;
}): SupportTools {
  const { orders, rail, session, guard, log, onCall } = input;
  const byId = new Map(orders.map((order) => [order.orderId, order]));
  const refundedHere = new Map<string, Cents>();

  const record = (entry: ToolCallRecord, ok: boolean): ToolResult => {
    log.push(entry);
    onCall?.(entry);
    return { ok, message: entry.detail };
  };

  /** Runs the checks every refund must pass; returns a refusal, or null to proceed. */
  const refuse = (base: Pick<ToolCallRecord, "orderId" | "amountCents" | "reason">): ToolResult | null => {
    const order = byId.get(base.orderId);
    if (!order) {
      return record({ ...base, outcome: "failed", detail: `No order with id ${base.orderId}.` }, false);
    }
    if (!Number.isInteger(base.amountCents) || base.amountCents <= 0) {
      return record({ ...base, outcome: "failed", detail: "Refund amount must be greater than zero." }, false);
    }
    if (guard.maxRefundCentsPerCall !== undefined && base.amountCents > guard.maxRefundCentsPerCall) {
      const detail = `Blocked: refunds above ${usd(guard.maxRefundCentsPerCall)} need a human to approve them.`;
      return record({ ...base, outcome: "blocked", detail }, false);
    }
    if (guard.enforcePolicy) {
      const allowed = entitledCents(order, session.customerEmail) - (refundedHere.get(base.orderId) ?? 0);
      if (base.amountCents > allowed) {
        const detail = "Blocked: the refund policy does not allow this refund for the signed-in customer.";
        return record({ ...base, outcome: "blocked", detail }, false);
      }
    }
    return null;
  };

  const refundVia: SupportTools["refundVia"] = async (orderId, amountCents, reason, send) => {
    const base = { orderId, amountCents, reason };
    const refusal = refuse(base);
    if (refusal) return refusal;
    const { accepted, detail } = await send();
    if (!accepted) return record({ ...base, outcome: "failed", detail }, false);
    refundedHere.set(orderId, (refundedHere.get(orderId) ?? 0) + amountCents);
    return record({ ...base, outcome: "executed", detail }, true);
  };

  return {
    getOrder: (orderId) => byId.get(orderId),
    getOrderByCapture: (captureId) => orders.find((order) => order.captureId === captureId),
    refundVia,

    refundOrder(orderId, amountCents, reason) {
      return refundVia(orderId, amountCents, reason, async () => {
        // refuse() has already confirmed the order exists.
        const order = byId.get(orderId)!;
        try {
          const refund = await rail.refund({ captureId: order.captureId, amountCents, note: reason });
          return {
            accepted: true,
            detail: `Refunded ${usd(amountCents)} on order ${orderId} (refund ${refund.refundId}, ${refund.status}).`,
          };
        } catch (error) {
          if (!(error instanceof RailError)) throw error;
          return { accepted: false, detail: `Payment provider rejected the refund: ${error.message}` };
        }
      });
    },
  };
}
