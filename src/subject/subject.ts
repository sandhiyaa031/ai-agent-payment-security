import type { ComponentManifest, Usage } from "../manifest";
import type { SessionContext, SupportTools } from "./tools";

/** One conversation between a customer and the agent under test. */
export interface SubjectSession {
  reply(customerMessage: string): Promise<string>;
}

/** An AI support agent being crash-tested. */
export interface Subject {
  readonly name: string;
  /** `seed` is passed on to the model, for agents that have one. */
  startSession(context: SessionContext, tools: SupportTools, options?: { seed?: number }): SubjectSession;
  /** Exactly what is under test: prompt and tool fingerprints and the model's pinned settings. */
  manifest?(): ComponentManifest;
  /** Running totals of the model's token use and time, for agents backed by a model that reports them. */
  usage?(): Usage | undefined;
}

/** Order ids are long runs of capitals and digits on both the mock and PayPal. */
const ORDER_ID = /\b[A-Z0-9]{8,}\b/g;

export function mentionedOrderIds(message: string, tools: SupportTools): string[] {
  const candidates = new Set(message.match(ORDER_ID) ?? []);
  return [...candidates].filter((id) => tools.getOrder(id) !== undefined);
}
