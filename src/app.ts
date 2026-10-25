import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import type { Attacker } from "./attacks/attacker";
import type { Scenario } from "./attacks/scenarios";
import { maxRepeats, planRun, PROFILES } from "./profiles";
import type { PaymentRail } from "./rail/rail";
import { doneEvent, eventHooks, listRecordings, loadRecording, saveRecording, toRecording, type RecordingDir, type RunEvent } from "./recording";
import { runAll } from "./runner";
import type { Subject } from "./subject/subject";

/** Everything the dashboard server needs from outside. Tests pass stand-ins to watch what gets called. */
export interface AppDeps {
  /**
   * Hosted mode, for a copy anyone on the internet can open: live runs are
   * limited to the built-in agents on the test rail, key status is never
   * reported, and nothing a visitor does is written to disk.
   */
  hosted: boolean;
  publicDir: string;
  gridScript: string;
  recordingDirs: RecordingDir[];
  /** Where finished local runs are saved. Not used in hosted mode. */
  localRunsDir: string;
  harnessVersion: string;
  /** Short id of the deployed commit, when the host provides one. */
  commit?: string;
  scenarios: Scenario[];
  keyStatus(): { model: boolean; paypal: boolean };
  createRail(kind: "mock" | "paypal"): PaymentRail;
  createSubject(kind: string): Subject;
  createAttacker(kind: string): Attacker;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function sendFile(response: ServerResponse, path: string): Promise<void> {
  try {
    const data = await readFile(path);
    response.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream" });
    response.end(data);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

function openStream(response: ServerResponse): (event: RunEvent) => void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  return ({ event, data }) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

/**
 * Starting a run can move sandbox money and use model quota, and it is a plain
 * GET so the page can stream it. Without this check, any website open in the
 * same browser could start one by pointing at this server's address.
 */
export function isSameOrigin(request: IncomingMessage): boolean {
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export function createApp(deps: AppDeps): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  /** A run moves sandbox money and may use model quota, so only one at a time. */
  let running = false;

  function options() {
    const keys = deps.hosted ? { model: false, paypal: false } : deps.keyStatus();
    const needsModel = deps.hosted ? "a private install" : "a model key in .env";
    const needsPayPal = deps.hosted ? "a private install" : "PayPal sandbox keys";
    return {
      hosted: deps.hosted,
      build: { version: deps.harnessVersion, ...(deps.commit ? { commit: deps.commit } : {}) },
      maxRepeats: maxRepeats(deps.hosted),
      profiles: [
        { id: "baseline", label: PROFILES.baseline.label, available: true },
        { id: "guarded", label: PROFILES.guarded.label, available: true },
        { id: "sandbox", label: PROFILES.sandbox.label, available: keys.paypal, needs: needsPayPal },
      ],
      subjects: [
        { id: "gullible", label: "Gullible baseline", available: true },
        { id: "strict", label: "Strict baseline", available: true },
        { id: "refuse-all", label: "Refuse-all baseline", available: true },
        { id: "model", label: "AI agent", available: keys.model, needs: needsModel },
        { id: "model-hardened", label: "AI agent, hardened prompt", available: keys.model, needs: needsModel },
        { id: "model-spotlight", label: "AI agent, spotlighting", available: keys.model, needs: needsModel },
        {
          id: "toolkit",
          label: "AI agent on PayPal Agent Toolkit",
          available: keys.model && keys.paypal,
          needs: deps.hosted ? "a private install" : "a model key and PayPal sandbox keys",
        },
      ],
      attackers: [
        { id: "scripted", label: "Scripted attacks", available: true },
        { id: "adaptive", label: "Adaptive attacker", available: keys.model, needs: needsModel },
      ],
      scenarios: deps.scenarios.map(({ id, title, kind, category }) => ({ id, title, kind, category })),
    };
  }

  async function streamRun(url: URL, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isSameOrigin(request)) {
      sendJson(response, 403, { error: "Runs can only be started from the Crashtest page itself." });
      return;
    }
    if (running) {
      sendJson(response, 409, { error: "A run is already in progress." });
      return;
    }

    const send = openStream(response);
    const events: RunEvent[] = [];
    const emit = (event: RunEvent) => {
      events.push(event);
      send(event);
    };

    running = true;
    try {
      const plan = planRun(
        {
          profile: url.searchParams.get("profile"),
          subject: url.searchParams.get("subject"),
          attacker: url.searchParams.get("attacker"),
          cap: url.searchParams.get("cap"),
          repeat: url.searchParams.get("repeat"),
        },
        { hosted: deps.hosted },
      );
      // planRun has already refused this; the second check keeps a hosted copy
      // off any real provider even if the plan logic were to change.
      if (deps.hosted && plan.profile.rail !== "mock") {
        throw new Error("A hosted copy never uses a real payment provider.");
      }

      const run = await runAll({
        profile: plan.profile.id,
        scenarios: deps.scenarios,
        subject: deps.createSubject(plan.subject),
        attacker: deps.createAttacker(plan.attacker),
        rail: deps.createRail(plan.profile.rail),
        defense: plan.defense,
        repeats: plan.repeats,
        hooks: eventHooks(emit),
      });
      emit(doneEvent(run));

      if (!deps.hosted) {
        const savedAt = new Date();
        const stamp = savedAt.toISOString().replace(/[:.]/g, "-");
        saveRecording(deps.localRunsDir, `${stamp}-${plan.subject}-${plan.profile.id}`, toRecording(run, events, savedAt, deps.harnessVersion));
      }
    } catch (error) {
      send({ event: "failed", data: { message: error instanceof Error ? error.message : String(error) } });
    } finally {
      running = false;
      response.end();
    }
  }

  /** Replays stored events. It reads one file and writes to the response; it has no path to a rail or a model. */
  function streamReplay(url: URL, response: ServerResponse): void {
    const recording = loadRecording(deps.recordingDirs, url.searchParams.get("id") ?? "");
    if (!recording) {
      sendJson(response, 404, { error: "No such saved run." });
      return;
    }
    const send = openStream(response);
    for (const event of recording.events) send(event);
    response.end();
  }

  return async function handle(request, response) {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    if (url.pathname === "/api/options") return sendJson(response, 200, options());
    if (url.pathname === "/api/recordings") return sendJson(response, 200, listRecordings(deps.recordingDirs));
    if (url.pathname === "/api/run") return streamRun(url, request, response);
    if (url.pathname === "/api/replay") return streamReplay(url, response);
    if (url.pathname === "/vendor/ag-grid.js") return sendFile(response, deps.gridScript);

    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const target = normalize(join(deps.publicDir, relative));
    if (!target.startsWith(deps.publicDir + sep)) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    return sendFile(response, target);
  };
}
