import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Turn } from "./attacks/attacker";
import { fixedPart, newRunSeed, type ComponentManifest } from "./manifest";
import { RECORDING_SCHEMA, type Recording, type RunEvent, type Sitting } from "./recording";
import type { RunSettings, ScenarioResult } from "./runner";
import type { ToolCallRecord } from "./subject/tools";

/**
 * What must be the same for earlier scenario runs to be kept and added to
 * instead of run again. The number of trials is left out on purpose: a run can
 * be continued with more trials than it was started with.
 */
export interface RunIdentity extends Pick<RunSettings, "profile" | "subject" | "attacker" | "defense" | "policyVersion" | "scenarioSetVersion"> {
  harnessVersion: string;
  scenarioIds: string[];
  /** The fixed parts of the agent's and attacker's manifests: prompts, tools, model and temperature. */
  agentSpec?: ComponentManifest;
  attackerSpec?: ComponentManifest;
}

/** A run in progress on disk: the same events a recording holds, without a final summary. */
interface ProgressFile {
  schema: number;
  identity: RunIdentity;
  seed: number;
  startedAt: string;
  sittings: Sitting[];
  events: RunEvent[];
}

/**
 * Rebuilds every finished scenario run from a recording's events, and returns
 * the events that belong to them. The closing summary and the events of a
 * scenario that never finished are left out.
 */
export function resultsFromEvents(events: RunEvent[]): { results: ScenarioResult[]; events: RunEvent[] } {
  const results: ScenarioResult[] = [];
  const kept: RunEvent[] = [];
  let open: RunEvent[] = [];
  let transcript: Turn[] = [];
  let toolCalls: ToolCallRecord[] = [];
  let customer = "";
  let technique: string | undefined;

  for (const entry of events) {
    if (entry.event === "done") continue;
    if (entry.event === "scenario-start") {
      open = [];
      transcript = [];
      toolCalls = [];
    }
    open.push(entry);
    if (entry.event === "customer") {
      ({ message: customer, technique } = entry.data as { message: string; technique?: string });
    } else if (entry.event === "agent") {
      transcript.push({ customer, agent: (entry.data as { message: string }).message, ...(technique === undefined ? {} : { technique }) });
    } else if (entry.event === "tool") {
      toolCalls.push((entry.data as { call: ToolCallRecord }).call);
    } else if (entry.event === "scenario") {
      results.push({ ...(entry.data as Omit<ScenarioResult, "transcript" | "toolCalls">), transcript, toolCalls });
      kept.push(...open);
      open = [];
    }
  }
  return { results, events: kept };
}

/** The identity a finished recording was made under, for checking that it can be added to. */
export function identityOf(recording: Recording): RunIdentity {
  const firstTrial = recording.events.filter((entry) => entry.event === "scenario-start" && (entry.data as { trial: number }).trial === 1);
  return {
    profile: recording.profile,
    subject: recording.subject,
    attacker: recording.attacker,
    defense: recording.defense,
    policyVersion: recording.policyVersion,
    scenarioSetVersion: recording.scenarioSetVersion,
    harnessVersion: recording.harnessVersion,
    scenarioIds: firstTrial.map((entry) => (entry.data as { id: string }).id),
    ...specs(recording.manifest?.agent, recording.manifest?.attacker),
  };
}

/** The identity fields for an agent and attacker manifest, left out entirely when there is none. */
export function specs(agent: ComponentManifest | undefined, attacker: ComponentManifest | undefined): Pick<RunIdentity, "agentSpec" | "attackerSpec"> {
  const agentSpec = fixedPart(agent);
  const attackerSpec = fixedPart(attacker);
  return { ...(agentSpec ? { agentSpec } : {}), ...(attackerSpec ? { attackerSpec } : {}) };
}

