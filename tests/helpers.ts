import type { ChatModel, ToolOutput, ToolSpec, Turn } from "../src/llm/model";
import { MockRail, type MockRailOptions } from "../src/rail/mock";
import type { PaymentRail, RefundResult } from "../src/rail/rail";
import type { StoreOrder } from "../src/store/policy";
import type { Subject } from "../src/subject/subject";
import { createSupportTools, type Defense, type SupportTools, type ToolCallRecord } from "../src/subject/tools";

export interface Exchange {
  system: string;
  tools: ToolSpec[];
  /** What the model was sent, in order: user text or tool outputs. */
  sent: (string | ToolOutput[])[];
}

/** A scripted model: replies with the given turns in order and records what it was sent. */
export function fakeModel(turns: Partial<Turn>[]) {
  const exchanges: Exchange[] = [];
  const next = (): Turn => {
    const turn = turns.shift();
    if (!turn) throw new Error("Unexpected model request");
    return { text: "", toolCalls: [], refused: false, ...turn };
  };
  const model: ChatModel = {
    label: "fake model",
    start(system, tools) {
      const exchange: Exchange = { system, tools, sent: [] };
      exchanges.push(exchange);
      return {
        async say(text) {
          exchange.sent.push(text);
          return next();
        },
        async answerTools(outputs) {
          exchange.sent.push(outputs);
          return next();
        },
      };
    },
  };
  return { model, exchanges };
}

export const call = (id: string, name: string, input: Record<string, unknown> | null) => ({ id, name, input });

export const NO_DEFENSE: Defense = { enforcePolicy: false };
export const POLICY_DEFENSE: Defense = { enforcePolicy: true };

/** Wraps a rail and records every refund request that actually reaches it. */
export function spyRail(inner: PaymentRail, overrides: Partial<Pick<PaymentRail, "external" | "name">> = {}) {
  const refundRequests: { captureId: string; amountCents: number; idempotencyKey: string }[] = [];
  const rail: PaymentRail = {
    name: overrides.name ?? inner.name,
    external: overrides.external ?? inner.external,
    charge: (input) => inner.charge(input),
    refunds: (orderId) => inner.refunds(orderId),
    async refund(input): Promise<RefundResult> {
      refundRequests.push({ captureId: input.captureId, amountCents: input.amountCents, idempotencyKey: input.idempotencyKey });
      return inner.refund(input);
    },
  };
  return { rail, refundRequests };
}

/** One paid order plus the refund boundary around it. */
export async function orderWithTools(options: {
  order?: Partial<StoreOrder>;
  defense?: Defense;
  customerEmail?: string;
  rail?: PaymentRail;
  railOptions?: MockRailOptions;
}) {
  const rail = options.rail ?? new MockRail(options.railOptions);
  const amountCents = options.order?.amountCents ?? 12900;
  const charge = await rail.charge({ amountCents, description: "Item", reference: "r" });
  const order: StoreOrder = {
    orderId: charge.orderId,
    captureId: charge.captureId,
    customerEmail: "maya@example.com",
    item: "Item",
    amountCents,
    placedDaysAgo: 8,
    delivery: "DELIVERED",
    deliveredDaysAgo: 3,
    returnReceived: false,
    ...options.order,
  };
  const log: ToolCallRecord[] = [];
  const session = { customerEmail: options.customerEmail ?? "maya@example.com" };
  const tools = createSupportTools({ orders: [order], rail, session, defense: options.defense ?? NO_DEFENSE, log });
  return { rail, order, log, session, tools };
}

/** A subject that performs a fixed list of refund requests on the first message, whatever it says. */
export function scriptedRefunds(steps: (tools: SupportTools) => Promise<unknown>): Subject {
  return {
    name: "scripted refunds",
    startSession(_context, tools) {
      let done = false;
      return {
        async reply() {
          if (!done) {
            done = true;
            await steps(tools);
          }
          return "ok";
        },
      };
    },
  };
}
