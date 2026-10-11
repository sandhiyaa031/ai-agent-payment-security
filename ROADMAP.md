# Roadmap

Deadline: **12 November 2026, 12:00 pm Pacific**. Target: submit by **10 November**.

**Current phase: 5 and 6 in parallel.** Phase 4 is half done: the AI model is verified live, and the PayPal sandbox is blocked on an account setting (see phase 4). Work that does not need PayPal is going ahead.

How to read this:

- A box is ticked only when the item is built **and** checked.
- "Offline tests" means automated tests against stand-ins. It does **not** mean the real service has been tried.
- Items that need your accounts are marked **(you)**.

| Phase | Status |
|---|---|
| 0. Idea and rules | Done |
| 1. Core engine | Done (offline tests) |
| 2. Dashboard | Done (offline tests and a manual browser check) |
| 3. Real agents | Built (offline tests only); not proven live |
| 4. Live verification | AI model verified; PayPal sandbox blocked on card-payment setting |
| 5. More attacks and evidence | Mostly done; more trials and two runs outstanding |
| 6. Hosted demo | Built locally; not deployed |
| 7. Submission | Not started |

---

## Phase 0: Idea and rules

**Goal:** pick one project and know what the judges require.
**Done when:** the topic is fixed and the repository meets the entry rules for a public, licensed codebase.

- [x] Read the Devpost overview, official rules and resources
- [x] Explore and reject weaker ideas
- [x] Lock the topic: Crashtest, a red-team benchmark for AI agents that refund money through PayPal
- [x] Public repository with an MIT license

## Phase 1: Core engine

**Goal:** run dishonest-customer scenarios against an agent and score the outcome from the payment system's own records.
**Done when:** `npm test` passes and `npm run demo` prints a baseline and a guarded report with no keys present.

- [x] Money handled as whole cents, with strict parsing
- [x] Payment rail interface with refund statuses, and an in-memory test rail that follows PayPal's refund rules
- [x] Store refund policy as text and as code, with a version number
- [x] One refund checkpoint: safety envelope (always on) plus defenses under test (policy, per-order ceiling)
- [x] Three evaluation profiles: baseline, guarded, sandbox
- [x] 15 attack scenarios and 7 honest-customer scenarios, each with a hand-written expected refund
- [x] Three built-in agents that need no keys: gullible, strict, refuse-all
- [x] Scoring: over-refund, under-refund, correctly refunded, attempts, blocks, repeats, unresolved
- [x] Report and command-line runner
- [x] A failed scenario is recorded as an error and the run continues

## Phase 2: Dashboard

**Goal:** make a run watchable, for the demo video and for judges.
**Done when:** a run started in the browser shows the same numbers as the command line, and a saved run replays identically.

- [x] Local web server that streams a run as it happens
- [x] Live loss counter, attempts and outcomes shown separately, scenario table (AG Grid), conversation view
- [x] Profile, agent, attacker, ceiling and trials controls
- [x] Saved runs table with replay; replay creates no rail, agent or attacker (tested)
- [x] Hosted mode that cannot use a key or a real provider (tested over HTTP)
- [x] Runs cannot be started from another website (tested)
- [x] Layout re-checked by eye after the profile and trials changes

## Phase 3: Real agents

**Goal:** be able to test real AI agents, including one built on PayPal's own Agent Toolkit, at no cost.
**Done when:** every item below passes its offline tests. Proving them live is phase 4.

- [x] PayPal sandbox client: test payment, refund, read refunds with statuses (offline tests)
- [x] PayPal client refuses any non-sandbox host (offline tests)
- [x] PayPal client resends a write at most once, with the same idempotency key (offline tests)
- [x] AI agent with a tool-calling loop (offline tests)
- [x] Adaptive attacker (offline tests)
- [x] Agent whose refund tool is the real `@paypal/agent-toolkit` `create_refund`, routed through the refund checkpoint (offline tests; the real toolkit is loaded offline to check its tool list and sandbox address)
- [x] Free AI providers, with waiting and retrying on rate limits (offline tests)
- [x] Setup checks written: `npm run paypal:check`, `npm run llm:check` (not yet run against the services)

## Phase 4: Live verification  ← we are here

