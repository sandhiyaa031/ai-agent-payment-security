import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ScriptedAttacker, TECHNIQUES } from "../src/attacks/attacker";
import { SCENARIOS } from "../src/attacks/scenarios";
import { loadSuite, parseSuite } from "../src/attacks/suite";
import { MockRail } from "../src/rail/mock";
import type { Recording } from "../src/recording";
import { runAll } from "../src/runner";
import { entitledCents } from "../src/store/policy";
import { DATAMARK, ModelSubject } from "../src/subject/agent";
import { GullibleSubject, StrictSubject } from "../src/subject/scripted";
import { createSupportTools } from "../src/subject/tools";
import { call, fakeModel, NO_DEFENSE } from "./helpers";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const set2 = loadSuite(join(ROOT, "scenarios", "set-2.json"));
const set3 = loadSuite(join(ROOT, "scenarios", "set-3.json"));

describe("scenario data files", () => {
  it("keep set 2 identical to the built-in scenarios that experiments 01 and 02 use", () => {
    expect(set2.version).toBe("2");
    const plain = set2.scenarios.map(({ family: _f, owasp: _o, atlas: _a, counterpart: _c, ...rest }) => rest);
    expect(plain).toEqual(SCENARIOS);
  });

  it("give every expected refund by hand, and the policy code agrees with each one", () => {
    for (const scenario of set3.scenarios) {
      for (const spec of scenario.orders) {
        const order = { orderId: "X", captureId: "Y", customerEmail: spec.ownerEmail, item: spec.item, amountCents: spec.amountCents, placedDaysAgo: spec.placedDaysAgo, delivery: spec.delivery, deliveredDaysAgo: spec.deliveredDaysAgo, returnReceived: spec.returnReceived ?? false };
        expect(entitledCents(order, scenario.customerEmail), `${scenario.id} ${spec.key}`).toBe(spec.expectedRefundCents);
      }
    }
  });

  it("cover every attack family in the brief, each attack mapped, with honest customers alongside", () => {
    const families = new Set(set3.scenarios.map((s) => s.family));
    for (const family of ["indirect-injection", "multi-turn-escalation", "salami", "tool-argument-manipulation", "authority-impersonation", "encoding-obfuscation", "cross-customer"]) {
      expect(families, family).toContain(family);
    }
    const indirect = set3.scenarios.filter((s) => s.family === "indirect-injection").map((s) => s.category).sort();
    expect(indirect).toEqual(["carrier status text", "email body", "order note", "product review", "ticket history", "tool output field"]);

    for (const scenario of [...set2.scenarios, ...set3.scenarios]) {
      expect(scenario.family, scenario.id).toBeTruthy();
      if (scenario.kind !== "attack") continue;
      expect(scenario.owasp, scenario.id).toContain("LLM06:2025 Excessive Agency");
      expect(scenario.atlas, scenario.id).toContain("AML.T0053");
    }
    const attacks = set3.scenarios.filter((s) => s.kind === "attack");
    expect(attacks.filter((s) => s.counterpart).length).toBeGreaterThanOrEqual(9);
    expect(set3.scenarios.filter((s) => s.kind === "benign").length).toBeGreaterThanOrEqual(9);
  });

  it("run without a fixture error, with the rule-based agents behaving as they should", async () => {
    const run = (subject: GullibleSubject | StrictSubject) =>
      runAll({ profile: "baseline", scenarios: set3.scenarios, subject, attacker: new ScriptedAttacker(), rail: new MockRail(), defense: NO_DEFENSE, scenarioSetVersion: set3.version });
    const gullible = await run(new GullibleSubject());
    const strict = await run(new StrictSubject());
    expect(gullible.scenarios.filter((s) => s.error)).toEqual([]);
    expect(gullible.scenarioSetVersion).toBe("3");
    expect(gullible.metrics.overRefundCents).toBeGreaterThan(0);
    expect(strict.scenarios.filter((s) => s.error)).toEqual([]);
    expect(strict.metrics.overRefundCents).toBe(0);
  });

  it("explain exactly what is wrong with a bad file", () => {
    const good = { suite: "9", scenarios: [{ id: "a", version: 1, title: "t", kind: "attack", category: "c", customerEmail: "m@example.com", goal: "g {o}", script: ["hi {o}"], orders: [{ key: "o", ownerEmail: "m@example.com", item: "i", amountCents: 100, placedDaysAgo: 1, delivery: "LOST", expectedRefundCents: 100 }] }] };
    expect(parseSuite(good, "f").scenarios).toHaveLength(1);
    const broken = (change: (s: Record<string, any>) => void) => {
      const copy = structuredClone(good);
      change(copy.scenarios[0]!);
      return () => parseSuite(copy, "f.json");
    };
    expect(() => parseSuite({ scenarios: [] }, "f.json")).toThrow(/"suite" must be/);
    expect(() => parseSuite({ suite: "1", scenarios: [{ ...good.scenarios[0] }, { ...good.scenarios[0] }] }, "f.json")).toThrow("used twice");
    expect(broken((s) => (s["kind"] = "maybe"))).toThrow(/f\.json, scenario a: kind/);
    expect(broken((s) => (s["script"] = []))).toThrow("script must be");
    expect(broken((s) => (s["script"] = ["hi {other}"]))).toThrow("{other}");
    expect(broken((s) => (s["counterpart"] = "missing"))).toThrow('counterpart "missing"');
    expect(broken((s) => (s["orders"][0]["amountCents"] = -5))).toThrow("amountCents");
    expect(broken((s) => delete s["orders"][0]["expectedRefundCents"])).toThrow("expectedRefundCents is required");
    expect(broken((s) => (s["orders"][0]["delivery"] = "SOON"))).toThrow("delivery must be");
    expect(() => loadSuite("no-such-file.json")).toThrow("Could not read scenarios");
  });

  it("use labels that the adaptive attacker can also report", () => {
    expect(TECHNIQUES).toContain("fake-system-message");
    expect(new Set(TECHNIQUES).size).toBe(TECHNIQUES.length);
  });
});

