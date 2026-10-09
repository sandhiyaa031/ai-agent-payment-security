import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./attacks/scenarios";
import { checkCombination, createAttacker, createRail, createSubject, keyStatus, loadEnv } from "./config";
import { toCents } from "./money";
import { capAnalysis, totals } from "./report";
import { runAll } from "./runner";
import type { Guard } from "./subject/tools";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(ROOT, "public");
const GRID_SCRIPT = join(ROOT, "node_modules", "ag-grid-community", "dist", "ag-grid-community.min.js");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const REPLAY_CAPS = [2500, 5000, 10000, 20000, null];

/** A run moves sandbox money and may spend model credits, so only one at a time. */
let running = false;

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

function options() {
  const keys = keyStatus();
  return {
    subjects: [
      { id: "gullible", label: "Gullible baseline", available: true },
      { id: "strict", label: "Strict baseline", available: true },
      { id: "claude", label: "Claude agent", available: keys.model, needs: "an Anthropic API key" },
      {
        id: "toolkit",
        label: "Claude on PayPal Agent Toolkit",
        available: keys.model && keys.paypal,
        needs: "Anthropic and PayPal sandbox keys",
      },
    ],
    attackers: [
      { id: "scripted", label: "Scripted attacks", available: true },
      { id: "adaptive", label: "Adaptive attacker", available: keys.model, needs: "an Anthropic API key" },
    ],
    rails: [
      { id: "mock", label: "Built-in test rail", available: true },
      { id: "paypal", label: "PayPal sandbox", available: keys.paypal, needs: "PayPal sandbox keys" },
    ],
    scenarios: SCENARIOS.map(({ id, title, kind, category }) => ({ id, title, kind, category })),
  };
}

async function streamRun(url: URL, response: ServerResponse): Promise<void> {
  if (running) {
    sendJson(response, 409, { error: "A run is already in progress." });
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: string, data: unknown) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  running = true;
  try {
    const guard: Guard = {};
    const cap = url.searchParams.get("cap")?.trim();
    if (cap) guard.maxRefundCentsPerCall = toCents(cap);
    if (url.searchParams.get("enforcePolicy") === "true") guard.enforcePolicy = true;

    const subject = url.searchParams.get("subject") ?? "gullible";
    const rail = url.searchParams.get("rail") ?? "mock";
    checkCombination(subject, rail);

    const run = await runAll({
      scenarios: SCENARIOS,
      subject: createSubject(subject),
      attacker: createAttacker(url.searchParams.get("attacker") ?? "scripted"),
      rail: createRail(rail),
      guard,
      hooks: {
        onScenarioStart: (scenario) => send("scenario-start", { id: scenario.id }),
        onCustomerMessage: (id, message) => send("customer", { id, message }),
        onToolCall: (id, call) => send("tool", { id, call }),
        onAgentReply: (id, message) => send("agent", { id, message }),
        onScenario: ({ transcript: _transcript, toolCalls: _toolCalls, ...summary }) => send("scenario", summary),
      },
    });
    send("done", {
      subject: run.subject,
      attacker: run.attacker,
      rail: run.rail,
      totals: totals(run),
      caps: capAnalysis(run, REPLAY_CAPS),
    });
  } catch (error) {
    send("failed", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    running = false;
    response.end();
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  if (url.pathname === "/api/options") return sendJson(response, 200, options());
  if (url.pathname === "/api/run") return streamRun(url, response);
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
  console.log(`Crashtest dashboard: http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
});
