import { createHash } from "node:crypto";

/** Token use and time, summed over a model's requests. */
export interface Usage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens the provider says it served from its cache. Zero where it does not say. */
  cachedTokens: number;
  /** Time spent on requests that succeeded. Waits for rate limits are not included. */
  latencyMs: number;
}

export const emptyUsage = (): Usage => ({ requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, latencyMs: 0 });

/** What was used between two readings of the same running total. */
export function usageSince(before: Usage, after: Usage): Usage {
  return {
    requests: after.requests - before.requests,
    promptTokens: after.promptTokens - before.promptTokens,
    completionTokens: after.completionTokens - before.completionTokens,
    cachedTokens: after.cachedTokens - before.cachedTokens,
    latencyMs: after.latencyMs - before.latencyMs,
  };
}

/** A model as pinned for a run, plus what the provider reported actually serving. */
export interface ModelManifest {
  provider: string;
  /** The model id that was asked for. */
  model: string;
  /** Sent with every request. Absent means the provider's default was used, unpinned. */
  temperature?: number;
  /** Model ids the provider reported answering with, in the order first seen. */
  served: string[];
  /** Build fingerprints the provider reported, where it reports them. */
  fingerprints: string[];
}

/**
 * Exactly what played a part in a run: the agent under test or the attacker.
 * Two runs with different manifests are different configurations.
 */
export interface ComponentManifest {
  /** "scripted", "model", "toolkit" or "adaptive". */
  kind: string;
  /** For model-backed parts: which prompt variant, for example "stock" or "hardened". */
  promptVariant?: string;
  /** SHA-256 of the system prompt, with the signed-in customer left as a placeholder. */
  systemPromptSha256?: string;
  /** SHA-256 of the tool definitions the model was given. */
  toolsSha256?: string;
  /** The adaptive attacker's turn limit. */
  maxTurns?: number;
  model?: ModelManifest;
}

/** The parts of a manifest that are fixed before a run starts, for checking that two runs match. */
export function fixedPart(manifest: ComponentManifest | undefined): ComponentManifest | undefined {
  if (!manifest?.model) return manifest;
  const { served: _served, fingerprints: _fingerprints, ...model } = manifest.model;
  return { ...manifest, model: { ...model, served: [], fingerprints: [] } };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The seed for one conversation, derived from the run's seed so that every
 * conversation gets its own and a re-run with the same run seed asks for the
 * same ones. Providers treat seeds as best effort, so this aids
 * reproducibility; it does not guarantee it.
 */
export function conversationSeed(runSeed: number, scenarioId: string, trial: number, role: string): number {
  return createHash("sha256").update(`${runSeed}:${scenarioId}:${trial}:${role}`).digest().readUInt32BE(0) & 0x7fffffff;
}

/** A fresh run seed when none is given. Recorded, so the run can be asked for again. */
export function newRunSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}
