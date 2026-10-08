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
  refundOrder(orderId: string, amountCents: Cents, reason: string): Promise<ToolResult>;
}

export function createSupportTools(input: {
  orders: StoreOrder[];
  rail: PaymentRail;
  session: SessionContext;
  guard: Guard;
  log: ToolCallRecord[];
}): SupportTools {
  const { orders, rail, session, guard, log } = input;
  const byId = new Map(orders.map((order) => [order.orderId, order]));
  const refundedHere = new Map<string, Cents>();

  const record = (entry: ToolCallRecord, ok: boolean): ToolResult => {
    log.push(entry);
    return { ok, message: entry.detail };
  };

  return {
    getOrder: (orderId) => byId.get(orderId),

    async refundOrder(orderId, amountCents, reason) {
      const base = { orderId, amountCents, reason };
      const order = byId.get(orderId);
      if (!order) {
        return record({ ...base, outcome: "failed", detail: `No order with id ${orderId}.` }, false);
      }
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        return record({ ...base, outcome: "failed", detail: "Refund amount must be greater than zero." }, false);
      }
      if (guard.maxRefundCentsPerCall !== undefined && amountCents > guard.maxRefundCentsPerCall) {
        const detail = `Blocked: refunds above ${usd(guard.maxRefundCentsPerCall)} need a human to approve them.`;
        return record({ ...base, outcome: "blocked", detail }, false);
      }
      if (guard.enforcePolicy) {
        const already = refundedHere.get(orderId) ?? 0;
        const allowed = entitledCents(order, session.customerEmail) - already;
        if (amountCents > allowed) {
          const detail = "Blocked: the refund policy does not allow this refund for the signed-in customer.";
          return record({ ...base, outcome: "blocked", detail }, false);
        }
      }
      try {
        const refund = await rail.refund({ captureId: order.captureId, amountCents, note: reason });
        refundedHere.set(orderId, (refundedHere.get(orderId) ?? 0) + amountCents);
        const detail = `Refunded ${usd(amountCents)} on order ${orderId} (refund ${refund.refundId}, ${refund.status}).`;
        return record({ ...base, outcome: "executed", detail }, true);
      } catch (error) {
        if (!(error instanceof RailError)) throw error;
        return record({ ...base, outcome: "failed", detail: `Payment provider rejected the refund: ${error.message}` }, false);
      }
    },
  };
}
