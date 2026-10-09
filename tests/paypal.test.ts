import { describe, expect, it } from "vitest";
import { PayPalRail } from "../src/rail/paypal";
import { RailError } from "../src/rail/rail";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status: number; body: unknown } | "network-error";

/** A stand-in for fetch that answers from a script and records every request. */
function fakePayPal(replies: Reply[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : undefined;
    let body: unknown = raw;
    try {
      body = raw === undefined ? undefined : JSON.parse(raw);
    } catch {
      // form-encoded token request stays a string
    }
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body });
    const next = replies.shift();
    if (!next) throw new Error(`Unexpected request to ${String(url)}`);
    if (next === "network-error") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const TOKEN: Reply = { status: 200, body: { access_token: "tok", expires_in: 3600 } };
const REFUND_REQUEST = { captureId: "CAP1", amountCents: 500, note: "why", idempotencyKey: "key-123" };

function rail(fetchImpl: typeof fetch, baseUrl = "https://paypal.test") {
  return new PayPalRail({
    clientId: "id",
    clientSecret: "secret",
    card: { number: "4111111111111111", expiry: "2030-01", securityCode: "123", name: "Test Buyer" },
    baseUrl,
    fetchImpl,
  });
}

describe("PayPal sandbox rail", () => {
  it("authenticates once, then charges a test card and returns the capture", async () => {
    const { calls, fetchImpl } = fakePayPal([
      TOKEN,
      { status: 201, body: { id: "ORDER1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP1" }] } }] } },
      { status: 201, body: { id: "REF1", status: "COMPLETED" } },
    ]);
    const paypal = rail(fetchImpl);
    expect(paypal.external).toBe(true);

    const charge = await paypal.charge({ amountCents: 1299, description: "Lamp", reference: "ref-1" });
    expect(charge).toEqual({ orderId: "ORDER1", captureId: "CAP1", amountCents: 1299 });

    const [token, order] = calls;
    expect(token?.url).toBe("https://paypal.test/v1/oauth2/token");
    expect(token?.headers["Authorization"]).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);
    expect(token?.body).toBe("grant_type=client_credentials");
    expect(order?.url).toBe("https://paypal.test/v2/checkout/orders");
    expect(order?.headers["Authorization"]).toBe("Bearer tok");
    expect(order?.headers["PayPal-Request-Id"]).toBeTruthy();
    expect(order?.body).toMatchObject({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "USD", value: "12.99" } }],
      payment_source: { card: { number: "4111111111111111", expiry: "2030-01", security_code: "123" } },
    });

    const refund = await paypal.refund(REFUND_REQUEST);
    expect(refund).toEqual({ refundId: "REF1", status: "COMPLETED" });
    expect(calls).toHaveLength(3); // the token was reused
    expect(calls[2]?.url).toBe("https://paypal.test/v2/payments/captures/CAP1/refund");
    expect(calls[2]?.headers["PayPal-Request-Id"]).toBe("key-123");
    expect(calls[2]?.body).toEqual({ amount: { currency_code: "USD", value: "5.00" }, note_to_payer: "why" });
  });

  it("only talks to the PayPal sandbox", () => {
    const { fetchImpl } = fakePayPal([]);
    for (const live of ["https://api-m.paypal.com", "https://api.paypal.com", "https://example.com", "http://api-m.sandbox.paypal.com", "https://sandbox.paypal.com.evil.example"]) {
      expect(() => rail(fetchImpl, live), live).toThrow(/only talks to the PayPal sandbox/);
    }
    expect(() => rail(fetchImpl, "https://api-m.sandbox.paypal.com")).not.toThrow();
    // With no override, the client uses the sandbox.
    expect(() => new PayPalRail({ clientId: "a", clientSecret: "b", card: { number: "1", expiry: "2030-01", securityCode: "1", name: "n" } })).not.toThrow();
  });

  it("reports each refund with its own status, so pending and failed ones are never counted as completed", async () => {
    const { fetchImpl } = fakePayPal([
      TOKEN,
      {
        status: 200,
        body: {
          id: "ORDER1",
          purchase_units: [
            {
              payments: {
                refunds: [
                  { id: "R1", status: "COMPLETED", amount: { value: "4.00" } },
                  { id: "R2", status: "PENDING", amount: { value: "1.50" } },
                  { id: "R3", status: "FAILED", amount: { value: "9.00" } },
                  { id: "R4", status: "CANCELLED", amount: { value: "2.00" } },
                  { id: "R5", status: "SOMETHING_NEW", amount: { value: "3.00" } },
                  { id: "R6", status: "COMPLETED" },
                ],
              },
            },
          ],
        },
      },
    ]);
    expect(await rail(fetchImpl).refunds("ORDER1")).toEqual([
      { refundId: "R1", amountCents: 400, status: "COMPLETED" },
      { refundId: "R2", amountCents: 150, status: "PENDING" },
      { refundId: "R3", amountCents: 900, status: "FAILED" },
      { refundId: "R4", amountCents: 200, status: "CANCELLED" },
      { refundId: "R5", amountCents: 300, status: "UNKNOWN" },
      { refundId: "R6", amountCents: 0, status: "UNKNOWN" }, // no amount: surfaced, not scored
    ]);
  });

  it("reports no refunds when an order has none", async () => {
    const { fetchImpl } = fakePayPal([TOKEN, { status: 200, body: { id: "ORDER1", purchase_units: [{ payments: { captures: [{ id: "C" }] } }] } }]);
    expect(await rail(fetchImpl).refunds("ORDER1")).toEqual([]);
  });

  it("resends a refund once after a server error or a dropped connection, with the same idempotency key", async () => {
    for (const firstReply of [{ status: 503, body: {} }, "network-error"] as Reply[]) {
      const { calls, fetchImpl } = fakePayPal([TOKEN, firstReply, { status: 201, body: { id: "REF1", status: "COMPLETED" } }]);
      const refund = await rail(fetchImpl).refund(REFUND_REQUEST);
      expect(refund.refundId).toBe("REF1");
      const refundCalls = calls.filter((call) => call.url.endsWith("/refund"));
      expect(refundCalls).toHaveLength(2);
      expect(refundCalls.map((call) => call.headers["PayPal-Request-Id"])).toEqual(["key-123", "key-123"]);
    }
  });

  it("gives up after the one resend and says the request could not be confirmed", async () => {
    const { calls, fetchImpl } = fakePayPal([TOKEN, "network-error", "network-error"]);
    const error = await rail(fetchImpl).refund(REFUND_REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RailError);
    expect((error as RailError).status).toBeUndefined(); // no clear answer, so callers treat it as unresolved
    expect(calls.filter((call) => call.url.endsWith("/refund"))).toHaveLength(2);
  });

  it("does not resend a request PayPal clearly refused", async () => {
    const { calls, fetchImpl } = fakePayPal([TOKEN, { status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "Refund amount too high" } }]);
    const error = await rail(fetchImpl).refund(REFUND_REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RailError);
    expect((error as RailError).status).toBe(422);
    expect((error as RailError).message).toContain("Refund amount too high");
    expect(calls).toHaveLength(2);
  });

  it("refuses to treat an unfinished charge as paid", async () => {
    const { fetchImpl } = fakePayPal([TOKEN, { status: 201, body: { id: "ORDER1", status: "PAYER_ACTION_REQUIRED" } }]);
    await expect(rail(fetchImpl).charge({ amountCents: 100, description: "x", reference: "r" })).rejects.toThrow(/did not complete/);
  });

  it("rejects bad credentials with a clear message", async () => {
    const { fetchImpl } = fakePayPal([{ status: 401, body: { error: "invalid_client" } }]);
    await expect(rail(fetchImpl).refunds("ORDER1")).rejects.toThrow(/client ID and secret/);
  });
});
