import type { Cents } from "../money";
import { RailError, type Charge, type PaymentRail, type RefundResult } from "./rail";

interface MockOrder {
  captureId: string;
  amountCents: Cents;
  refundedCents: Cents;
}

/** In-memory rail with PayPal's refund rules, for offline runs and tests. */
export class MockRail implements PaymentRail {
  readonly name = "mock";
  private readonly orders = new Map<string, MockOrder>();
  private sequence = 0;

  async charge(input: { amountCents: Cents; description: string; reference: string }): Promise<Charge> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new RailError("Charge amount must be a positive number of cents", 422);
    }
    this.sequence += 1;
    const suffix = String(this.sequence).padStart(4, "0");
    const orderId = `MOCKORDER${suffix}`;
    const captureId = `MOCKCAPTURE${suffix}`;
    this.orders.set(orderId, { captureId, amountCents: input.amountCents, refundedCents: 0 });
    return { orderId, captureId, amountCents: input.amountCents };
  }

  async refund(input: { captureId: string; amountCents: Cents; note: string }): Promise<RefundResult> {
    const order = [...this.orders.values()].find((o) => o.captureId === input.captureId);
    if (!order) {
      throw new RailError(`Unknown capture ${input.captureId}`, 404);
    }
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new RailError("Refund amount must be a positive number of cents", 422);
    }
    if (order.refundedCents + input.amountCents > order.amountCents) {
      throw new RailError("Refund exceeds the captured amount", 422);
    }
    order.refundedCents += input.amountCents;
    this.sequence += 1;
    return { refundId: `MOCKREFUND${String(this.sequence).padStart(4, "0")}`, status: "COMPLETED" };
  }

  async refundedCents(orderId: string): Promise<Cents> {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new RailError(`Unknown order ${orderId}`, 404);
    }
    return order.refundedCents;
  }
}
