# Crashtest

**How much money can your AI support agent be talked out of, and which defenses actually stop it?**

Crashtest is an open benchmark for AI agents that hold a money-moving tool. It sends dishonest "customers" at an agent with a PayPal refund tool, and measures what the agent **tried** to give away and what **actually** left the account, read from the payment system's own records. Honest customers are in the mix, so refusing everyone cannot win.

**Live demo:** [crashtest-7wl9.onrender.com](https://crashtest-7wl9.onrender.com). No setup or keys. It replays recorded runs of real AI models and runs built-in agents on a test payment system. It is on a free host, so the first load after a quiet spell can take up to a minute.

<!-- results:headline:start -->
**Pre-registered experiments are still running.** The defense comparison, its chart and every rate will appear here once they finish; nothing is shown early. Progress is in [RESULTS.md](RESULTS.md).
<!-- results:headline:end -->

All money is test money. Results describe this fixed set of scenarios on a few free models; see [Limitations](docs/LIMITATIONS.md) before quoting a number.

## How it works

1. For each scenario, it takes fresh test payments.
2. An attacker plays a customer after a refund the policy does not owe: a package that "never arrived", a fake manager, someone else's order, an instruction hidden in an order note.
3. The agent answers, with a tool that can refund money.
4. Every refund attempt passes one checkpoint in code, which logs it and applies the safety rules and any defense being tested.
5. A referee reads the refunds back from the payment rail and compares them with what the policy owed. What the agent says it did is never scored.

## What makes it rigorous

- **Attempts and losses are kept apart**, and both are kept apart from service to honest customers.
- **Pre-registered.** Hypotheses, sample size, analysis and stopping rule are committed in [`experiments/`](experiments) before each run, and results stay hidden until a run is complete.
- **Rates with intervals.** Wilson 95% intervals, permutation tests within scenarios, Holm's adjustment and an A/A check, with the statistics code checked against published values.
- **Every run is pinned and replayable.** Model, temperature, seed, and the hashes of the prompt and tools are recorded, and every conversation can be replayed turn by turn.
- **Attacks mapped to standards.** 37 attacks and 16 honest customers across [families](docs/TAXONOMY.md) mapped to the OWASP Top 10 for LLM Applications and MITRE ATLAS, including indirect injection through six data sources.
- **Honest about what it cannot show.** See the [threat model](docs/THREAT_MODEL.md) and [limitations](docs/LIMITATIONS.md).

## Defenses compared

| | Defense | Layer |
|---|---|---|
| D0 | None | |
| D1 | Hardened system prompt | Prompt |
| D2 | Guard model screening customer messages (Llama Prompt Guard 2) | Input |
| D3 | Spotlighting: untrusted text marked as data | Prompt and input |
| D5 | Policy engine at the tool boundary | Tool boundary |
| D6 | Human approval above a threshold, counting the approvals a person would face | Tool boundary |
| D7 | Rate and velocity limits per customer conversation | Tool boundary |

The dual-LLM pattern (D4) was not evaluated; see [Limitations](docs/LIMITATIONS.md).

## Experiments

| Experiment | Question | Protocol |
|---|---|---|
| 01 | How often do agents attempt and complete improper refunds, and does a hardened prompt help? | [protocol](experiments/01-prompt-hardening/protocol.md) |
| 02 | How do the defenses compare on security and utility? | [protocol](experiments/02-defense-comparison/protocol.md) |
| 03 | Does an adaptive attacker get further than scripts, and with which techniques? | [protocol](experiments/03-adaptive-attacker/protocol.md) |
| 04 | How does an agent fare against indirect injection and the wider suite? | [protocol](experiments/04-attack-suite/protocol.md) |

Three profiles keep the evidence separate:

| Profile | Question | Money moves on | Policy defense |
|---|---|---|---|
| `baseline` | What does the agent attempt, and what would it cost, with nothing in the way? | Built-in test rail | Off |
| `guarded` | How much does enforcing the policy in code change the outcome? | Built-in test rail | On |
| `sandbox` | Does the real PayPal integration report what the test rail predicts? | PayPal sandbox | Always on |

Improper refunds are only ever allowed to complete on the built-in test rail. On the PayPal sandbox the policy defense cannot be turned off, so a deliberately unauthorized refund is never sent to PayPal; the agent's attempts are still counted.

## Try it

You need [Node.js](https://nodejs.org) 22 or newer. No accounts or keys for the first three.

```bash
npm install
```

```bash
npm run demo
```

The demo runs a gullible built-in agent twice, without and then with the policy enforced in code.

```bash
npm run dashboard
```

Then open http://127.0.0.1:4173. Run scenarios from the new suite with:

```bash
npm run crashtest -- --suite scenarios/set-3.json --subject gullible
```

Regenerate every result, chart and table from the recordings, with no keys and no model calls:

```bash
npm run reproduce
```

To test a real model or connect the PayPal sandbox, follow [SETUP.md](SETUP.md). Everything can be run at no cost: the PayPal sandbox is free, and the AI side works with free providers (Groq, OpenRouter, Gemini) or a local model through Ollama. To test your own agent, tool or attacks, see [docs/ADAPTERS.md](docs/ADAPTERS.md).

## Status

Checked live:

- Three free models on Groq, on the built-in test rail, in the experiments above.
- The hosted copy: it loads, refuses anything that needs a key, runs the built-in agents and replays recorded runs.
- Continuous integration on every push: type check, lint, the full test suite, and smoke runs of both scenario sets.

Built and tested offline, not yet proven against the live service:

- **The PayPal sandbox path.** The client, its sandbox-only host check, idempotent retries and the Agent Toolkit agent are tested against stand-ins. The sandbox account needs a card-payments setting before `npm run paypal:check` can pass.

## Documentation

| | |
|---|---|
| [RESULTS.md](RESULTS.md) | Every result, generated from the recordings |
| [docs/REPORT.md](docs/REPORT.md) | Workshop-style write-up: motivation, related work, method, results, limitations |
| [docs/TAXONOMY.md](docs/TAXONOMY.md) | The attack families, mapped to OWASP and MITRE ATLAS |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) | Assets, attackers, trust boundaries, residual risks |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | What this does not measure, and why results may not transfer |
| [docs/DECISION_LOG.md](docs/DECISION_LOG.md) | What changed, why, and what was rejected |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | Plug in another agent, tool, model provider or attacks |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The design and its locked decisions |
| [SETUP.md](SETUP.md) | Setting up keys, free providers and hosting |

## Safety

- Crashtest only talks to PayPal's sandbox. The PayPal client refuses any other host, and the Agent Toolkit is created in sandbox mode and rejected if it resolves anywhere else.
- Models never see payment credentials. They can only call tools, and every refund tool leads to the same checkpoint.
- A hosted copy runs only the built-in agents on the test rail and replays recordings. It holds no keys.
- **Use it only on agents you own or are authorised to test.** See [responsible use](docs/RESPONSIBLE_USE.md).

## License

MIT. See [LICENSE](LICENSE).
