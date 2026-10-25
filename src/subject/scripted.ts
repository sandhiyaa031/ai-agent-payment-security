import { usd } from "../money";
import { entitledCents } from "../store/policy";
import { mentionedOrderIds, type Subject, type SubjectSession } from "./subject";
import type { SessionContext, SupportTools } from "./tools";

/**
 * Two rule-based agents that need no API key. They bracket the scale: one
 * refunds anyone who asks, the other applies the policy to the letter.
 */

const WANTS_MONEY = /refund|money back|reimburse|credit me/i;

export class GullibleSubject implements Subject {
  readonly name = "gullible (refunds whoever asks)";

  manifest() {
    return { kind: "scripted" };
  }

  startSession(_context: SessionContext, tools: SupportTools): SubjectSession {
    return {
      async reply(message) {
        if (!WANTS_MONEY.test(message)) return "Happy to help. What do you need?";
        const replies: string[] = [];
        for (const orderId of mentionedOrderIds(message, tools)) {
          const order = tools.getOrder(orderId)!;
          const result = await tools.refundOrder(orderId, order.amountCents, "Customer asked for a refund");
          replies.push(result.ok ? `I refunded ${usd(order.amountCents)} on ${orderId}.` : `I could not refund ${orderId}.`);
        }
        return replies.length > 0 ? replies.join(" ") : "Which order is this about?";
      },
    };
  }
}

export class StrictSubject implements Subject {
  readonly name = "strict (policy applied in code)";

  manifest() {
    return { kind: "scripted" };
  }

  startSession(context: SessionContext, tools: SupportTools): SubjectSession {
    const refunded = new Set<string>();
    return {
      async reply(message) {
        if (!WANTS_MONEY.test(message)) return "Happy to help. What do you need?";
        const replies: string[] = [];
        for (const orderId of mentionedOrderIds(message, tools)) {
          const owed = entitledCents(tools.getOrder(orderId)!, context.customerEmail);
          if (owed === 0 || refunded.has(orderId)) {
            replies.push(`Order ${orderId} is not eligible for a refund under our policy.`);
            continue;
          }
          const result = await tools.refundOrder(orderId, owed, "Eligible under refund policy");
          if (result.ok) refunded.add(orderId);
          replies.push(result.ok ? `I refunded ${usd(owed)} on ${orderId}.` : `I could not refund ${orderId}.`);
        }
        return replies.length > 0 ? replies.join(" ") : "Which order is this about?";
      },
    };
  }
}

/** Refuses everything. It can never over-refund, and exists to show that this alone is not good service. */
export class RefuseAllSubject implements Subject {
  readonly name = "refuse-all (never refunds)";

  startSession(): SubjectSession {
    return {
      async reply() {
        return "I am sorry, I cannot offer a refund.";
      },
    };
  }
}
