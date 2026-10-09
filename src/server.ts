import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import { SCENARIOS } from "./attacks/scenarios";
import { createAttacker, createRail, createSubject, harnessVersion, keyStatus, loadEnv } from "./config";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const hosted = process.env["CRASHTEST_PUBLIC"] === "1";

// A hosted copy holds no keys, so it does not read .env at all.
if (!hosted) loadEnv();

const handle = createApp({
  hosted,
  publicDir: join(ROOT, "public"),
  gridScript: join(ROOT, "node_modules", "ag-grid-community", "dist", "ag-grid-community.min.js"),
  recordingDirs: hosted
    ? [{ source: "featured", dir: join(ROOT, "recordings") }]
    : [
        { source: "featured", dir: join(ROOT, "recordings") },
        { source: "local", dir: join(ROOT, "runs") },
      ],
  localRunsDir: join(ROOT, "runs"),
  harnessVersion: harnessVersion(),
  scenarios: SCENARIOS,
  keyStatus,
  createRail,
  createSubject,
  createAttacker,
});

const port = Number(process.env["PORT"] ?? 4173);
// Local only by default: anyone who can reach this page can start a run.
const host = process.env["HOST"] ?? "127.0.0.1";

createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    console.error(error);
    if (!response.headersSent) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Server error" }));
    } else {
      response.end();
    }
  });
}).listen(port, host, () => {
  console.log(`Crashtest dashboard${hosted ? " (hosted mode)" : ""}: http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
});
