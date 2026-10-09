import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./attacks/scenarios";
import { checkCombination, createAttacker, createRail, createSubject, keyStatus, loadEnv } from "./config";
import { toCents } from "./money";
import {
  doneEvent,
  eventHooks,
  listRecordings,
  loadRecording,
  saveRecording,
  toRecording,
  type RecordingDir,
  type RunEvent,
} from "./recording";
import { runAll } from "./runner";
import type { Guard } from "./subject/tools";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(ROOT, "public");
const GRID_SCRIPT = join(ROOT, "node_modules", "ag-grid-community", "dist", "ag-grid-community.min.js");
const LOCAL_RUNS_DIR = join(ROOT, "runs");
const RECORDING_DIRS: RecordingDir[] = [
  { source: "featured", dir: join(ROOT, "recordings") },
  { source: "local", dir: LOCAL_RUNS_DIR },
];

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Choices that cost nothing and touch no account; the only ones a hosted copy will run. */
const FREE_CHOICES = { subject: ["gullible", "strict"], attacker: ["scripted"], rail: ["mock"] };

/** A run moves sandbox money and may spend model credits, so only one at a time. */
let running = false;

/**
 * Hosted mode, for a copy anyone on the internet can open: live runs are
 * limited to the free choices, and nothing a visitor does is written to disk.
 */
function hosted(): boolean {
  return process.env["CRASHTEST_PUBLIC"] === "1";
}

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

function options() {
  const keys = hosted() ? { model: false, paypal: false } : keyStatus();
  const modelNeeds = hosted() ? "a private install" : "a model key in .env";
  return {
    hosted: hosted(),
    subjects: [
      { id: "gullible", label: "Gullible baseline", available: true },
      { id: "strict", label: "Strict baseline", available: true },
      { id: "model", label: "AI agent", available: keys.model, needs: modelNeeds },
      {
        id: "toolkit",
        label: "AI agent on PayPal Agent Toolkit",
        available: keys.model && keys.paypal,
        needs: hosted() ? "a private install" : "a model key and PayPal sandbox keys",
      },
    ],
    attackers: [
      { id: "scripted", label: "Scripted attacks", available: true },
      { id: "adaptive", label: "Adaptive attacker", available: keys.model, needs: modelNeeds },
    ],
    rails: [
      { id: "mock", label: "Built-in test rail", available: true },
      { id: "paypal", label: "PayPal sandbox", available: keys.paypal, needs: hosted() ? "a private install" : "PayPal sandbox keys" },
    ],
    scenarios: SCENARIOS.map(({ id, title, kind, category }) => ({ id, title, kind, category })),
  };
}

async function streamRun(url: URL, response: ServerResponse): Promise<void> {
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
    const subject = url.searchParams.get("subject") ?? "gullible";
    const attacker = url.searchParams.get("attacker") ?? "scripted";
    const rail = url.searchParams.get("rail") ?? "mock";
    if (hosted() && !(FREE_CHOICES.subject.includes(subject) && FREE_CHOICES.attacker.includes(attacker) && FREE_CHOICES.rail.includes(rail))) {
      throw new Error("This hosted copy only runs the built-in agents on the test rail. Watch a saved run, or install Crashtest to test a real agent.");
    }
    checkCombination(subject, rail);

    const guard: Guard = {};
    const cap = url.searchParams.get("cap")?.trim();
    if (cap) guard.maxRefundCentsPerCall = toCents(cap);
    if (url.searchParams.get("enforcePolicy") === "true") guard.enforcePolicy = true;

    const run = await runAll({
      scenarios: SCENARIOS,
      subject: createSubject(subject),
      attacker: createAttacker(attacker),
      rail: createRail(rail),
      guard,
      hooks: eventHooks(emit),
    });
    emit(doneEvent(run));

    if (!hosted()) {
      const savedAt = new Date();
      const stamp = savedAt.toISOString().replace(/[:.]/g, "-");
      saveRecording(LOCAL_RUNS_DIR, `${stamp}-${subject}-${rail}`, toRecording(run, events, savedAt));
    }
  } catch (error) {
    send({ event: "failed", data: { message: error instanceof Error ? error.message : String(error) } });
  } finally {
    running = false;
    response.end();
  }
}

function streamReplay(url: URL, response: ServerResponse): void {
  const recording = loadRecording(RECORDING_DIRS, url.searchParams.get("id") ?? "");
  if (!recording) {
    sendJson(response, 404, { error: "No such saved run." });
    return;
  }
  const send = openStream(response);
  for (const event of recording.events) send(event);
  response.end();
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  if (url.pathname === "/api/options") return sendJson(response, 200, options());
  if (url.pathname === "/api/recordings") return sendJson(response, 200, listRecordings(RECORDING_DIRS));
  if (url.pathname === "/api/run") return streamRun(url, response);
  if (url.pathname === "/api/replay") return streamReplay(url, response);
  if (url.pathname === "/vendor/ag-grid.js") return sendFile(response, GRID_SCRIPT);

  const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const target = normalize(join(PUBLIC_DIR, relative));
  if (!target.startsWith(PUBLIC_DIR + sep)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  return sendFile(response, target);
}

loadEnv();
const port = Number(process.env["PORT"] ?? 4173);
// Local only by default: anyone who can reach this page can start a run.
const host = process.env["HOST"] ?? "127.0.0.1";

createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    console.error(error);
    if (!response.headersSent) sendJson(response, 500, { error: "Server error" });
    else response.end();
  });
}).listen(port, host, () => {
  console.log(`Crashtest dashboard${hosted() ? " (hosted mode)" : ""}: http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
});
