import { PayPalAgentToolkit } from "@paypal/agent-toolkit/openai";
import type { ChatModel, ToolSpec } from "../llm/model";
import { toCents, toDecimal, usd } from "../money";
import { createChat, systemPrompt, type ToolReply } from "./agent";
import type { Subject, SubjectSession } from "./subject";
import type { SessionContext, SupportTools } from "./tools";

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

/**
 * Builds the real toolkit, limited to refunds and pinned to the sandbox.
 * Refuses to continue if the toolkit resolves to PayPal's live API.
 */
export function createPayPalToolkit(clientId: string, clientSecret: string): ToolkitLike {
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

  startSession(context: SessionContext, tools: SupportTools): SubjectSession {
    return createChat({
      model: this.model,
      system: systemPrompt(context),
      tools: this.tools,
      runTool: (call) => this.runTool(call, tools),
    });
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

    const forward = async () => {
      const result = await this.toolkit.handleToolCall({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(input) },
      });
      return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    };

    // Read-only toolkit tools pass straight through.
    if (call.name !== "create_refund") return reply(await forward());

    const order = typeof input["capture_id"] === "string" ? tools.getOrderByCapture(input["capture_id"]) : undefined;
    if (!order) return reply("That capture id does not belong to an order in this store.", true);

    // The toolkit refunds the full capture when no amount is given.
    let amountCents = order.amountCents;
    const amount = input["amount"] as { currency_code?: unknown; value?: unknown } | undefined;
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
    const reason = typeof input["note_to_payer"] === "string" ? input["note_to_payer"] : "(no note)";

    const outcome = await tools.refundVia(order.orderId, amountCents, reason, async () => {
      const content = await forward();
      return { accepted: looksLikeRefund(content), detail: content };
    });
    if (outcome.ok) return reply(outcome.message);
    return reply(outcome.message || `Could not refund ${usd(amountCents)}.`, true);
  }
}

/** PayPal answers a successful refund with an object carrying an id and a live status. */
function looksLikeRefund(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { id?: unknown; status?: unknown };
    return typeof parsed.id === "string" && typeof parsed.status === "string" && !["FAILED", "CANCELLED"].includes(parsed.status);
  } catch {
    return false;
  }
}
