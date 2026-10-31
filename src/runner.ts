import { randomUUID } from "node:crypto";
import type { Attacker, Turn } from "./attacks/attacker";
import { SCENARIO_SET_VERSION, type OrderSpec, type Scenario } from "./attacks/scenarios";
import { computeMetrics, isUnresolved, scoreOrder, type Metrics, type OrderScore } from "./metrics";
import { conversationSeed, newRunSeed, usageSince, type ComponentManifest, type Usage } from "./manifest";
import type { Cents } from "./money";
import type { ProfileId } from "./profiles";
import type { PaymentRail, RefundRecord } from "./rail/rail";
import { entitledCents, POLICY_VERSION, type StoreOrder } from "./store/policy";
import type { Subject } from "./subject/subject";
import { createSupportTools, type Defense, type ToolCallRecord } from "./subject/tools";

export interface OrderOutcome extends OrderScore {
  orderId: string;
  captureId: string;
  item: string;
  amountCents: Cents;
  /** Every refund the rail reports for this order, with its id and status. */
  refunds: RefundRecord[];
}

export interface ScenarioResult {
  id: string;
  version: number;
  /** Which repetition of the scenario this is, starting at 1. */
  trial: number;
  title: string;
  kind: Scenario["kind"];
  category: string;
  orders: OrderOutcome[];
  transcript: Turn[];
  toolCalls: ToolCallRecord[];
  /** True when the outcome cannot be called final: a pending refund, an unanswered request, or an error. */
  unresolved: boolean;
  /** Set when the scenario stopped early, for example on a model or provider failure. */
  error?: string;
  /** Tokens and model time this conversation used, for parts backed by a model that reports them. */
  usage?: { agent?: Usage; attacker?: Usage };
}

/** The settings a result was produced under. Two runs are comparable only if these match. */
export interface RunSettings {
  profile: ProfileId;
  subject: string;
  attacker: string;
  rail: string;
  defense: Defense;
  /** How many times each scenario was run. Models vary between runs, so one trial is one observation. */
  repeats: number;
  policyVersion: string;
  scenarioSetVersion: string;
}

/** Exactly what ran: see manifest.ts. */
export interface RunManifest {
  agent?: ComponentManifest;
  attacker?: ComponentManifest;
}

export interface RunResult extends RunSettings {
  runId: string;
  /** Every conversation's seed is derived from this one. */
  seed: number;
  manifest: RunManifest;
  startedAt: string;
  finishedAt: string;
  scenarios: ScenarioResult[];
  metrics: Metrics;
}

/** Live progress callbacks. The CLI ignores most; the dashboard streams them. */
export interface RunHooks {
  onScenarioStart?(scenario: Scenario, trial: number): void;
  onCustomerMessage?(scenarioId: string, message: string, technique?: string): void;
  onToolCall?(scenarioId: string, call: ToolCallRecord): void;
  onAgentReply?(scenarioId: string, message: string): void;
  onScenario?(result: ScenarioResult): void;
}

function fill(template: string, ids: Map<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => ids.get(key) ?? whole);
}

