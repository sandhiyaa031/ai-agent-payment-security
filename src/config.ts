import { AdaptiveAttacker, ScriptedAttacker, type Attacker } from "./attacks/attacker";
import { MockRail } from "./rail/mock";
import { PayPalRail } from "./rail/paypal";
import type { PaymentRail } from "./rail/rail";
import { ClaudeSubject, DEFAULT_MODEL } from "./subject/claude";
import { GullibleSubject, StrictSubject } from "./subject/scripted";
import type { Subject } from "./subject/subject";

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
    throw new Error(`${name} is not set. Add it to a file named .env in the project folder (see SETUP.md).`);
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

export function createSubject(kind: string): Subject {
  if (kind === "gullible") return new GullibleSubject();
  if (kind === "strict") return new StrictSubject();
  if (kind === "claude") return new ClaudeSubject(process.env["CRASHTEST_SUBJECT_MODEL"]?.trim() || DEFAULT_MODEL);
  throw new Error(`Unknown subject "${kind}". Use gullible, strict or claude.`);
}

export function createAttacker(kind: string): Attacker {
  if (kind === "scripted") return new ScriptedAttacker();
  if (kind === "adaptive") return new AdaptiveAttacker(process.env["CRASHTEST_ATTACKER_MODEL"]?.trim() || DEFAULT_MODEL);
  throw new Error(`Unknown attacker "${kind}". Use scripted or adaptive.`);
}

/** Which options have their keys in place. Reports presence only, never values. */
export function keyStatus(): { model: boolean; paypal: boolean } {
  const has = (name: string) => Boolean(process.env[name]?.trim());
  return {
    model: has("ANTHROPIC_API_KEY") || has("ANTHROPIC_AUTH_TOKEN"),
    paypal: has("PAYPAL_CLIENT_ID") && has("PAYPAL_CLIENT_SECRET") && has("PAYPAL_TEST_CARD_NUMBER"),
  };
}
