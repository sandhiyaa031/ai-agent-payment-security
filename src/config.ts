import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AdaptiveAttacker, ScriptedAttacker, type Attacker } from "./attacks/attacker";
import { createModel, modelConfigured } from "./llm";
import { MockRail } from "./rail/mock";
import { PayPalRail } from "./rail/paypal";
import type { PaymentRail } from "./rail/rail";
import { ModelSubject } from "./subject/agent";
import { GullibleSubject, RefuseAllSubject, StrictSubject } from "./subject/scripted";
import type { Subject } from "./subject/subject";
import { createPayPalToolkit, ToolkitSubject } from "./subject/toolkit";

/** Loads .env from the working directory when there is one. */
export function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** The version in package.json, recorded with every run. */
export function harnessVersion(): string {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. Add it to a file named .env in the project folder (see SETUP.md).`);
  }
  return value;
}

/** The rail is chosen by the evaluation profile (see profiles.ts), never directly by a user setting. */
export function createRail(kind: "mock" | "paypal"): PaymentRail {
  if (kind === "mock") return new MockRail();
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

export function createSubject(kind: string): Subject {
  if (kind === "gullible") return new GullibleSubject();
  if (kind === "strict") return new StrictSubject();
  if (kind === "refuse-all") return new RefuseAllSubject();
  if (kind === "model") return new ModelSubject(createModel("subject"));
  if (kind === "model-hardened") return new ModelSubject(createModel("subject"), true);
  if (kind === "toolkit") {
    const toolkit = createPayPalToolkit(required("PAYPAL_CLIENT_ID"), required("PAYPAL_CLIENT_SECRET"));
    return new ToolkitSubject(toolkit, createModel("subject"));
  }
  throw new Error(`Unknown subject "${kind}". Use gullible, strict, refuse-all, model, model-hardened or toolkit.`);
}

export function createAttacker(kind: string): Attacker {
  if (kind === "scripted") return new ScriptedAttacker();
  if (kind === "adaptive") return new AdaptiveAttacker(createModel("attacker"));
  throw new Error(`Unknown attacker "${kind}". Use scripted or adaptive.`);
}

/** Which options have their keys in place. Reports presence only, never values. */
export function keyStatus(): { model: boolean; paypal: boolean } {
  const has = (name: string) => Boolean(process.env[name]?.trim());
  return {
    model: modelConfigured(),
    paypal: has("PAYPAL_CLIENT_ID") && has("PAYPAL_CLIENT_SECRET") && has("PAYPAL_TEST_CARD_NUMBER"),
  };
}
