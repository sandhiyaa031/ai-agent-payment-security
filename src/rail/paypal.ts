import { randomUUID } from "node:crypto";
import { toCents, toDecimal, type Cents } from "../money";
import { RailError, toRefundStatus, type Charge, type PaymentRail, type RefundRecord, type RefundResult } from "./rail";

/**
 * Sandbox only. This tool issues refunds on purpose, so there is deliberately
 * no way to point it at PayPal's live API from the CLI.
 */
export const PAYPAL_SANDBOX_URL = "https://api-m.sandbox.paypal.com";

export interface TestCard {
  number: string;
  /** YYYY-MM */
  expiry: string;
  securityCode: string;
  name: string;
}

export interface PayPalRailOptions {
  clientId: string;
  clientSecret: string;
  card: TestCard;
  /** Tests inject these; the CLI always uses the sandbox URL and global fetch. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface OrderPayments {
  captures?: { id?: string; status?: string }[];
  refunds?: { id?: string; status?: string; amount?: { value?: string } }[];
}

interface OrderResponse {
  id?: string;
  status?: string;
  purchase_units?: { payments?: OrderPayments }[];
}

/** A request that failed this way may or may not have reached PayPal, so it is safe to resend only with the same key. */
const RESEND_STATUSES = new Set([500, 502, 503, 504]);

/**
 * The only hosts this client will talk to: PayPal's sandbox, and the reserved
 * .test domain that the unit tests use and that can never resolve.
 */
function assertSandboxHost(baseUrl: string): void {
  const { protocol, hostname } = new URL(baseUrl);
  const allowed = protocol === "https:" && (hostname.endsWith(".sandbox.paypal.com") || hostname.endsWith(".test"));
  if (!allowed) {
    throw new Error(`Refusing to use ${baseUrl}: Crashtest only talks to the PayPal sandbox.`);
  }
}

export class PayPalRail implements PaymentRail {
  readonly name = "paypal-sandbox";
  readonly external = true;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private token: { value: string; expiresAt: number } | undefined;

  constructor(private readonly options: PayPalRailOptions) {
    this.baseUrl = options.baseUrl ?? PAYPAL_SANDBOX_URL;
    assertSandboxHost(this.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async charge(input: { amountCents: Cents; description: string; reference: string }): Promise<Charge> {
    const { card } = this.options;
    const order = await this.request<OrderResponse>("POST", "/v2/checkout/orders", randomUUID(), {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: input.reference,
          custom_id: input.reference.slice(0, 127),
          description: input.description.slice(0, 127),
          amount: { currency_code: "USD", value: toDecimal(input.amountCents) },
        },
      ],
      payment_source: {
        card: {
          number: card.number,
          expiry: card.expiry,
          security_code: card.securityCode,
          name: card.name,
          billing_address: {
            address_line_1: "1 Main St",
            admin_area_2: "San Jose",
            admin_area_1: "CA",
            postal_code: "95131",
            country_code: "US",
          },
        },
      },
    });

    const captureId = order.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    if (!order.id || order.status !== "COMPLETED" || !captureId) {
      throw new RailError(
        `Test charge did not complete (status ${order.status ?? "unknown"}). ` +
          "Check that card payments are enabled on the sandbox app and the test card is valid.",
        undefined,
        order,
      );
    }
    return { orderId: order.id, captureId, amountCents: input.amountCents };
  }

  async refund(input: { captureId: string; amountCents: Cents; note: string; idempotencyKey: string }): Promise<RefundResult> {
    const refund = await this.request<{ id?: string; status?: string }>(
      "POST",
      `/v2/payments/captures/${encodeURIComponent(input.captureId)}/refund`,
      input.idempotencyKey,
      {
        amount: { currency_code: "USD", value: toDecimal(input.amountCents) },
        note_to_payer: input.note.slice(0, 255),
      },
    );
    if (!refund.id) {
      throw new RailError("PayPal returned a refund without an id", undefined, refund);
    }
    return { refundId: refund.id, status: toRefundStatus(refund.status) };
  }

  async refunds(orderId: string): Promise<RefundRecord[]> {
    const order = await this.request<OrderResponse>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    const records: RefundRecord[] = [];
    for (const unit of order.purchase_units ?? []) {
      for (const refund of unit.payments?.refunds ?? []) {
        // A refund with no readable amount cannot be scored, so it is surfaced as UNKNOWN rather than dropped.
        const readable = typeof refund.amount?.value === "string";
        records.push({
          refundId: refund.id ?? "(no id)",
          amountCents: readable ? toCents(refund.amount!.value!) : 0,
          status: readable ? toRefundStatus(refund.status) : "UNKNOWN",
        });
      }
    }
    return records;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) {
      return this.token.value;
    }
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64");
    const response = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const body = await readBody(response);
    if (!response.ok) {
      throw new RailError("PayPal rejected the client ID and secret", response.status, body);
    }
    const { access_token, expires_in } = body as { access_token?: string; expires_in?: number };
    if (!access_token) {
      throw new RailError("PayPal returned no access token", response.status, body);
    }
    // Refresh a minute early so a token never expires mid-request.
    this.token = { value: access_token, expiresAt: Date.now() + ((expires_in ?? 300) - 60) * 1000 };
    return access_token;
  }

  /**
   * Sends one request. A write carries an idempotency key and is resent once,
   * with the same key, if the first try fails in a way that leaves its fate
   * unknown. PayPal answers a repeated key with the original result, so a
   * resend can never create a second payment or refund.
   */
  private async request<T>(method: "GET", path: string): Promise<T>;
  private async request<T>(method: "POST", path: string, idempotencyKey: string, body: unknown): Promise<T>;
  private async request<T>(method: "GET" | "POST", path: string, idempotencyKey?: string, body?: unknown): Promise<T> {
    const attempts = method === "POST" ? 2 : 1;
    for (let attempt = 1; ; attempt += 1) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await this.accessToken()}`,
        "Content-Type": "application/json",
      };
      if (idempotencyKey !== undefined) {
        headers["PayPal-Request-Id"] = idempotencyKey;
        headers["Prefer"] = "return=representation";
      }

      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (attempt < attempts) continue;
        throw new RailError(`PayPal ${method} ${path} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
      }

      const parsed = await readBody(response);
      if (response.ok) return parsed as T;
      if (RESEND_STATUSES.has(response.status) && attempt < attempts) continue;
      const detail = (parsed as { message?: string } | undefined)?.message ?? response.statusText;
      throw new RailError(`PayPal ${method} ${path} failed: ${detail}`, response.status, parsed);
    }
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