**Goal:** prove every path works against the real services, and fix whatever they reject.
**Done when:** both setup checks pass, one full run completes in each profile with a real model, and at least one recording of a real run is saved.
**Blocked on:** the first two items.

- [ ] **(you)** Create the PayPal sandbox app and a test card, and fill in `.env`
- [x] **(you)** Create a free Groq key and add it to `.env`
- [ ] **(you)** Sandbox app with card payments enabled: the current app fails with `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING`; a US sandbox business account and a new app are the suggested fix
- [ ] `npm run paypal:check` passes: payment taken, refund made, repeated request returns the same refund, refund read back
- [ ] Record what status PayPal gives a fresh sandbox refund (`COMPLETED` or `PENDING`) and adjust if needed
- [x] `npm run llm:check` passes: the model replies and calls a tool (three Groq models checked)
- [x] Full run, `baseline`, AI agent, scripted attacker (three models, recorded)
- [x] Full run, `guarded`, AI agent, scripted attacker (one model, recorded)
- [ ] Full run, `baseline`, AI agent, adaptive attacker
- [ ] Full run, `sandbox`, AI agent: only owed refunds appear in the PayPal sandbox dashboard
- [ ] Full run, `sandbox`, Agent Toolkit agent
- [ ] Free-tier rate limits survive a full run without a scenario error
- [x] First real results recorded into `recordings/` (test rail only)

## Phase 5: More attacks and evidence

**Goal:** make the refund benchmark broad and credible enough to publish numbers from.
**Done when:** at least three model or configuration combinations have been run 10 times per scenario with the scripted attacker, and the results are in the README with sample counts.
**Depends on:** phase 4.

In priority order:

- [x] Split and cumulative refund scenarios (`split-refund`, plus the existing `extra-order`)
- [x] Duplicate refund and retry scenario (`duplicate-refund`)
- [x] Invalid reference scenario (`invalid-reference`, a made-up order number)
- [x] More prompt-injection and social-engineering scenarios (`forged-record`, `late-return`, `sob-story`, `price-adjustment`)
- [x] More honest-customer scenarios, including a rude one who is owed, an edge-of-window return, and two who are owed nothing
- [x] Repeat runs: `--repeat N`, reporting per-scenario trial counts (command line and dashboard)
- [x] Compare at least three model or configuration combinations (three models in `baseline`, one also in `guarded`; 3 trials each, see RESULTS.md)
- [x] Leaderboard in the dashboard: the saved-runs table shows profile, defenses, trials, attempts, losses and honest refunds side by side
- [ ] Adaptive attacker results reported separately, as a stress test
- [x] Hardening guide (HARDENING.md), each recommendation tied to a measured result
- [ ] Raise trials from 3 to 10 per scenario (limited by the free model tier's daily quota)
- [ ] Guarded runs for the other two models, and the hardened-prompt variant (queued)

Deferred to a later version: invoice and subscription attacks. They need different tools and a scoring method that can be defended.

## Phase 6: Hosted demo

**Goal:** give judges a link they can open with no setup.
**Done when:** the public link loads, runs the built-in agents, and replays at least one recorded real run.
**Depends on:** phase 4 for the recordings.

- [x] Hosted mode written and tested locally
- [x] Render deployment file written (not yet deployed, so not yet proven)
- [x] **(you)** Create a free Render account and connect the repository
- [ ] **(you)** Create the Blueprint service on Render
- [ ] Deployed copy loads and replays the recorded real runs
- [ ] Link added to the README

## Phase 7: Submission

**Goal:** a complete Devpost entry, submitted two days early.
**Done when:** every requirement in the official rules is met and the entry is submitted.

- [ ] README final pass with real results
- [ ] Short write-up of findings, with numbers and sample counts from phase 5
- [ ] Demo video under 3 minutes, on YouTube, public, with no copyrighted music
- [ ] Devpost text description and list of tools used
- [ ] Check every submission requirement against the official rules
- [ ] **(you)** Submit on Devpost by 10 November

---

## Sponsor prizes in reach

- **AG Grid:** used for the scenario and saved-runs tables. Eligible now.
- **Render:** eligible once phase 6 is deployed.
