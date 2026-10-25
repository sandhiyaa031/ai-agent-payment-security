/** Provider-neutral shapes, so any tool-calling model can be the agent or the attacker. */

import type { ModelManifest, Usage } from "../manifest";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
  /** Ask the provider to enforce the schema exactly, where it can. */
  strict?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  /** null when the model produced arguments that were not valid JSON. */
  input: Record<string, unknown> | null;
}

export interface ToolOutput {
  id: string;
  content: string;
  isError: boolean;
}

export interface Turn {
  text: string;
  toolCalls: ToolCall[];
  /** The provider declined to answer on safety grounds. */
  refused: boolean;
}

/** One running exchange with a model; it keeps its own history. */
export interface Conversation {
  say(text: string): Promise<Turn>;
  answerTools(outputs: ToolOutput[]): Promise<Turn>;
}

export interface ChatModel {
  /** Shown in reports, for example "groq openai/gpt-oss-120b". */
  readonly label: string;
  /** `seed` asks the provider to sample reproducibly for this conversation, where it supports that. */
  start(system: string, tools: ToolSpec[], options?: { seed?: number }): Conversation;
  /** Running totals since the model was created. Absent on stand-ins that do not track them. */
  usage?(): Usage;
  /** The pinned settings and what the provider reported serving. */
  manifest?(): ModelManifest;
}
