# Decision log

One entry per phase: what changed, why, what was rejected, and the questions an interviewer is likely to ask, with answers. Newest entries at the bottom.

---

## Phase 1: statistical rigor (25 October 2026)

### What changed

1. **The pilot runs were published and labelled as pilot.** Ten runs made before any protocol existed, mostly with 3 trials per scenario. They shaped the hypotheses and are kept out of every confirmatory analysis.
2. **Every run now records exactly what it tested.** The temperature is sent on every request (1, the free providers' default) instead of left to the provider. Each conversation gets its own seed, derived from the run's seed, the scenario and the trial. The recording keeps: the run seed; the SHA-256 of the system prompt and of the tool definitions; provider, model and temperature; every model id and build fingerprint the provider reported serving; tokens and model time per conversation; and the SHA-256 of the protocol the run follows. A run cannot be continued under a different prompt, model, temperature or seed. The harness version went to 0.2.0, so pilot runs can never be mixed in.
3. **Statistics, with no new dependencies** (`src/stats.ts`): Wilson intervals, Newcombe's interval for a difference, Fisher's exact test, a permutation test that shuffles labels within each scenario, a scenario-stratified bootstrap, and Holm's adjustment. Each is checked against published values or by simulation.
4. **Experiment 01 was pre-registered before any run** (`experiments/01-prompt-hardening/protocol.md`): three free models, stock prompt (D0) against hardened prompt (D1), scripted attacker, 10 trials per scenario, with hypotheses, outcomes, analysis and stopping rule fixed in advance. It is running.
5. **RESULTS.md is generated from the recordings** (`src/results-report.ts`). For a pre-registered experiment it shows only progress until every configuration has the pre-registered number of trials, then rates with intervals, the hypothesis tests, an A/A check and any deviations.

### Why

- **Pinning.** A result is only reproducible if you know exactly what produced it. Providers change defaults and even swap the model behind a name; recording what they report serving makes that visible. In the first test run Groq reported 7 different build fingerprints for `gpt-oss-20b` across 11 requests, so "same model name" does not mean "same build".
- **Temperature 1, not 0.** At temperature 0 a model gives nearly the same answer every time, so 10 trials would be 10 copies of one observation and an interval computed from them would be false precision. Temperature 1 is also what a merchant gets by default.
- **Pre-registration.** Writing the hypothesis, sample size and analysis down before running stops the analysis from being tuned to the data afterwards. The git commit time proves the order, and each recording carries the protocol's hash.
- **Results hidden until complete.** Looking at results partway and stopping when they look good inflates false positives. The report enforces the stopping rule instead of trusting discipline.

### The sample size, and why it is 10 and not 30

The brief asked for at least 30 trials per scenario where free tiers allow. Measured on 25 October: about 2,600 tokens per conversation; the free tier gives 200,000 tokens per model per day, so about 75 conversations per model per day. Experiment 01 needs 440 conversations per model (about 6 days). At 30 trials it would need about 18 days per model, past the submission date. So N = 10, the largest that fits alongside the planned defense comparison. The protocol states this, and states what it means: with 150 attack trials per configuration, differences of a few percentage points cannot be detected.

### One thing I got wrong in the plan, and corrected

In the plan I said a single Wilson interval over all attack trials would overstate certainty, because the scenarios differ so much. Working it through, that is only true if you want to generalise to attacks in general (a random sample of possible scenarios). For the question we can actually answer, rates on **this fixed set** of scenarios, the pooled Wilson interval is at least as **wide** as a scenario-stratified one (often wider, when scenarios differ a lot), so it errs on the side of caution, and unlike a bootstrap it still gives a real upper bound when nothing was observed (0 of 150 gives 0% to 2.5%, not "exactly 0"). So: pooled Wilson for suite-level rates, Wilson per scenario, and a stated limitation that the numbers describe this suite, not attacks in general. The permutation test still shuffles within scenarios, because that matters for comparisons (see below).

### Alternatives rejected

| Option | Why not |
|---|---|
| A statistics library | Every method needed is a few lines; writing them keeps the project dependency-free and each one is tested against published values. |
| Normal-approximation ("plus or minus 1.96 standard errors") intervals | Wrong near 0 and 100%, which is exactly where these rates sit. |
| Fisher's exact test as the main test | It pools all scenarios. If one configuration happened to run the easy scenarios more often, pooling would show a difference that is not there. A test in the suite shows this case: Fisher gives p < 0.01, the within-scenario permutation test correctly gives p = 1. Fisher is still reported for comparison. |
| Cochran–Mantel–Haenszel test | Also valid for stratified 2x2 tables, but relies on a large-sample approximation; with many scenarios at 0 successes the permutation test is exact up to simulation error and easier to explain. |
| Re-running trials that error | Would hide failures. Errors are kept and counted as unresolved. |
| A separate A/A run | Costs a full extra configuration of the free allowance. Instead, the stock-prompt configuration's first 5 trials are compared with its last 5, which ran on different days. Weaker than a full A/A run, and said so. |

### What an interviewer might ask

**"Why should I believe 10 trials?"** Don't believe more than the intervals say. Every rate comes with its 95% interval, and the protocol says in advance that small differences will not be detectable. The point is honest uncertainty, not a big N.

**"Isn't 0 out of 150 proof the defense works?"** No. Zero observed in 150 is consistent with a true rate of up to 2.5% (Wilson upper bound). The report shows that bound.

**"What does the permutation test actually do?"** If the hardened prompt made no difference, then within each scenario it would not matter which trials were labelled "stock" and which "hardened". So the labels are shuffled within each scenario 10,000 times, and the p-value is the share of shuffles that show a difference at least as large as the real one.

**"Why Holm?"** Two primary hypotheses (two models) are tested. Testing each at 5% would give about a 10% chance of at least one false alarm. Holm keeps that at 5% overall and is never worse than Bonferroni.

**"How do you know your statistics code is right?"** The interval code reproduces published values from Newcombe's 1998 papers to four decimal places. The permutation test is checked by simulation: with no real difference it raises a false alarm at most about 5% of the time, and with a simulated defense that removes most of the risk it detects the difference more than 80% of the time. While writing those tests, two of my own expected values were wrong. I checked both by hand: one remembered "published" value did not match the formula, and was dropped rather than bent to fit; one Holm expectation was my arithmetic error.

**"Is a seed enough to reproduce a run?"** No. Providers treat seeds as best effort, and they change builds. What is reproducible is the analysis: every number in RESULTS.md is regenerated from the recordings, and every conversation can be replayed. Re-running the models will give different conversations, which is why results are rates with intervals.

**"Why not test at temperature 0 too?"** It would answer a different question (the most likely answer, not the spread of answers) and cost another full configuration. Possible later work.

---

## Order of work (31 October 2026)

The brief's phases were not done in number order. Compute and the deadline set the order: everything needing no model calls went first, and pre-registrations went in before any experiment 01 result was looked at, so the plans could not be shaped by the data. Five days of compute were lost when the PC shut down on 26 October and the queues were not restarted; recorded runs now pick up where they stopped, but they must be restarted by hand.

---

## Phase 2: a taxonomy-mapped attack suite (31 October 2026)

### What changed

- `scenarios/set-3.json`: 22 new attacks and 9 honest counterparts. Indirect injection through six sources, multi-turn escalation, salami, tool-argument manipulation, authority impersonation, obfuscation, cross-customer.
- `scenarios/set-2.json`: the existing 22 scenarios as data, tested to equal the built-in ones exactly.
- Orders can carry free text written by outsiders (`thirdPartyText`), shown by the order lookup.
- `docs/TAXONOMY.md`, generated from the data files, maps every attack to the OWASP Top 10 for LLM Applications 2025 and MITRE ATLAS.

### Why

Most earlier attacks came straight from the customer. Indirect injection is the case the literature cares most about, because text arriving through a tool looks trusted to the model. Shipping scenarios as data lets others add attacks without touching code.

### Alternatives rejected

| Option | Why not |
|---|---|
| Adding the new scenarios to set 2 | Experiments 01 and 02 are registered against set 2. Changing it mid-run would invalidate them. |
| Loading set 2 from JSON straight away | Later jobs load code from disk, so a mistake would have changed a running experiment. A test proves the two match instead. |
| Writing the OWASP and ATLAS ids from memory | They were read from the official sites on 31 October, and the ATLAS version is stated in the document. |
| A separate taxonomy file | It would drift. The mapping lives on each scenario and the document is generated. |

### What an interviewer might ask

**"Why does every attack map to LLM06 Excessive Agency?"** Every attack tries to make the agent use a tool it should not use for this customer. That is the shared root cause. The other mapping says how the attack gets there.

**"How do you know a scenario's expected refund is right?"** It is written by hand from the policy text, and the runner stops the scenario if the policy code disagrees. Two independent statements of the answer have to match.

**"Why does each attack need an honest counterpart?"** A defense that blocks anything mentioning a lawyer would look perfect on attacks. An honest angry customer who mentions a lawyer shows what that costs.

---

## Phase 3: an adaptive attacker (31 October 2026)

### What changed

The attacker now reports one technique per turn from a fixed list, kept in the transcript and recordings. A reply that is not the expected JSON is still used, and labelled "unlabelled" rather than given a guessed label. The report groups successes by the technique of the turn where the agent first tried an improper refund. Experiment 03 was registered: a model of a different family attacks each of two defenders, with stock and hardened prompts.

### Why

A scripted attacker cannot react, so a defense that passes it may only have passed those exact words. The pilot run suggested an adaptive attacker finds more. Whether that holds is what experiment 03 tests.

### Alternatives rejected

| Option | Why not |
|---|---|
| Clustering attack text with embeddings or a topic model | Needs another model, gives clusters someone must then name, and is harder to defend than a fixed list tied to the taxonomy. |
| Asking a separate model to judge each technique | Costs more of the free allowance. Instead, 20 labelled turns will be read by hand. |
| Same model family for attacker and defender | They might share blind spots. Different families where the free tier allows. |
| Testing `gpt-oss-20b` as a defender too | Not enough allowance. Stated in the protocol. |

### What an interviewer might ask

**"Isn't a label the attacker gives itself unreliable?"** Partly. That is why it is called the attacker's own account, and why a random sample is checked by hand and the agreement reported.

**"Why only 2 trials?"** The free allowance. It is a stress test that can show a large effect, and its intervals say so.

---

## Phase 4: comparing defenses (31 October 2026; results pending)

### What changed

- D3 spotlighting: customer messages and free-text order fields delivered in tags with a marker between words.
- D2 guard model: Llama Prompt Guard 2, scoring each customer message. Scores are saved next to the experiment.
- Replay (`src/defenses/replay.ts`): D2, D5, D6 and D7 and their combinations applied to recorded conversations.
- Experiment 02 was registered before any experiment 01 result was seen, including the exact rule for the words "eliminated", "reduced" and "no clear difference".
- A security and utility chart generated from the data.

### Why replay is valid, and the one main idea of this phase

A tool-boundary defense sees only refund attempts, and a guard sees only customer messages. Neither changes what the agent says before they act. So their effect on a recorded conversation can be computed exactly, up to the first block. This turned a compute problem into a cheap calculation: eight extra defense arms from the same conversations, at no model cost. A test shows that for a rule-based agent, replaying the policy engine gives exactly what running with it gives.

### The honest limit of replay

After a block at the tool boundary, the real agent or customer might have behaved differently. For D5's loss rate this does not matter, because no continuation can pass the check. For D6 and D7 it does: an attacker could adapt, so replay flatters them. Such trials are counted as "diverged", and one live D5 run checks the method.

### Early finding, before any experiment

Prompt Guard flags a blunt "ignore all previous instructions" at 0.9995, but scored the pilot's most successful attack, a fake system notice, at 0.023. At the usual 0.5 threshold it would pass. This is one example, not a result, and the threshold of 0.5 was fixed in the protocol anyway rather than tuned to catch it.

### Alternatives rejected

| Option | Why not |
|---|---|
| Running every defense live | Would need about 18 extra days of free allowance. |
| Tuning the guard's threshold on our own scenarios | That would be fitting the defense to the test. The threshold is pre-registered, and the scores are published so others can try different ones. |
| A single composite security score | Hides the trade-off the chart exists to show. |
| Testing replayed arms against D0 with a p-value | They are computed from the very same conversations, so the difference is a fact of arithmetic, not a sampling question. |
| D4 dual-LLM | Needs a new agent design and its own runs. Stated as not evaluated rather than dropped silently. |

### What an interviewer might ask

**"What's the difference between attack success and loss?"** Attack success means the agent tried. Loss means the money left. A tool-boundary defense leaves the first alone and removes the second, and the gap between them is the case for enforcing in code.

**"Why does a perfect reviewer appear in D6?"** It is the best case for human approval. The honest figure from D6 is how many approvals a person would face.

**"Why is D5 guaranteed but D1 isn't?"** D5 is ordinary code with no way to be persuaded. It checks three facts the model does not supply: who is signed in, what the record says, and what was already refunded. D1 is a request to a model.

**"Can D5 fail?"** Yes, if the records are wrong. It trusts them. That is in the threat model.

---

## Phase 5: generality (31 October 2026; models pending)

### What changed

Store credit runs as a second privileged tool through the same checkpoint, defenses and scoring (`--tool store-credit`). `docs/ADAPTERS.md` explains how to plug in an agent, a tool, a model provider or attacks.

### Why store credit

It is the smallest real proof: a different tool with no payment provider behind it, about 50 lines of rail. On the same scenarios with a rule-based agent the metrics are identical to refunds, which shows the scoring does not depend on PayPal. Unlike PayPal, the ledger will grant any positive amount, so only the checkpoint stands in the way.

### Not done

**Five models.** Groq's free tier offers three tool-calling models. Reaching five needs Ollama on this PC or another free provider, which is the owner's decision. This item of the definition of done is unmet, and the limitations say so.

### What an interviewer might ask

**"Why not changing an account's email?"** No dollar amount, so it needs a different score. Doing that properly is more work than the proof needs. The guide says what it would take.

---

## Phase 6: security documents (31 October 2026)

`docs/THREAT_MODEL.md`, `docs/LIMITATIONS.md` and `docs/RESPONSIBLE_USE.md`. The threat model separates a dishonest customer from a poisoned data source, because they cross different boundaries and different defenses apply. It also states what the hardened prompt gets wrong for indirect injection: it tells the agent to trust the order lookup, which is where such text arrives. That prompt stays as registered; changing it would change the experiment.

**"What's the single most important boundary?"** Agent to tool. The model's output is treated as an untrusted request, not a decision.

---

## Phase 7: engineering and presentation (31 October 2026; final results pending)

### What changed

- GitHub Actions: type check, lint, tests, smoke runs of both scenario sets, and a check that the taxonomy is current.
- `npm run reproduce` regenerates `RESULTS.md`, the chart and the taxonomy from recordings, then copies finished results into the README and report, so no result is typed by hand.
- Dashboard: compare two runs, filter runs and scenarios, see the chart, and step through any trial turn by turn.
- `docs/REPORT.md`, with related work read from the sources.

### Bugs and slips worth knowing about

- **Replay kept only the last trial** of each scenario, and a run on set 3 would have shown nothing, because the page only knew set 2's scenarios. Both are fixed; found by reading the code before changing it.
- **A CI failure of my own.** I fixed the wrong line for a lint warning, and my check showed only the last line of output, which hid the failure. The fix was to judge by the exit code. The lesson: check the result, not the look of the output.
- **Testing the dashboard without peeking.** The local copy would have shown unfinished experiment recordings, which the protocol says not to read early. The dashboard was tested on a copy holding only pilot runs and a synthetic run.

### Alternatives rejected

| Option | Why not |
|---|---|
| ESLint | Its TypeScript parser depends on the compiler version, and this project is on TypeScript 7. Biome does not. |
| A chart library | The chart must sit in a README, so it is a self-contained SVG with no script. |
| Pasting results into the README by hand | One stale number would undermine the rest. |

### What an interviewer might ask

**"How do I check your numbers?"** Clone the repository and run `npm run reproduce`. It needs no keys and makes no model calls, and it regenerates every table from the recordings. Or open any conversation on the dashboard and step through it.
