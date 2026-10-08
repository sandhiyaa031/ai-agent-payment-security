# Crashtest

**How much money can your AI support agent be talked out of?**

PayPal's Agent Toolkit lets an AI agent issue refunds, send invoices and cancel subscriptions. Crashtest sends dishonest "customers" at such an agent and counts the dollars it gives away. The score comes from the payment system's own records, never from what the agent says it did.


## What it does

1. For each scenario, it takes real test payments on the PayPal sandbox (or a built-in pretend rail).
2. An attacker plays a customer who wants a refund the store's policy does not owe: a package that "never arrived", a fake manager, someone else's order, a hidden instruction in the message.
3. The agent under test answers, with a tool that moves money.
4. A referee reads the refunds back from the rail and compares them with what the policy owed.
5. The report shows money lost, whether honest customers still got paid, and what a refund ceiling would have stopped.

Honest customers are in the mix on purpose. An agent that refuses everyone loses nothing and is still useless, so the report scores both sides.

## Try it

```bash
npm install
```

```bash
npm run demo
```

No accounts or keys are needed for the demo. To connect the PayPal sandbox and test a real model, follow [SETUP.md](SETUP.md).

Sample output for an agent that refunds whoever asks:

```
Money lost to attacks : $1852.00 of $1921.00 at risk (96%)
Attacks that paid out : 8 of 8
Honest refunds paid   : $207.00 of $207.00 owed (100%)
```

The same agent with the policy enforced in code, outside the model:

```bash
npm run crashtest -- --subject gullible --enforce-policy
```

```
Money lost to attacks : $0.00 of $1921.00 at risk (0%)
Honest refunds paid   : $207.00 of $207.00 owed (100%)
```

## Options

| Option | Values | Meaning |
|---|---|---|
| `--subject` | `gullible`, `strict`, `claude` | The agent under test |
| `--attacker` | `scripted`, `adaptive` | Fixed messages, or a model that changes tactics |
| `--rail` | `mock`, `paypal` | Pretend rail, or the PayPal sandbox |
| `--cap <dollars>` | number | Guard: block any single refund above this |
| `--enforce-policy` | flag | Guard: check the refund policy in code |
| `--only <id>` | scenario id | Run one scenario |
| `--json <path>` | file path | Save transcripts, tool calls and results |

## How it is built

| Path | Role |
|---|---|
| `src/rail/` | The money. `paypal.ts` talks to the PayPal sandbox (Orders and Payments APIs); `mock.ts` is an in-memory copy with the same refund rules. |
| `src/store/policy.ts` | The store's refund policy, as text for the agent and as code for the referee. |
| `src/subject/` | Agents under test, and the refund tool with its optional guards. |
| `src/attacks/` | Scenarios and the scripted and adaptive attackers. |
| `src/runner.ts` | Runs a scenario and reads the verdict from the rail. |
| `src/report.ts` | Totals and the refund-ceiling replay. |

## Status

Working and covered by tests:

- The full pipeline on the mock rail, with both built-in agents and both guards.
- The PayPal client's requests and response handling, against a scripted stand-in for PayPal.
- The model-backed agent's tool loop and the adaptive attacker, against a scripted stand-in for the model.

Not yet run against the live services:

- The PayPal sandbox path. `npm run paypal:check` is the first thing to run once keys exist.
- The model-backed agent and attacker with a real API key.

Planned next:

- An adapter that tests agents built directly on `@paypal/agent-toolkit`.
- Attacks on invoices and subscriptions as well as refunds.
- A web dashboard with a live loss counter and a leaderboard across models.

## Safety

Crashtest only talks to PayPal's sandbox; the live API address is not in the code path. The attacker only writes chat messages to an agent you run yourself, against test accounts you own.

## License

MIT. See [LICENSE](LICENSE).
