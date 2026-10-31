import type { Cents } from "../money";
import { RailError, type Charge, type PaymentRail, type RefundRecord, type RefundResult } from "./rail";

/**
 * A second privileged tool, to show the harness is not tied to PayPal refunds:
 * instead of sending money back, the agent issues store credit from an
 * in-memory ledger. Nothing else changes. The same checkpoint, defenses and
 * scoring apply, because a rail only has to take a payment, grant something
 * against it, and report what it granted.
 *
 * Unlike a refund, credit is not limited by the payment rail: the ledger will
 * grant any positive amount, so the safety envelope and the defenses are all
 * that stand in the way. That is the realistic shape of a store-credit tool.
 */
export class StoreCreditRail implements PaymentRail {
  readonly name = "store-credit";
  readonly external = false;
  private readonly orders = new Map<string, { captureId: string; credits: RefundRecord[] }>();
  private readonly byKey = new Map<string, RefundResult>();
  private orderCount: number;
  private creditCount: number;

  constructor(options: { continueFrom?: { orders: number; refunds: number } } = {}) {
    this.orderCount = options.continueFrom?.orders ?? 0;
    this.creditCount = options.continueFrom?.refunds ?? 0;
  }

  async charge(input: { amountCents: Cents; description: string; reference: string }): Promise<Charge> {
    this.orderCount += 1;
    const suffix = String(this.orderCount).padStart(4, "0");
    const orderId = `STOREORDER${suffix}`;
    const captureId = `STOREPAYMENT${suffix}`;
    this.orders.set(orderId, { captureId, credits: [] });
    return { orderId, captureId, amountCents: input.amountCents };
  }

  async refund(input: { captureId: string; amountCents: Cents; note: string; idempotencyKey: string }): Promise<RefundResult> {
    const repeat = this.byKey.get(input.idempotencyKey);
    if (repeat) return repeat;
    const order = [...this.orders.values()].find((entry) => entry.captureId === input.captureId);
    if (!order) throw new RailError(`Unknown payment ${input.captureId}`, 404);
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new RailError("Credit must be a positive number of cents", 422);
    this.creditCount += 1;
    const result: RefundResult = { refundId: `STORECREDIT${String(this.creditCount).padStart(4, "0")}`, status: "COMPLETED" };
    order.credits.push({ refundId: result.refundId, amountCents: input.amountCents, status: "COMPLETED" });
    this.byKey.set(input.idempotencyKey, result);
    return result;
  }

  async refunds(orderId: string): Promise<RefundRecord[]> {
    const order = this.orders.get(orderId);
    if (!order) throw new RailError(`Unknown order ${orderId}`, 404);
    return order.credits.map((credit) => ({ ...credit }));
  }
}
