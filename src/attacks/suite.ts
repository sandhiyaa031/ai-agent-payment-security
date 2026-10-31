import { readFileSync } from "node:fs";
import type { Delivery } from "../store/policy";
import type { OrderSpec, Scenario } from "./scenarios";

/** A versioned set of scenarios, shipped as a JSON data file so attacks can be added without touching code. */
export interface Suite {
  version: string;
  title?: string;
  scenarios: Scenario[];
}

const DELIVERIES: Delivery[] = ["IN_TRANSIT", "DELIVERED", "LOST"];

/** Reads and checks a suite. A mistake in a data file is reported with where it is, before anything runs. */
export function parseSuite(data: unknown, source: string): Suite {
  const fail = (where: string, problem: string): never => {
    throw new Error(`${source}, ${where}: ${problem}`);
  };
  const file = data as { suite?: unknown; title?: unknown; scenarios?: unknown };
  if (typeof file?.suite !== "string" || !file.suite) fail("top level", `"suite" must be a version string`);
  if (!Array.isArray(file.scenarios) || file.scenarios.length === 0) fail("top level", `"scenarios" must be a non-empty list`);

  const seen = new Set<string>();
  const ids = new Set((file.scenarios as { id?: string }[]).map((s) => s.id));
  for (const [index, raw] of (file.scenarios as Partial<Scenario>[]).entries()) {
    const at = `scenario ${raw.id ?? `#${index + 1}`}`;
    if (typeof raw.id !== "string" || !/^[a-z0-9-]+$/.test(raw.id)) fail(at, "id must use lowercase letters, digits and dashes");
    if (seen.has(raw.id!)) fail(at, "this id is used twice");
    seen.add(raw.id!);
    if (!Number.isInteger(raw.version) || raw.version! < 1) fail(at, "version must be a whole number of 1 or more");
    if (raw.kind !== "attack" && raw.kind !== "benign") fail(at, `kind must be "attack" or "benign"`);
    for (const field of ["title", "category", "customerEmail", "goal"] as const) {
      if (typeof raw[field] !== "string" || !raw[field]) fail(at, `${field} is required`);
    }
    if (raw.counterpart !== undefined && !ids.has(raw.counterpart)) fail(at, `counterpart "${raw.counterpart}" is not in this file`);
    if (!Array.isArray(raw.script) || raw.script.length === 0 || raw.script.some((line) => typeof line !== "string" || !line)) {
      fail(at, "script must be a non-empty list of messages");
    }
    if (!Array.isArray(raw.orders) || raw.orders.length === 0) fail(at, "orders must be a non-empty list");

    const keys = new Set<string>();
    for (const order of raw.orders as Partial<OrderSpec>[]) {
      const where = `${at}, order ${order.key ?? "?"}`;
      if (typeof order.key !== "string" || !order.key) fail(where, "key is required");
      keys.add(order.key!);
      if (typeof order.ownerEmail !== "string" || typeof order.item !== "string") fail(where, "ownerEmail and item are required");
      if (!Number.isInteger(order.amountCents) || order.amountCents! <= 0) fail(where, "amountCents must be a positive whole number of cents");
      if (!Number.isInteger(order.placedDaysAgo) || order.placedDaysAgo! < 0) fail(where, "placedDaysAgo must be a whole number");
      if (!DELIVERIES.includes(order.delivery as Delivery)) fail(where, `delivery must be one of ${DELIVERIES.join(", ")}`);
      // Written by hand on purpose: the runner checks it against the policy code on every run.
      if (!Number.isInteger(order.expectedRefundCents) || order.expectedRefundCents! < 0) fail(where, "expectedRefundCents is required, in whole cents");
    }
    for (const text of [raw.goal!, ...raw.script!]) {
      for (const [, key] of text.matchAll(/\{(\w+)\}/g)) {
        if (!keys.has(key!)) fail(at, `the text mentions {${key}}, which is not one of its orders`);
      }
    }
  }
  return { version: file.suite as string, ...(typeof file.title === "string" ? { title: file.title } : {}), scenarios: file.scenarios as Scenario[] };
}

export function loadSuite(path: string): Suite {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read scenarios from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseSuite(data, path);
}
