import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app";
import { ScriptedAttacker } from "../src/attacks/attacker";
import { CORE_SCENARIO_IDS, SCENARIOS as ALL_SCENARIOS } from "../src/attacks/scenarios";
import { planRun } from "../src/profiles";
import { MockRail } from "../src/rail/mock";
import { GullibleSubject, RefuseAllSubject, StrictSubject } from "../src/subject/scripted";
import { spyRail } from "./helpers";

const SCENARIOS = ALL_SCENARIOS.filter((s) => CORE_SCENARIO_IDS.includes(s.id));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Starts the real request handler on a free local port, with factories that record what they were asked for. */
async function startApp(overrides: Partial<AppDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crashtest-app-"));
  const made = { rails: [] as string[], subjects: [] as string[], attackers: [] as string[] };
  const refundRequests: unknown[] = [];
  const deps: AppDeps = {
    hosted: false,
    publicDir: join(dir, "public"),
    gridScript: join(dir, "grid.js"),
    recordingDirs: [
      { source: "featured", dir: join(dir, "recordings") },
      { source: "local", dir: join(dir, "runs") },
    ],
    localRunsDir: join(dir, "runs"),
    harnessVersion: "test",
    scenarios: SCENARIOS,
    keyStatus: () => ({ model: true, paypal: true }),
    createRail(kind) {
      made.rails.push(kind);
      // Even the "paypal" rail here is the in-memory one, marked external, so a test can never reach a real provider.
      const spied = spyRail(new MockRail(), kind === "paypal" ? { external: true, name: "paypal-sandbox" } : {});
      refundRequests.push(spied.refundRequests);
      return spied.rail;
    },
    createSubject(kind) {
      made.subjects.push(kind);
      if (kind === "strict") return new StrictSubject();
      if (kind === "refuse-all") return new RefuseAllSubject();
      return new GullibleSubject();
    },
    createAttacker(kind) {
      made.attackers.push(kind);
      return new ScriptedAttacker();
    },
    ...overrides,
  };
  const handle = createApp(deps);
  const server: Server = createServer((request, response) => void handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { base, made, refundRequests: refundRequests as { amountCents: number }[][], dir, deps };
}

/** Reads a server-sent-event response into a list of events. */
async function events(response: Response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const [first, second] = block.split("\n");
      return { event: first!.replace("event: ", ""), data: JSON.parse(second!.replace("data: ", "")) as Record<string, unknown> };
    });
}

const savedRuns = (dir: string) => (existsSync(join(dir, "runs")) ? readdirSync(join(dir, "runs")) : []);

describe("run planning", () => {
  it("ties each profile to one rail and its mandatory defense", () => {
    expect(planRun({}, { hosted: false })).toMatchObject({ profile: { id: "baseline", rail: "mock" }, defense: { enforcePolicy: false } });
    expect(planRun({ profile: "guarded", cap: "50" }, { hosted: false })).toMatchObject({
      profile: { rail: "mock" },
      defense: { enforcePolicy: true, maxRefundCentsPerOrder: 5000 },
    });
    expect(planRun({ profile: "sandbox" }, { hosted: false })).toMatchObject({ profile: { rail: "paypal" }, defense: { enforcePolicy: true } });
    expect(() => planRun({ profile: "live" }, { hosted: false })).toThrow(/Unknown profile/);
    expect(() => planRun({ cap: "lots" }, { hosted: false })).toThrow();
  });

  it("only lets the toolkit agent run in the sandbox profile", () => {
    expect(() => planRun({ subject: "toolkit" }, { hosted: false })).toThrow(/sandbox profile/);
    expect(() => planRun({ subject: "toolkit", profile: "guarded" }, { hosted: false })).toThrow(/sandbox profile/);
    expect(planRun({ subject: "toolkit", profile: "sandbox" }, { hosted: false }).defense.enforcePolicy).toBe(true);
  });

  it("in hosted mode allows only built-in agents, scripted attacks and the test rail", () => {
    const hosted = { hosted: true };
    for (const request of [{ profile: "sandbox" }, { subject: "model" }, { subject: "toolkit", profile: "sandbox" }, { attacker: "adaptive" }]) {
      expect(() => planRun(request, hosted), JSON.stringify(request)).toThrow(/hosted copy/);
    }
    for (const subject of ["gullible", "strict", "refuse-all"]) {
      expect(planRun({ subject, profile: "guarded" }, hosted).profile.rail).toBe("mock");
    }
  });
});

