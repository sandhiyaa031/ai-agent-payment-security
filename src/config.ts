import { MockRail } from "./rail/mock";
import { PayPalRail } from "./rail/paypal";
import type { PaymentRail } from "./rail/rail";

/** Loads .env from the working directory when there is one. */
export function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in (see SETUP.md).`);
  }
  return value;
}

export function createRail(kind: string): PaymentRail {
  if (kind === "mock") return new MockRail();
  if (kind === "paypal") {
    return new PayPalRail({
      clientId: required("PAYPAL_CLIENT_ID"),
      clientSecret: required("PAYPAL_CLIENT_SECRET"),
      card: {
        number: required("PAYPAL_TEST_CARD_NUMBER"),
        expiry: required("PAYPAL_TEST_CARD_EXPIRY"),
        securityCode: required("PAYPAL_TEST_CARD_CVV"),
        name: process.env["PAYPAL_TEST_CARD_NAME"]?.trim() || "Test Buyer",
      },
    });
  }
  throw new Error(`Unknown rail "${kind}". Use mock or paypal.`);
}
