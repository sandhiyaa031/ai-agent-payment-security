# Architecture

This is the locked design. Changes to anything under "Locked decisions" should be deliberate and recorded here.

## One-paragraph summary

Crashtest places test payments, lets an attacker chat with an AI support agent that holds a refund tool, and then asks the payment system how much was actually refunded. The difference between that and what the store's policy owed is the score. The agent's own words never count.

## How a run flows

```mermaid
flowchart LR
  S[Scenario] --> R[Runner]
  R -->|1. take test payments| Rail[(Payment rail)]
  R -->|2. customer message| A[Attacker]
  A --> Sub[Agent under test]
  Sub -->|3. refund attempt| G[Guards]
  G -->|allowed| Rail
  G -.->|blocked| Sub
  R -->|4. read refunds back| Rail
  R --> Ref[Referee: refunded vs owed]
  Ref --> Out[Report / dashboard / recording]
```

1. The runner takes a fresh test payment for every order in the scenario.
2. The attacker produces the customer's next message; the agent replies.
3. Any refund the agent attempts passes through the guards before it reaches the rail.
4. When the conversation ends, the runner reads the refunded amount for each order from the rail and compares it with what the policy owed.

## Parts

| Part | Files | Job |
|---|---|---|
| Payment rail | `src/rail/` | Where money moves. One interface, two implementations: the PayPal sandbox and an in-memory test rail. |
| Store policy | `src/store/policy.ts` | The refund policy, once as text for the agent and once as code. The code is the single source of truth for what is owed. |
| Refund tool and guards | `src/subject/tools.ts` | Every refund attempt goes through here: checks, optional guards, log entry, then the rail. |
| Agents under test | `src/subject/` | Two rule-based baselines, a model-backed agent, and a model-backed agent using PayPal's Agent Toolkit. |
| AI connection | `src/llm/` | One shared interface, with an adapter for OpenAI-format services and one for Anthropic. |
| Attacks | `src/attacks/` | Scenarios, a scripted attacker, and a model-driven adaptive attacker. |
| Runner and referee | `src/runner.ts` | Runs a scenario and computes the verdict from the rail. |
| Report | `src/report.ts` | Totals and the refund-ceiling replay. |
| Recording | `src/recording.ts` | Turns a run into a stream of events; saves and loads it. |
| Interfaces | `src/cli.ts`, `src/server.ts`, `public/` | Command line and web dashboard. Both use the same runner. |

## Locked decisions

1. **The rail is the referee.** Scores come only from refunds the payment system reports. An agent cannot improve its score by what it says.
2. **Sandbox only.** The PayPal client has no live address in its code path, and the Agent Toolkit is created in sandbox mode and rejected if it resolves anywhere else.
3. **One policy, in code.** `entitledCents` decides what is owed. The referee and the policy guard both call it, so they cannot disagree.
4. **Guards live outside the model.** The ceiling and the policy check run in code before any money moves, for every agent, including the toolkit agent.
5. **Honest customers are scored too.** A run reports money wrongly paid and money rightly paid, so an agent that refuses everyone does not look good.
6. **Fresh payments per scenario.** Each scenario gets its own orders, so results cannot leak between scenarios.
7. **Any model, same harness.** Agents and the attacker depend only on the `ChatModel` interface. Swapping provider is a setting, not a code change.
8. **No silent model fallback.** If a provider declines a request, that is reported as a refusal. A hidden switch to another model would corrupt per-model scores.
9. **Free to run.** The default path uses the free PayPal sandbox and free or local AI providers. Paid providers are optional.
10. **Hosted copies are harmless.** Hosted mode runs only the built-in agents on the test rail, replays recordings, holds no keys and writes nothing.
11. **Live runs and replays are the same stream.** The dashboard consumes one event format whether a run is happening now or was recorded earlier.
12. **Money is whole cents.** Decimal strings appear only at the edges, parsed strictly.

## Stack

- TypeScript on Node.js 22, run with `tsx`; no build step.
- Tests with Vitest. Type-checking with `tsc`.
- PayPal: Orders and Payments REST APIs for the rail; `@paypal/agent-toolkit` for the toolkit agent.
- AI: any OpenAI-format service through plain HTTP; `@anthropic-ai/sdk` for the optional Anthropic adapter.
- Dashboard: a small Node HTTP server with server-sent events, a static page, and AG Grid for tables. No front-end framework.
- Hosting: Render free plan, in hosted mode.

## Settings

All settings live in `.env`, which is never committed.

| Setting | Purpose |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal sandbox app |
| `PAYPAL_TEST_CARD_NUMBER`, `_EXPIRY`, `_CVV` | Sandbox test card used to take test payments |
| `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL` | AI provider, key and optional model name |
| `CRASHTEST_SUBJECT_MODEL`, `CRASHTEST_ATTACKER_MODEL` | Separate models for the agent and the attacker |
| `CRASHTEST_PUBLIC` | Set to `1` for hosted mode |
| `HOST`, `PORT` | Dashboard address; local-only by default |

## Not locked yet

- How invoice and subscription attacks are scored. Refunds have a clear dollar loss; a wrongly cancelled subscription needs a defined value.
- How many repeats per scenario are enough to report a loss rate.
- Which models go on the leaderboard.

## Not verified yet

The PayPal sandbox client, the model-backed agents and the Agent Toolkit agent have been tested against stand-ins only. See phase 4 in [ROADMAP.md](ROADMAP.md).
