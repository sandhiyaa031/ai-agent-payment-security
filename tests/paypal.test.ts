import { describe, expect, it } from "vitest";
import { PayPalRail } from "../src/rail/paypal";
import { RailError } from "../src/rail/rail";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A stand-in for fetch that answers from a script and records every request. */
function fakePayPal(responses: { status: number; body: unknown }[]) {
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
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected request to ${String(url)}`);
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const TOKEN = { status: 200, body: { access_token: "tok", expires_in: 3600 } };

function rail(fetchImpl: typeof fetch) {
  return new PayPalRail({
    clientId: "id",
    clientSecret: "secret",
    card: { number: "4111111111111111", expiry: "2030-01", securityCode: "123", name: "Test Buyer" },
    baseUrl: "https://paypal.test",
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

    const refund = await paypal.refund({ captureId: "CAP1", amountCents: 500, note: "why" });
    expect(refund).toEqual({ refundId: "REF1", status: "COMPLETED" });
    expect(calls).toHaveLength(3); // the token was reused
    expect(calls[2]?.url).toBe("https://paypal.test/v2/payments/captures/CAP1/refund");
    expect(calls[2]?.body).toEqual({ amount: { currency_code: "USD", value: "5.00" }, note_to_payer: "why" });
  });

  it("sums the refunds PayPal reports, ignoring ones that never moved money", async () => {
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
                ],
              },
            },
          ],
        },
      },
    ]);
    expect(await rail(fetchImpl).refundedCents("ORDER1")).toBe(550);
  });

  it("reports zero when an order has no refunds", async () => {
    const { fetchImpl } = fakePayPal([TOKEN, { status: 200, body: { id: "ORDER1", purchase_units: [{ payments: { captures: [{ id: "C" }] } }] } }]);
    expect(await rail(fetchImpl).refundedCents("ORDER1")).toBe(0);
  });

  it("raises a RailError carrying PayPal's response when a call fails", async () => {
    const { fetchImpl } = fakePayPal([TOKEN, { status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "Refund amount too high" } }]);
    const error = await rail(fetchImpl).refund({ captureId: "CAP1", amountCents: 1, note: "n" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RailError);
    expect((error as RailError).status).toBe(422);
    expect((error as RailError).message).toContain("Refund amount too high");
  });

  it("refuses to treat an unfinished charge as paid", async () => {
    const { fetchImpl } = fakePayPal([TOKEN, { status: 201, body: { id: "ORDER1", status: "PAYER_ACTION_REQUIRED" } }]);
    await expect(rail(fetchImpl).charge({ amountCents: 100, description: "x", reference: "r" })).rejects.toThrow(/did not complete/);
  });

  it("rejects bad credentials with a clear message", async () => {
    const { fetchImpl } = fakePayPal([{ status: 401, body: { error: "invalid_client" } }]);
    await expect(rail(fetchImpl).refundedCents("ORDER1")).rejects.toThrow(/client ID and secret/);
  });
});
