# Roadmap

Deadline: **12 November 2026, 12:00 pm Pacific**. Target: submit by **10 November**.

A box is ticked only when the item is built **and** checked. "Checked" means tests pass, or it was run and seen working. Items that need your accounts are marked **(you)**.

**Current phase: 4, live verification.** Phases 1 to 3 are built and pass their tests offline. Nothing has yet run against the real PayPal sandbox or a real AI model, and that is what blocks phases 5 to 7.

| Phase | Status |
|---|---|
| 0. Idea and rules | Done |
| 1. Core engine | Done |
| 2. Dashboard | Done |
| 3. Real agents | Built, waiting on phase 4 |
| 4. Live verification | **In progress, waiting on keys** |
| 5. More attacks and evidence | Not started |
| 6. Hosted demo | Partly built |
| 7. Submission | Not started |

---

## Phase 0: Idea and rules

Goal: pick one project and know what the judges require.

- [x] Read the Devpost overview, official rules and resources
- [x] Explore and reject weaker ideas (dispute desk, sealed information, bonded claims, spending rules)
- [x] Lock the topic: Crashtest, a red-team benchmark for AI agents that move money through PayPal
- [x] Public repository with an MIT license

## Phase 1: Core engine

Goal: run dishonest-customer scenarios against an agent and score the money lost from the payment system's own records.

- [x] Money handled as whole cents, with strict parsing
- [x] Payment rail interface, with an in-memory test rail that follows PayPal's refund rules
- [x] Store refund policy, as text for the agent and as code for the referee
- [x] Refund tool with two guards: per-refund ceiling and policy enforced in code
- [x] 8 attack scenarios and 3 honest-customer scenarios
- [x] Two built-in agents that need no keys: one gullible, one strict
- [x] Referee that reads refunds back from the rail
- [x] Report with totals and the refund-ceiling replay
- [x] Command-line runner

## Phase 2: Dashboard

Goal: make a run watchable, for the demo video and for judges.

- [x] Local web server that streams a run as it happens
- [x] Live "money lost" counter, scenario table (AG Grid) and conversation view
- [x] Same controls as the command line
- [x] Works at phone width
- [x] Saved runs table with replay
- [x] Hosted mode that cannot spend money or reach any account

## Phase 3: Real agents

Goal: test real AI agents, including one built on PayPal's own Agent Toolkit, at no cost.

- [x] PayPal sandbox client (test payment, refund, read refunds back), tested against a stand-in
- [x] AI agent with a tool-calling loop, tested against a stand-in
- [x] Adaptive attacker that changes tactics each turn, tested against a stand-in
- [x] Agent whose refund tool is the real `@paypal/agent-toolkit` `create_refund`
- [x] Toolkit limited to refunds and pinned to the sandbox
- [x] Free AI providers (Groq, OpenRouter, Gemini, Ollama), with waiting and retrying on rate limits
- [x] Setup checks: `npm run paypal:check` and `npm run llm:check`

## Phase 4: Live verification  ← we are here

Goal: prove every path works against the real services, and fix whatever they reject.

- [ ] **(you)** Create the PayPal sandbox app and a test card, and fill in `.env`
- [ ] **(you)** Create a free Groq key and add it to `.env`
- [ ] `npm run paypal:check` passes
- [ ] `npm run llm:check` passes
- [ ] Full run: AI agent, scripted attacks, test rail
- [ ] Full run: AI agent, adaptive attacker, test rail
- [ ] Full run: AI agent on the PayPal sandbox rail
- [ ] Full run: Agent Toolkit agent on the PayPal sandbox, adaptive attacker
- [ ] Refunds from a run are visible in the PayPal sandbox dashboard
- [ ] First real results recorded into `recordings/`

## Phase 5: More attacks and evidence

Goal: make the results broad and credible enough to call a benchmark.

- [ ] Attacks on invoices (for example, talking the agent into cancelling or editing one)
- [ ] Attacks on subscriptions (for example, an unearned cancellation or price change)
- [ ] More refund scenarios, including split refunds that slip under a ceiling
- [ ] Repeat each scenario several times and report a loss rate, since models vary between runs
- [ ] Compare at least three models or configurations
- [ ] Leaderboard view in the dashboard
- [ ] Hardening guide: recommended limits for each toolkit tool, drawn from the results

## Phase 6: Hosted demo

Goal: give judges a link they can open with no setup.

- [x] Hosted mode and Render deployment file written
- [ ] **(you)** Create a free Render account and connect the repository
- [ ] Deployed copy loads and replays the recorded real runs
- [ ] Link added to the README

## Phase 7: Submission

Goal: a complete Devpost entry, submitted two days early.

- [ ] README final pass: what it is, results, how to run, tools used
- [ ] Short write-up of findings, with numbers from phase 5
- [ ] Demo video under 3 minutes, on YouTube, public, with no copyrighted music
- [ ] Devpost text description and list of tools used
- [ ] Check every submission requirement against the official rules
- [ ] **(you)** Submit on Devpost by 10 November

---

## Sponsor prizes in reach

- **AG Grid:** used for the scenario and saved-runs tables. Eligible now.
- **Render:** eligible once phase 6 is deployed.
