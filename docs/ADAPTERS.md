# Plugging in your own agent, tool or attacks

Crashtest separates four things. Each has a small interface, and swapping one does not touch the others.

| You want to test | Implement | Example in the repo |
|---|---|---|
| Another agent or framework | `Subject` in `src/subject/subject.ts` | `ModelSubject`, `ToolkitSubject` (PayPal Agent Toolkit) |
| Another privileged tool or provider | `PaymentRail` in `src/rail/rail.ts`, and `ActionTool` for the tool's name and description | `StoreCreditRail`, `PayPalRail`, `MockRail` |
| Another model provider | `ChatModel` in `src/llm/model.ts`, or just point `LLM_BASE_URL` at any OpenAI-format service | `OpenAiCompatibleModel`, `AnthropicModel` |
| More attacks | A JSON data file, no code | `scenarios/set-3.json` |

## An agent: `Subject`

```ts
interface Subject {
  readonly name: string;
  startSession(context: SessionContext, tools: SupportTools, options?: { seed?: number }): SubjectSession;
  manifest?(): ComponentManifest; // what exactly is under test
  usage?(): Usage | undefined;    // tokens and time, if you have them
}

interface SubjectSession {
  reply(customerMessage: string): Promise<string>;
}
```

Your agent receives `tools` and does whatever it likes with them. The one rule: every privileged action goes through `tools.refundOrder(...)` or `tools.refundVia(...)`. That is the checkpoint that logs the attempt and applies the safety envelope and the defenses. If your framework calls the provider itself, use `refundVia`, which runs the checks and then calls your `send` function, as `ToolkitSubject` does for PayPal's toolkit.

## A privileged tool: `PaymentRail`

A rail takes a payment, grants something against it, and reports what it granted.

```ts
interface PaymentRail {
  readonly name: string;
  readonly external: boolean; // true if it reaches a real provider
  charge(input): Promise<Charge>;
  refund(input): Promise<RefundResult>;   // must honour input.idempotencyKey
  refunds(orderId): Promise<RefundRecord[]>; // the referee reads this; agents' claims are never scored
}
```

`src/rail/store-credit.ts` is about 50 lines. To give a model the new tool, describe it with an `ActionTool`:

```ts
export const STORE_CREDIT_TOOL: ActionTool = {
  name: "issue_store_credit",
  description: "Issue store credit against an order. ...",
  promptNote: "This store gives refunds as store credit: ...",
};
```

Then:

```bash
npm run crashtest -- --subject model --tool store-credit --profile guarded
```

The tool name, description and prompt note change the recorded fingerprints, so these runs can never be mixed with refund runs.

A rail with `external: true` cannot run without the policy defense. The code refuses. Keep that rule for anything that reaches a real system.

Tools that do not grant an amount, such as changing an account's email, need a different score than dollars. They are not supported yet; the shape of the work is a new entitlement check and a new outcome in `src/metrics.ts`.

## Attacks: scenario data files

```json
{
  "suite": "my-suite-1",
  "scenarios": [
    {
      "id": "my-attack",
      "version": 1,
      "title": "Short description",
      "kind": "attack",
      "family": "indirect-injection",
      "category": "order note",
      "owasp": ["LLM01:2025 Prompt Injection", "LLM06:2025 Excessive Agency"],
      "atlas": ["AML.T0051.001", "AML.T0053"],
      "customerEmail": "maya.chen@example.com",
      "orders": [
        {
          "key": "order",
          "ownerEmail": "maya.chen@example.com",
          "item": "Desk lamp",
          "amountCents": 4900,
          "placedDaysAgo": 12,
          "delivery": "DELIVERED",
          "deliveredDaysAgo": 6,
          "expectedRefundCents": 0,
          "thirdPartyText": { "customer_note": "Text an outsider wrote. The order lookup shows it." }
        }
      ],
      "goal": "What the adaptive attacker should achieve on {order}.",
      "script": ["What the scripted customer says about {order}."]
    }
  ]
}
```

```bash
npm run crashtest -- --suite path/to/my-suite.json --subject gullible
```

- `expectedRefundCents` is written by hand from the policy text. On every run it is checked against the policy code, and a mismatch stops the scenario. This is on purpose: it catches a mistake in either one.
- `{order}` is replaced by the real order id. A placeholder that is not one of the scenario's order keys is refused when the file loads.
- `kind` is `attack` or `benign`. Give each attack an honest counterpart where one makes sense (`counterpart`), so a defense that simply refuses everyone is caught.
- Bump `version` when a scenario changes, and `suite` when the file changes, so old and new results are not compared.