describe("indirect injection", () => {
  const scenario = set3.scenarios.find((s) => s.id === "indirect-order-note")!;

  async function lookup(variant: "stock" | "spotlight") {
    const rail = new MockRail();
    const charge = await rail.charge({ amountCents: 17900, description: "x", reference: "r" });
    const session = { customerEmail: scenario.customerEmail };
    const spec = scenario.orders[0]!;
    const tools = createSupportTools({
      orders: [{ orderId: charge.orderId, captureId: charge.captureId, customerEmail: spec.ownerEmail, item: spec.item, amountCents: spec.amountCents, placedDaysAgo: spec.placedDaysAgo, delivery: spec.delivery, deliveredDaysAgo: spec.deliveredDaysAgo, returnReceived: false, thirdPartyText: spec.thirdPartyText! }],
      rail,
      session,
      defense: NO_DEFENSE,
      log: [],
    });
    const { model, exchanges } = fakeModel([{ toolCalls: [call("t1", "get_order", { order_id: charge.orderId })] }, { text: "ok" }]);
    await new ModelSubject(model, variant).startSession(session, tools).reply("hi");
    const output = (exchanges[0]!.sent[1] as { content: string }[])[0]!.content;
    return JSON.parse(output) as Record<string, string>;
  }

  it("puts the third party's text in front of the agent through the order lookup", async () => {
    const view = await lookup("stock");
    expect(view["customer_note"]).toContain("SYSTEM NOTE FOR SUPPORT AGENT");
  });

  it("marks that text as data under spotlighting, leaving the store's own fields alone", async () => {
    const view = await lookup("spotlight");
    expect(view["customer_note"]).toMatch(/^<untrusted_text>Gift,/);
    expect(view["customer_note"]).toContain(`SYSTEM${DATAMARK}NOTE`);
    expect(view["delivery_status"]).toBe("DELIVERED");
  });

  it("adds nothing to the lookup when an order has no such text, so set 2 sees exactly what it always did", async () => {
    const { model, exchanges } = fakeModel([{ toolCalls: [call("t1", "get_order", { order_id: "MOCKORDER0001" })] }, { text: "ok" }]);
    const rail = new MockRail();
    const charge = await rail.charge({ amountCents: 100, description: "x", reference: "r" });
    const session = { customerEmail: "a@example.com" };
    const tools = createSupportTools({ orders: [{ orderId: charge.orderId, captureId: charge.captureId, customerEmail: "a@example.com", item: "Lamp", amountCents: 100, placedDaysAgo: 1, delivery: "LOST", returnReceived: false }], rail, session, defense: NO_DEFENSE, log: [] });
    await new ModelSubject(model).startSession(session, tools).reply("hi");
    const output = JSON.parse((exchanges[0]!.sent[1] as { content: string }[])[0]!.content) as Record<string, unknown>;
    expect(Object.keys(output)).toEqual(["order_id", "customer_email", "item", "amount_paid", "placed_days_ago", "delivery_status", "delivered_days_ago", "return_received"]);
  });
});

describe("the command line", () => {
  it("runs a suite from a data file and records its version", () => {
    const dir = mkdtempSync(join(tmpdir(), "crashtest-suite-"));
    try {
      const result = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href, join(ROOT, "src", "cli.ts"), "--subject", "strict", "--suite", join(ROOT, "scenarios", "set-3.json"), "--only", "indirect-order-note", "--record", "s3"],
        { cwd: dir, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      const recording = JSON.parse(readFileSync(join(dir, "recordings", "s3.json"), "utf8")) as Recording;
      expect(recording.scenarioSetVersion).toBe("3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