async function placeOrder(rail: PaymentRail, scenarioId: string, spec: OrderSpec): Promise<StoreOrder> {
  const charge = await rail.charge({
    amountCents: spec.amountCents,
    description: spec.item,
    reference: `crashtest-${scenarioId}-${spec.key}`,
  });
  return {
    orderId: charge.orderId,
    captureId: charge.captureId,
    customerEmail: spec.ownerEmail,
    item: spec.item,
    amountCents: spec.amountCents,
    placedDaysAgo: spec.placedDaysAgo,
    delivery: spec.delivery,
    deliveredDaysAgo: spec.deliveredDaysAgo,
    returnReceived: spec.returnReceived ?? false,
  };
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runScenario(input: {
  scenario: Scenario;
  subject: Subject;
  attacker: Attacker;
  rail: PaymentRail;
  defense: Defense;
  trial?: number;
  /** The run's seed. Each conversation gets its own, derived from this, the scenario and the trial. */
  seed?: number;
  hooks?: RunHooks;
}): Promise<ScenarioResult> {
  const { scenario, subject, attacker, rail, defense, hooks } = input;
  const trial = input.trial ?? 1;
  const seedFor = (role: string) => (input.seed === undefined ? undefined : conversationSeed(input.seed, scenario.id, trial, role));
  hooks?.onScenarioStart?.(scenario, trial);
  // Runs are one conversation at a time, so the change in each model's totals belongs to this conversation.
  const agentBefore = subject.usage?.();
  const attackerBefore = attacker.usage?.();

  const orders: StoreOrder[] = [];
  const entitled = new Map<string, Cents>();
  const toolCalls: ToolCallRecord[] = [];
  const transcript: Turn[] = [];
  let error: string | undefined;

  try {
    // Every scenario gets fresh payments, so one result can never leak into another.
    const ids = new Map<string, string>();
    for (const spec of scenario.orders) {
      const order = await placeOrder(rail, scenario.id, spec);
      const owed = entitledCents(order, scenario.customerEmail);
      if (owed !== spec.expectedRefundCents) {
        // The hand-written expectation and the policy code disagree: one of them is wrong.
        throw new Error(
          `Scenario ${scenario.id}, order ${spec.key}: the policy code says ${owed} cents are owed but the scenario expects ${spec.expectedRefundCents}.`,
        );
      }
      orders.push(order);
      entitled.set(order.orderId, owed);
      ids.set(spec.key, order.orderId);
    }

    const session = { customerEmail: scenario.customerEmail };
    const tools = createSupportTools({
      orders,
      rail,
      session,
      defense,
      log: toolCalls,
      onCall: (call) => hooks?.onToolCall?.(scenario.id, call),
    });
    const chat = subject.startSession(session, tools, { seed: seedFor("agent") });
    const brief = {
      goal: fill(scenario.goal, ids),
      script: scenario.script.map((line) => fill(line, ids)),
      customerEmail: scenario.customerEmail,
    };

    for (;;) {
      const move = await attacker.next(brief, transcript, { seed: seedFor(`attacker-${transcript.length}`) });
      if (move === null) break;
      hooks?.onCustomerMessage?.(scenario.id, move.message, move.technique);
      const agent = await chat.reply(move.message);
      hooks?.onAgentReply?.(scenario.id, agent);
      transcript.push({ customer: move.message, agent, ...(move.technique === undefined ? {} : { technique: move.technique }) });
    }
  } catch (caught) {
    // A model or provider failure ends this scenario, not the run. It is
    // reported as an error and the scenario is marked unresolved.
    error = describeError(caught);
  }

  // The verdict comes from the rail, never from what the agent said it did.
  // This still runs after an error: money may have moved before it.
  const outcomes: OrderOutcome[] = [];
  for (const order of orders) {
    let refunds: RefundRecord[] = [];
    try {
      refunds = await rail.refunds(order.orderId);
    } catch (caught) {
      error ??= `Could not read refunds for order ${order.orderId}: ${describeError(caught)}`;
    }
    outcomes.push({
      orderId: order.orderId,
      captureId: order.captureId,
      item: order.item,
      amountCents: order.amountCents,
      refunds,
      ...scoreOrder(entitled.get(order.orderId) ?? 0, refunds),
    });
  }

  const agentAfter = subject.usage?.();
  const attackerAfter = attacker.usage?.();
  const usage = {
    ...(agentBefore && agentAfter ? { agent: usageSince(agentBefore, agentAfter) } : {}),
    ...(attackerBefore && attackerAfter ? { attacker: usageSince(attackerBefore, attackerAfter) } : {}),
  };

  const result: ScenarioResult = {
    id: scenario.id,
    version: scenario.version,
    trial,
    title: scenario.title,
    kind: scenario.kind,
    category: scenario.category,
    orders: outcomes,
    transcript,
    toolCalls,
    unresolved: false,
    ...(error === undefined ? {} : { error }),
    ...(usage.agent || usage.attacker ? { usage } : {}),
  };
  result.unresolved = isUnresolved(result);
  hooks?.onScenario?.(result);
  return result;
}

export async function runAll(input: {
  profile: ProfileId;
  scenarios: Scenario[];
  subject: Subject;
  attacker: Attacker;
  rail: PaymentRail;
  defense: Defense;
  /** Times to run each scenario. Defaults to once. */
  repeats?: number;
  hooks?: RunHooks;
  /**
   * Scenario runs already finished under the same settings, from a run that
   * was stopped or is having trials added. They are kept as they are and not
   * run again; hooks do not fire for them.
   */
  resume?: { startedAt: string; results: ScenarioResult[] };
  /** The run's seed. A new one is chosen when absent; either way it is recorded. */
  seed?: number;
}): Promise<RunResult> {
  const startedAt = input.resume?.startedAt ?? new Date().toISOString();
  const seed = input.seed ?? newRunSeed();
  const repeats = input.repeats ?? 1;
  const earlier = new Map((input.resume?.results ?? []).map((result) => [`${result.id}#${result.trial}`, result]));
  const results: ScenarioResult[] = [];
  // Trials are interleaved (all scenarios, then all again) so a provider
  // outage or rate limit partway through does not land on one scenario only.
  for (let trial = 1; trial <= repeats; trial += 1) {
    for (const scenario of input.scenarios) {
      results.push(earlier.get(`${scenario.id}#${trial}`) ?? (await runScenario({ ...input, scenario, trial, seed })));
    }
  }
  const agent = input.subject.manifest?.();
  const attacker = input.attacker.manifest?.();
  return {
    runId: randomUUID(),
    seed,
    manifest: { ...(agent ? { agent } : {}), ...(attacker ? { attacker } : {}) },
    startedAt,
    finishedAt: new Date().toISOString(),
    profile: input.profile,
    subject: input.subject.name,
    attacker: input.attacker.name,
    rail: input.rail.name,
    defense: input.defense,
    repeats,
    policyVersion: POLICY_VERSION,
    scenarioSetVersion: SCENARIO_SET_VERSION,
    scenarios: results,
    metrics: computeMetrics(results),
  };
}
