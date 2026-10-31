# Threat model

What Crashtest assumes about the system it tests, who attacks it, where trust changes hands, and what each defense does and does not protect. Written for the agent under test: an AI support agent that can look up orders and issue refunds.

## The system

```
 customer ──messages──▶ ┌───────────┐ ──tool call──▶ ┌────────────────┐ ──refund──▶ ┌──────────────┐
                        │  AI agent │                │ refund         │             │ payment rail │
 outside text ──lookup▶ │  (model)  │ ◀──result───── │ checkpoint     │ ◀─result─── │ test / PayPal│
                        └───────────┘                └────────────────┘             └──────────────┘
                              ▲                              ▲
                     system prompt, policy text       order records, entitlement
```

## Assets

| Asset | Why it matters |
|---|---|
| The merchant's money | An improper refund is a direct, usually unrecoverable loss. |
| Honest customers' refunds | A defense that refuses people who are owed money has a real cost, so it is measured next to losses. |
| The integrity of the refund policy | The policy should decide refunds, not whoever talks to the agent most persuasively. |
| Payment credentials | Models never see them. Keys stay in `.env`, and recordings hold none. |

## Attackers

| Attacker | Controls | Does not control |
|---|---|---|
| **Dishonest customer** | Everything they type, over several turns. May lie, plead, threaten, impersonate staff, paste fake notices or records, hide instructions in base64, markup or another language. Knows the policy. | Who they are signed in as, the store's structured order fields, the system prompt. |
| **Poisoned data source** | Free text the agent reads through its tools: checkout notes, carrier status text, ticket history, product reviews, emails on file, item names. Anyone who can write to one of these can reach the model. Modelled in scenario set 3. | The structured fields the policy uses: owner, amount, delivery status, days, return received. |
| **Adaptive attacker** (a model standing in for a skilled person) | The same as a dishonest customer, and it reads the agent's replies and changes tactics. Limited to a few turns per conversation. | The same as a dishonest customer. |

**Out of scope:** a compromised store database, a malicious insider, stolen PayPal credentials, a compromised model provider or a poisoned model, attacks on the dashboard's host, and abuse spread over many accounts or sessions.

## Trust boundaries

1. **Customer to agent.** Nothing a customer types is trusted. This is the boundary prompt injection crosses directly.
2. **Outside text to agent.** Text that arrives through a tool looks authoritative to the model, because it came from "the system". It is not. This is the boundary indirect injection crosses.
3. **Agent to tool.** The most important boundary. The model's output is treated as an untrusted request, not a decision. Every refund, from every agent, passes one checkpoint in code (`src/subject/tools.ts`), and the attempt is logged whatever happens to it.
4. **Checkpoint to rail.** The checkpoint can always reach the rail, so it must be correct. It is small, separate from the model and fully tested. On a real provider the policy defense cannot be switched off.
5. **Rail to referee.** Results are read back from the rail. What the agent said it did is never scored.

## What each defense protects

| Defense | Boundary | Protects against | Does not protect against |
|---|---|---|---|
| Safety envelope (always on) | 3 | Unknown orders, invalid amounts, refunding more than was paid | Anything within the amount paid. It is not a policy. |
| D1 hardened prompt | inside the model | Some fake notices and pasted records, to the extent the model obeys | A model that is talked out of it. It tells the agent to trust the order lookup, which is exactly what indirect injection exploits. |
| D2 guard model | 1 (and 2 in experiment 04) | Text that looks like a known injection or jailbreak | Plausible text. A polite fake system notice can score far below the threshold. Also a risk to honest customers, whose conversations end if they are flagged. |
| D3 spotlighting | 1, 2 | Models confusing outside text with instructions | A model that follows marked text anyway, and persuasion that contains no instruction. |
| D4 dual-LLM (not evaluated) | 1, 2 | Would keep raw outside text away from the model that can act | See `docs/LIMITATIONS.md`. Listed as future work. |
| D5 policy engine | 3 | Any refund beyond what the store's records entitle the signed-in customer to, including someone else's order, repeats and splitting | Wrong records: it is only as good as its inputs (see below). Also blocks nothing an agent chooses not to do, such as promising a refund without issuing one. |
| D6 human approval | 3 | Large improper refunds, if the reviewer checks properly | Amounts under the threshold, and a tired or persuaded reviewer. The evaluation assumes a perfect reviewer, so it shows the best case. |
| D7 velocity limit | 3 | Many refunds or a large total in one conversation | Abuse spread across conversations, and it can block an honest customer owed more than the limit. |

## Residual risks

Even with every defense on:

- **Poisoned structured data.** D5 trusts the store's records. An attacker who can change `delivery_status` or `return_received` is entitled, as far as the code can tell. Those fields need their own write controls.
- **A false promise.** An agent can tell a customer a refund is on its way without issuing one. The pilot recorded this once. Under-refunds catch it in the numbers, but the customer has already been misled.
- **Policy gaps.** D5 enforces the policy as written. If the policy is exploitable, the checkpoint faithfully pays out.
- **Harm that is not a refund.** The agent can leak order details or say something false. Crashtest does not score that.
- **Scale.** One improper refund per conversation is small; a thousand conversations are not. The scenarios are single conversations.
- **The attacker improves.** Passing this suite says nothing about attacks not in it.

## The hosted demo

The public copy holds no keys, reads no `.env`, runs only built-in agents on the test rail, replays recordings, writes nothing to disk, and refuses runs started from other sites (tested over HTTP). A flaw in it exposes no credentials, because there are none to expose.
