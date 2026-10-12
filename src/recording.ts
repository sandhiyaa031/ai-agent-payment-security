import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scenarioStats, type Metrics, type ScenarioStats } from "./metrics";
import { capAnalysis, REPLAY_CAPS, type CapRow } from "./report";
import type { RunHooks, RunResult, RunSettings } from "./runner";

/** One step of a run, in the shape the dashboard consumes live or on replay. */
export interface RunEvent {
  event: string;
  data: unknown;
}

/** Bump when the shape of a recording changes. Files with another version are not listed. */
export const RECORDING_SCHEMA = 3;

/**
 * A finished run as evidence: the settings it ran under, every message, every
 * refund attempt with its outcome and refund id, what the rail reported for
 * each order, and the metrics computed from that.
 *
 * It holds nothing from .env. No key, token or card detail is ever placed in
 * an event, so there is nothing to strip out afterwards.
 */
/** One uninterrupted stretch of work on a run. A run that was stopped and continued, or had trials added later, has several. */
export interface Sitting {
  startedAt: string;
  finishedAt: string;
  /** Scenario runs finished in this sitting. */
  scenarioRuns: number;
}

export interface Recording extends RunSettings {
  schema: number;
  runId: string;
  startedAt: string;
  finishedAt: string;
  savedAt: string;
  harnessVersion: string;
  /** Present on runs recorded from the command line. More than one entry means the trials were not all run in one go. */
  sittings?: Sitting[];
  metrics: Metrics;
  events: RunEvent[];
}

export interface RecordingSummary extends Omit<Recording, "events"> {
  id: string;
  /** "featured" recordings ship with the repository; "local" ones are this machine's own runs. */
  source: string;
}

export interface RecordingDir {
  source: string;
  dir: string;
}

/** Turns runner callbacks into dashboard events. */
export function eventHooks(emit: (event: RunEvent) => void): RunHooks {
  return {
    onScenarioStart: (scenario, trial) => emit({ event: "scenario-start", data: { id: scenario.id, trial } }),
    onCustomerMessage: (id, message) => emit({ event: "customer", data: { id, message } }),
    onToolCall: (id, call) => emit({ event: "tool", data: { id, call } }),
    onAgentReply: (id, message) => emit({ event: "agent", data: { id, message } }),
    // The conversation already travelled as its own events, so the summary leaves it out.
    onScenario: ({ transcript: _transcript, toolCalls: _toolCalls, ...summary }) => emit({ event: "scenario", data: summary }),
  };
}

export interface DoneData extends RunSettings {
  runId: string;
  startedAt: string;
  finishedAt: string;
  metrics: Metrics;
  byScenario: ScenarioStats[];
  caps: CapRow[];
}

export function doneEvent(run: RunResult): { event: "done"; data: DoneData } {
  const { scenarios: _scenarios, ...rest } = run;
  return { event: "done", data: { ...rest, byScenario: scenarioStats(run.scenarios), caps: capAnalysis(run, REPLAY_CAPS) } };
}

export function toRecording(run: RunResult, events: RunEvent[], savedAt: Date, harnessVersion: string, sittings?: Sitting[]): Recording {
  const { scenarios: _scenarios, ...rest } = run;
  return {
    schema: RECORDING_SCHEMA,
    ...rest,
    savedAt: savedAt.toISOString(),
    harnessVersion,
    ...(sittings ? { sittings } : {}),
    events,
  };
}

/** The file name a recording is saved under: a-z, 0-9 and dashes only. */
export function recordingSlug(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error(`"${name}" is not a usable recording name.`);
  return safe;
}

/** Saves a recording as <name>.json and returns the path. Names are reduced to a-z, 0-9 and dashes. */
export function saveRecording(dir: string, name: string, recording: Recording): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${recordingSlug(name)}.json`);
  writeFileSync(path, JSON.stringify(recording, null, 2));
  return path;
}

/** Reads one recording file. Returns nothing for a missing, unreadable or other-version file. */
export function readRecording(path: string): Recording | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Recording>;
    const usable = parsed.schema === RECORDING_SCHEMA && Array.isArray(parsed.events) && parsed.metrics && parsed.runId;
    return usable ? (parsed as Recording) : undefined;
  } catch {
    return undefined;
  }
}

function files(dirs: RecordingDir[]): { id: string; source: string; path: string }[] {
  return dirs.flatMap(({ source, dir }) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((file) => file.endsWith(".json"))
          .map((file) => ({ id: `${source}:${file.slice(0, -5)}`, source, path: join(dir, file) }))
      : [],
  );
}

export function listRecordings(dirs: RecordingDir[]): RecordingSummary[] {
  const summaries: RecordingSummary[] = [];
  for (const file of files(dirs)) {
    const recording = readRecording(file.path);
    if (!recording) continue;
    const { events: _events, ...rest } = recording;
    summaries.push({ id: file.id, source: file.source, ...rest });
  }
  return summaries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Looks a recording up by the id from the listing, so a request can never name an arbitrary path. */
export function loadRecording(dirs: RecordingDir[], id: string): Recording | undefined {
  const match = files(dirs).find((file) => file.id === id);
  return match ? readRecording(match.path) : undefined;
}