function differences(a: RunIdentity, b: RunIdentity): string[] {
  const keys = Object.keys({ ...a, ...b }) as (keyof RunIdentity)[];
  return keys.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

export interface Progress {
  /** The run's seed: the one it started with, when it is being continued. */
  seed: number;
  /** When the run first started, across every sitting. */
  startedAt: string;
  /** Events of the scenario runs already finished. New events are appended to this array. */
  events: RunEvent[];
  /** The scenario runs already finished, rebuilt from those events. */
  results: ScenarioResult[];
  /** Call when a scenario run finishes: writes everything so far to disk. */
  save(): void;
  /** Every stretch of work on this run, including the current one once it has finished a scenario. */
  sittings(): Sitting[];
  /** Call when the run is complete and saved as a recording. */
  clear(): void;
}

/**
 * Opens the progress of a recorded run, so a long run on a rate-limited free
 * tier survives being stopped. With an unfinished run of the same settings on
 * disk, it continues that. Otherwise it starts from `startFrom` when given (a
 * finished recording to add trials to), or from nothing.
 *
 * Settings that differ are refused: results from two configurations must
 * never be mixed into one run.
 */
export function openProgress(
  path: string,
  identity: RunIdentity,
  options: { startFrom?: Recording; seed?: number; now?: () => Date } = {},
): Progress {
  const { startFrom } = options;
  const now = options.now ?? (() => new Date());
  let startedAt = now().toISOString();
  let seed: number | undefined;
  let earlierSittings: Sitting[] = [];
  let earlierEvents: RunEvent[] = [];

  if (existsSync(path)) {
    const file = JSON.parse(readFileSync(path, "utf8")) as Partial<ProgressFile>;
    if (file.schema !== RECORDING_SCHEMA || !file.identity || !Array.isArray(file.events) || !file.startedAt) {
      throw new Error(`${path} is not an unfinished run this version can continue. Delete it to start again.`);
    }
    const changed = differences(file.identity, identity);
    if (changed.length > 0) {
      throw new Error(
        `${path} holds an unfinished run made with different settings (${changed.join(", ")}). Delete it to start again, or use another --record name.`,
      );
    }
    startedAt = file.startedAt;
    seed = file.seed;
    earlierSittings = file.sittings ?? [];
    earlierEvents = file.events;
  } else if (startFrom) {
    const changed = differences(identityOf(startFrom), identity);
    if (changed.length > 0) {
      throw new Error(`The saved recording was made with different settings (${changed.join(", ")}), so trials cannot be added to it.`);
    }
    startedAt = startFrom.startedAt;
    seed = startFrom.seed;
    earlierEvents = startFrom.events;
    earlierSittings = startFrom.sittings ?? [
      { startedAt: startFrom.startedAt, finishedAt: startFrom.finishedAt, scenarioRuns: resultsFromEvents(startFrom.events).results.length },
    ];
  }

  if (seed !== undefined && options.seed !== undefined && seed !== options.seed) {
    throw new Error(`This run was started with seed ${seed}; it cannot be continued with seed ${options.seed}.`);
  }
  const runSeed = seed ?? options.seed ?? newRunSeed();
  const { results, events } = resultsFromEvents(earlierEvents);
  const sitting: Sitting = { startedAt: now().toISOString(), finishedAt: now().toISOString(), scenarioRuns: 0 };
  const sittings = () => (sitting.scenarioRuns > 0 ? [...earlierSittings, sitting] : earlierSittings);

  return {
    seed: runSeed,
    startedAt,
    events,
    results,
    sittings,
    save() {
      sitting.scenarioRuns += 1;
      sitting.finishedAt = now().toISOString();
      const file: ProgressFile = { schema: RECORDING_SCHEMA, identity, seed: runSeed, startedAt, sittings: sittings(), events };
      mkdirSync(dirname(path), { recursive: true });
      // Written beside the real file and then renamed, so being stopped mid-write cannot leave half a file.
      writeFileSync(`${path}.tmp`, JSON.stringify(file));
      renameSync(`${path}.tmp`, path);
    },
    clear() {
      rmSync(path, { force: true });
    },
  };
}
