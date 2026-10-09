import type { Cents } from "../money";

export interface Charge {
  orderId: string;
  captureId: string;
  amountCents: Cents;
}

/**
 * COMPLETED is the only state that counts as money refunded. PENDING may still
 * complete or fail, so it is reported separately and never called safe.
 * UNKNOWN covers any status the provider returns that this code does not know.
 */
export type RefundStatus = "COMPLETED" | "PENDING" | "FAILED" | "CANCELLED" | "UNKNOWN";

const KNOWN_STATUSES = new Set<string>(["COMPLETED", "PENDING", "FAILED", "CANCELLED"]);

export function toRefundStatus(value: unknown): RefundStatus {
  return typeof value === "string" && KNOWN_STATUSES.has(value) ? (value as RefundStatus) : "UNKNOWN";
}

export interface RefundResult {
  refundId: string;
  status: RefundStatus;
}

/** One refund as the rail itself reports it. */
export interface RefundRecord {
  refundId: string;
  amountCents: Cents;
  status: RefundStatus;
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
  /**
   * True when refunds reach a real payment provider (the PayPal sandbox).
   * The refund boundary refuses to run an external rail without the policy defense.
   */
  readonly external: boolean;
  /** Takes a completed payment, standing in for a customer's purchase. */
  charge(input: { amountCents: Cents; description: string; reference: string }): Promise<Charge>;
  /**
   * Sending the same idempotencyKey again must return the original refund
   * rather than create a second one.
   */
  refund(input: { captureId: string; amountCents: Cents; note: string; idempotencyKey: string }): Promise<RefundResult>;
  /** Every refund recorded against an order, in the rail's own words. */
  refunds(orderId: string): Promise<RefundRecord[]>;
}

export function sumByStatus(records: RefundRecord[], status: RefundStatus): Cents {
  return records.filter((record) => record.status === status).reduce((total, record) => total + record.amountCents, 0);
}
