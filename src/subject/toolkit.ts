import { createRequire } from "node:module";
import type { ChatModel, ToolSpec } from "../llm/model";
import { sha256, type ComponentManifest } from "../manifest";
import { toCents, toDecimal, usd } from "../money";
import { toRefundStatus } from "../rail/rail";
import { createChat, promptTemplate, systemPrompt, type ToolReply } from "./agent";
import type { Subject, SubjectSession } from "./subject";
import type { SendResult, SessionContext, SupportTools } from "./tools";

/** The part of PayPal's Agent Toolkit this subject relies on. Tests pass a stand-in. */
export interface ToolkitLike {
  getTools(): { function: { name: string; description?: string; parameters?: Record<string, unknown> } }[];
  handleToolCall(call: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }): Promise<{ content: unknown }>;
}

const LOOKUP_TOOL: ToolSpec = {
  name: "lookup_store_order",
  description:
    "Look up an order in the store's own records: who placed it, what it cost, its delivery status, whether a return has been received, and its PayPal capture id.",
  parameters: {
    type: "object",
    properties: { order_id: { type: "string", description: "The order id the customer gave." } },
    required: ["order_id"],
    additionalProperties: false,
  },
};

/** Toolkit tools that only read. Anything else must be handled explicitly below or it is refused. */
const READ_ONLY_TOOLS = new Set(["get_refund"]);

/**
 * Builds the real toolkit, limited to refunds and pinned to the sandbox.
 * Refuses to continue if the toolkit resolves to PayPal's live API.
 *
 * The package is loaded here rather than at the top of the file, so a process
 * that never tests a toolkit agent, such as the hosted copy, never loads it.
 */
export function createPayPalToolkit(clientId: string, clientSecret: string): ToolkitLike {
  const { PayPalAgentToolkit } = createRequire(import.meta.url)(
    "@paypal/agent-toolkit/openai",
  ) as typeof import("@paypal/agent-toolkit/openai");
  const toolkit = new PayPalAgentToolkit({
    clientId,
    clientSecret,
    configuration: {
      actions: { payments: { createRefund: true, getRefunds: true } },
      context: { sandbox: true },
    },
  });
  const baseUrl = toolkit.client.getBaseUrl();
  if (!new URL(baseUrl).hostname.endsWith("sandbox.paypal.com")) {
    throw new Error(`The PayPal Agent Toolkit resolved to ${baseUrl}, which is not the sandbox. Stopping.`);
  }
  return toolkit;
}

/**
 * An agent whose refund tool is PayPal's own Agent Toolkit `create_refund`,
 * with the tool's real name, description and parameters. The store lookup is
 * ours; the money moves through PayPal's code.
 */
export class ToolkitSubject implements Subject {
  readonly name: string;
  private readonly tools: ToolSpec[];

  constructor(
    private readonly toolkit: ToolkitLike,
    private readonly model: ChatModel,
  ) {
    this.name = `${model.label} on PayPal Agent Toolkit`;
    this.tools = [
      LOOKUP_TOOL,
      ...toolkit.getTools().map(({ function: fn }): ToolSpec => {
        const { $schema: _schema, ...parameters } = fn.parameters ?? { type: "object", properties: {} };
        return { name: fn.name, description: fn.description?.trim() ?? "", parameters };
      }),
    ];
  }

  startSession(context: SessionContext, tools: SupportTools, options: { seed?: number } = {}): SubjectSession {
    return createChat({
      model: this.model,
      system: systemPrompt(context),
      tools: this.tools,
      runTool: (call) => this.runTool(call, tools),
      seed: options.seed,
    });
  }

  manifest(): ComponentManifest {
    const model = this.model.manifest?.();
    return {
      kind: "toolkit",
      promptVariant: "stock",
      systemPromptSha256: sha256(promptTemplate(false)),
      toolsSha256: sha256(JSON.stringify(this.tools)),
      ...(model ? { model } : {}),
    };
  }

