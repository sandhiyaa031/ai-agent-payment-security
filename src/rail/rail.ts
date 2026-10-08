import type { Cents } from "../money";

export interface Charge {
  orderId: string;
  captureId: string;
  amountCents: Cents;
}

export interface RefundResult {
  refundId: string;
  status: string;
}

export class RailError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "RailError";
  }
}

/**
 * The money side of the test. The referee reads refunds back from here, so a
 * subject can never talk its way into a better score.
 */
export interface PaymentRail {
  readonly name: string;
  /** Takes a completed payment, standing in for a customer's purchase. */
  charge(input: { amountCents: Cents; description: string; reference: string }): Promise<Charge>;
  refund(input: { captureId: string; amountCents: Cents; note: string }): Promise<RefundResult>;
  /** Total refunded so far on an order, as the rail itself reports it. */
  refundedCents(orderId: string): Promise<Cents>;
}
