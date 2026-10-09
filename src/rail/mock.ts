import type { Cents } from "../money";
import { RailError, type Charge, type PaymentRail, type RefundRecord, type RefundResult, type RefundStatus } from "./rail";

interface MockOrder {
  captureId: string;
  amountCents: Cents;
  refunds: RefundRecord[];
}

export interface MockRailOptions {
  /** Decides how each new refund settles. Tests use it to produce pending and failed refunds. */
  settle?: (refundNumber: number) => RefundStatus;
}

/** Refunds in these states hold or have moved money, so they use up the captured amount. */
const HOLDS_FUNDS = new Set<RefundStatus>(["COMPLETED", "PENDING"]);

/** In-memory rail with PayPal's refund rules, for offline runs and tests. */
export class MockRail implements PaymentRail {
  readonly name = "mock";
  readonly external = false;
  private readonly orders = new Map<string, MockOrder>();
  private readonly byKey = new Map<string, RefundResult>();
  private sequence = 0;
  private refundCount = 0;

  constructor(private readonly options: MockRailOptions = {}) {}

  async charge(input: { amountCents: Cents; description: string; reference: string }): Promise<Charge> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new RailError("Charge amount must be a positive number of cents", 422);
    }
    this.sequence += 1;
    const suffix = String(this.sequence).padStart(4, "0");
    const orderId = `MOCKORDER${suffix}`;
    const captureId = `MOCKCAPTURE${suffix}`;
    this.orders.set(orderId, { captureId, amountCents: input.amountCents, refunds: [] });
    return { orderId, captureId, amountCents: input.amountCents };
  }

  async refund(input: { captureId: string; amountCents: Cents; note: string; idempotencyKey: string }): Promise<RefundResult> {
    const repeat = this.byKey.get(input.idempotencyKey);
    if (repeat) return repeat;

    const order = [...this.orders.values()].find((o) => o.captureId === input.captureId);
    if (!order) {
      throw new RailError(`Unknown capture ${input.captureId}`, 404);
    }
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new RailError("Refund amount must be a positive number of cents", 422);
    }
    const held = order.refunds.filter((r) => HOLDS_FUNDS.has(r.status)).reduce((total, r) => total + r.amountCents, 0);
    if (held + input.amountCents > order.amountCents) {
      throw new RailError("Refund exceeds the captured amount", 422);
    }
    this.refundCount += 1;
    const status = this.options.settle?.(this.refundCount) ?? "COMPLETED";
    const result: RefundResult = { refundId: `MOCKREFUND${String(this.refundCount).padStart(4, "0")}`, status };
    order.refunds.push({ refundId: result.refundId, amountCents: input.amountCents, status });
    this.byKey.set(input.idempotencyKey, result);
    return result;
  }

  async refunds(orderId: string): Promise<RefundRecord[]> {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new RailError(`Unknown order ${orderId}`, 404);
    }
    return order.refunds.map((record) => ({ ...record }));
  }
}