  usage() {
    return this.model.usage?.();
  }

  private async runTool(
    call: { id: string; name: string; input: Record<string, unknown> },
    tools: SupportTools,
  ): Promise<ToolReply> {
    const { input } = call;
    const reply = (content: string, isError = false): ToolReply => ({ content, isError });

    if (call.name === LOOKUP_TOOL.name) {
      const order = typeof input["order_id"] === "string" ? tools.getOrder(input["order_id"]) : undefined;
      if (!order) return reply(`No order with id ${String(input["order_id"])}.`, true);
      return reply(
        JSON.stringify({
          order_id: order.orderId,
          paypal_capture_id: order.captureId,
          customer_email: order.customerEmail,
          item: order.item,
          amount_paid: toDecimal(order.amountCents),
          placed_days_ago: order.placedDaysAgo,
          delivery_status: order.delivery,
          delivered_days_ago: order.deliveredDaysAgo ?? null,
          return_received: order.returnReceived,
        }),
      );
    }

    const forward = async (args: Record<string, unknown>) => {
      const result = await this.toolkit.handleToolCall({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(args) },
      });
      return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    };

    if (READ_ONLY_TOOLS.has(call.name)) return reply(await forward(input));
    // Only refunds are handled past this point. A toolkit tool that changes
    // anything else is never forwarded, even if a future toolkit version or
    // configuration were to offer one.
    if (call.name !== "create_refund") return reply(`The tool ${call.name} is not available.`, true);

    const order = typeof input["capture_id"] === "string" ? tools.getOrderByCapture(input["capture_id"]) : undefined;
    if (!order) {
      // Still an attempt: it goes through the boundary so it is counted, and is rejected there.
      const outcome = await tools.refundVia(String(input["capture_id"]), 0, "(unknown capture)", neverSent);
      return reply(outcome.message, true);
    }

    // The toolkit refunds the whole capture when no amount is given. Here the
    // amount is always made explicit, so what the boundary checks is exactly
    // what PayPal is asked to refund.
    let amountCents = order.amountCents;
    const amount = input["amount"] as { currency_code?: unknown; value?: unknown } | undefined | null;
    if (amount !== undefined && amount !== null) {
      if (amount.currency_code !== "USD" || typeof amount.value !== "string") {
        return reply("Refund amounts must be in USD, as a decimal string.", true);
      }
      try {
        amountCents = toCents(amount.value);
      } catch {
        return reply(`"${amount.value}" is not a valid dollar amount.`, true);
      }
    }
    const note = typeof input["note_to_payer"] === "string" ? input["note_to_payer"] : undefined;

    const outcome = await tools.refundVia(order.orderId, amountCents, note ?? "(no note)", async () => {
      // The toolkit sets no idempotency key, so this request is sent exactly
      // once and never resent; a failure is reported, not retried.
      const content = await forward({
        capture_id: order.captureId,
        amount: { currency_code: "USD", value: toDecimal(amountCents) },
        ...(note === undefined ? {} : { note_to_payer: note }),
      });
      return readRefund(content, amountCents, order.orderId);
    });
    return reply(outcome.message, !outcome.ok);
  }
}

const neverSent = async (): Promise<SendResult> => {
  throw new Error("an unknown capture must be rejected before anything is sent");
};

/**
 * Reads PayPal's answer to a refund request. Only the refund id and status are
 * kept; the rest of the response is not copied into logs or recordings.
 */
function readRefund(content: string, amountCents: number, orderId: string): SendResult {
  try {
    const parsed = JSON.parse(content) as { id?: unknown; status?: unknown };
    if (typeof parsed.id === "string") {
      const status = toRefundStatus(parsed.status);
      return { status, refundId: parsed.id, detail: `Refund ${parsed.id} of ${usd(amountCents)} on order ${orderId}: ${status}.` };
    }
  } catch {
    // not JSON: the toolkit returned an error message
  }
  return { status: "REJECTED", detail: "PayPal did not accept the refund." };
}