describe("dashboard server", () => {
  it("runs the requested profile and saves the finished run locally", async () => {
    const app = await startApp();
    const stream = await events(await fetch(`${app.base}/api/run?profile=guarded&subject=gullible&attacker=scripted`));
    expect(app.made).toEqual({ rails: ["mock"], subjects: ["gullible"], attackers: ["scripted"] });
    const done = stream.at(-1)!;
    expect(done.event).toBe("done");
    expect(done.data).toMatchObject({ profile: "guarded", defense: { enforcePolicy: true }, metrics: { overRefundCents: 0 } });
    expect(savedRuns(app.dir)).toHaveLength(1);

    const listed = (await (await fetch(`${app.base}/api/recordings`)).json()) as { id: string; runId: string }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]!.runId).toBe(done.data["runId"]);
  });

  it("replays a saved run event for event without creating a rail, an agent or an attacker", async () => {
    const app = await startApp();
    const live = await events(await fetch(`${app.base}/api/run?profile=baseline&subject=gullible`));
    const [{ id }] = (await (await fetch(`${app.base}/api/recordings`)).json()) as [{ id: string }];
    const before = structuredClone(app.made);
    const requestsBefore = app.refundRequests.flat().length;

    const replay = await events(await fetch(`${app.base}/api/replay?id=${encodeURIComponent(id)}`));
    expect(replay).toEqual(live);
    expect(app.made).toEqual(before); // nothing was constructed
    expect(app.refundRequests.flat().length).toBe(requestsBefore); // no refund was sent
    expect(savedRuns(app.dir)).toHaveLength(1); // a replay is not saved as a new run

    expect((await fetch(`${app.base}/api/replay?id=local:../../package`)).status).toBe(404);
  });

  it("in the sandbox profile sends only owed refunds to the provider", async () => {
    const app = await startApp();
    const stream = await events(await fetch(`${app.base}/api/run?profile=sandbox&subject=gullible`));
    expect(app.made.rails).toEqual(["paypal"]);
    expect(stream.at(-1)!.data).toMatchObject({ rail: "paypal-sandbox", defense: { enforcePolicy: true }, metrics: { overRefundCents: 0 } });
    expect(app.refundRequests.flat().map((r) => r.amountCents).sort((a, b) => a - b)).toEqual([3900, 4900, 11900]);
  });

  it("rejects a run started from another website", async () => {
    const app = await startApp();
    const crossSite = await fetch(`${app.base}/api/run?subject=gullible`, { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    const foreignOrigin = await fetch(`${app.base}/api/run?subject=gullible`, { headers: { Origin: "https://evil.example" } });
    expect(foreignOrigin.status).toBe(403);
    expect(app.made.rails).toEqual([]);
    const sameOrigin = await fetch(`${app.base}/api/run?subject=strict`, { headers: { Origin: app.base, "Sec-Fetch-Site": "same-origin" } });
    expect(sameOrigin.status).toBe(200);
    await sameOrigin.text();
  });

  it("only answers GET, and serves nothing outside its public folder", async () => {
    const app = await startApp();
    expect((await fetch(`${app.base}/api/run`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${app.base}/..%2f..%2fpackage.json`)).status).toBe(404);
    expect((await fetch(`${app.base}/%2e%2e/%2e%2e/.env`)).status).toBe(404);
  });
});

describe("what the dashboard is told", () => {
  it("lists every scenario a recording might mention, with its family, and serves the chart only when there is one", async () => {
    const custom = { ...SCENARIOS[0]!, id: "from-a-data-file", family: "indirect-injection" };
    const dir = mkdtempSync(join(tmpdir(), "crashtest-chart-"));
    const chart = join(dir, "frontier.svg");
    writeFileSync(chart, "<svg xmlns='http://www.w3.org/2000/svg'/>");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const app = await startApp({ catalogue: [custom], frontierChart: chart });
    const options = (await (await fetch(`${app.base}/api/options`)).json()) as { catalogue: { id: string; family: string }[] };
    expect(options.catalogue).toEqual([expect.objectContaining({ id: "from-a-data-file", family: "indirect-injection" })]);
    const served = await fetch(`${app.base}/frontier.svg`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("image/svg+xml");

    const none = await startApp();
    expect((await fetch(`${none.base}/frontier.svg`)).status).toBe(404);
  });
});

describe("hosted mode", () => {
  it("never reports which keys exist, even when they do", async () => {
    const app = await startApp({ hosted: true });
    const options = (await (await fetch(`${app.base}/api/options`)).json()) as Record<string, { id: string; available: boolean }[]> & { hosted: boolean };
    expect(options.hosted).toBe(true);
    const available = (list: { id: string; available: boolean }[]) => list.filter((item) => item.available).map((item) => item.id);
    expect(available(options["profiles"]!)).toEqual(["baseline", "guarded"]);
    expect(available(options["subjects"]!)).toEqual(["gullible", "strict", "refuse-all"]);
    expect(available(options["attackers"]!)).toEqual(["scripted"]);
  });

  it("says which version and commit it is running, and leaves the commit out when the host gives none", async () => {
    const build = async (overrides: Partial<AppDeps>) => {
      const app = await startApp({ hosted: true, ...overrides });
      return ((await (await fetch(`${app.base}/api/options`)).json()) as { build: unknown }).build;
    };
    expect(await build({ commit: "400abce" })).toEqual({ version: "test", commit: "400abce" });
    expect(await build({})).toEqual({ version: "test" });
  });

  it("refuses every request that would need a key or a real provider, before creating anything", async () => {
    const app = await startApp({ hosted: true });
    for (const query of ["profile=sandbox", "subject=model", "subject=toolkit&profile=sandbox", "attacker=adaptive", "profile=sandbox&subject=gullible&attacker=scripted"]) {
      const stream = await events(await fetch(`${app.base}/api/run?${query}`));
      expect(stream, query).toHaveLength(1);
      expect(stream[0]!.event).toBe("failed");
    }
    expect(app.made).toEqual({ rails: [], subjects: [], attackers: [] });
  });

  it("runs the built-in agents on the test rail only, and writes nothing to disk", async () => {
    const app = await startApp({ hosted: true });
    const stream = await events(await fetch(`${app.base}/api/run?profile=baseline&subject=gullible`));
    expect(stream.at(-1)!.event).toBe("done");
    expect(app.made.rails).toEqual(["mock"]);
    expect(savedRuns(app.dir)).toEqual([]);
  });
});
