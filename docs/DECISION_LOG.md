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
