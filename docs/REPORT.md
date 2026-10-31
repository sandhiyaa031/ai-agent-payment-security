# Crashtest: measuring what an AI support agent can be talked out of, and which defenses stop it

*Workshop-style report. The tables between result markers are inserted from the recordings by `npm run reproduce`; none are typed by hand.*

## Abstract

An AI support agent with a refund tool can move money, and everything a customer types reaches the model that decides whether to. We present Crashtest, an open benchmark that sends dishonest customers at such an agent and measures two things separately: what the agent attempts beyond policy, and what actually leaves the account, read back from the payment rail. Honest customers are included, so that refusing everyone cannot win. We pre-registered four experiments covering seven defenses, an adaptive attacker and a taxonomy-mapped attack suite. Experiments ran on free-tier models with test money, so samples are small and every result carries an interval.

<!-- results:abstract:start -->
*Headline findings will be added here once the pre-registered runs finish.*
<!-- results:abstract:end -->

## 1. Motivation

Payment providers now ship toolkits that let an AI agent issue refunds directly. PayPal's Agent Toolkit is one example. The obvious way to build a support agent with one is to give a model the refund tool and tell it the policy in its prompt. That places the only control over the money inside the component that reads text written by the people who want the money.

Three questions matter to anyone building this. How often can such an agent be talked into an improper refund? Which defenses help, and do they stop the loss or only make it rarer? What do those defenses cost honest customers, who are the point of having a support agent at all?

Measuring only attack success answers none of these well. An attempt blocked in code cost nothing but shows the agent would have given the money away. A loss rate alone rewards an agent that refuses everyone. Crashtest keeps attempts, completed losses and service to honest customers apart.

## 2. Related work

**Benchmarks for agent security.** AgentDojo [1] is an extensible environment of 97 realistic tasks and 629 security test cases for tool-using agents, focused on prompt injection through data returned by tools. It reports that attacks succeed against the best agents in under 25% of cases and fall further with a secondary detector. InjecAgent [2] measures indirect prompt injection across 1,054 test cases, 17 user tools and 62 attacker tools, and finds ReAct-prompted GPT-4 vulnerable 24% of the time. Agent Security Bench [3] covers 10 scenarios, over 400 tools and 27 attack and defense methods, with an average attack success rate reaching 84.30% and limited effect from existing defenses. ToolEmu [4] uses a model to emulate tools so that agents can be tested for risky behaviour without building each environment.

Crashtest is much narrower, and deliberately so. It looks at one high-stakes action, a refund, in depth. It differs in four ways: the score comes from the payment system's own records rather than from a judge reading the transcript; each attack has an independently hand-written expected refund, checked against the policy code on every run; honest customers are first-class, so false refusals are measured beside losses; and experiments are pre-registered, with intervals and a stopping rule.

**Defenses.** Spotlighting [5] marks untrusted text so a model can tell it from instructions; its authors report attack success falling from over 50% to under 2% in their setting. We test its datamarking form. The dual-LLM pattern [6] keeps raw untrusted text away from the model that can call tools. CaMeL [7] goes further, extracting control flow from the trusted query so that untrusted data cannot change it, and enforcing capabilities at tool calls; on AgentDojo it solves 77% of tasks with provable security against 84% undefended. Our policy engine is a much simpler instance of the same idea: enforce at the tool boundary, in code, whatever the model was persuaded of.

## 3. Method

**System under test.** A support agent for a fictional store has two tools: look up an order, and refund it. Its prompt contains a four-rule refund policy. Every refund attempt, from every agent, passes one checkpoint in code, which logs it and applies a safety envelope (always on) and any defense under evaluation. Improper refunds may only complete on a built-in test rail. On a real provider the policy defense cannot be switched off.

**Threat model.** A dishonest customer controls what they type. A poisoned data source controls free text the agent reads, such as checkout notes or carrier text. Neither controls who is signed in or the store's structured order fields. Details are in [THREAT_MODEL.md](THREAT_MODEL.md).

**Scenarios.** Set 2 has 15 attacks and 7 honest customers. Set 3 adds 22 attacks and 9 honest counterparts: indirect injection through six data sources, multi-turn escalation, salami refunds, tool-argument manipulation, authority impersonation, obfuscation and cross-customer claims. All are mapped to the OWASP Top 10 for LLM Applications 2025 and MITRE ATLAS in [TAXONOMY.md](TAXONOMY.md). Each order carries a hand-written expected refund, and the runner stops a scenario if the policy code disagrees.

**Outcomes.** Attack success: an attack trial with at least one improper refund attempt, completed or not. Loss: an attack trial in which completed refunds exceeded what was owed, read from the rail. Honest orders paid in full, under-refund share, refusals, unresolved trials, and tokens per conversation are reported alongside. Pending refunds are never counted as refunded or as safe.

**Attackers.** A scripted attacker sends fixed messages and is the reproducible baseline. An adaptive attacker is a model of a different family from the agent; it sees the agent's replies, changes tactics over up to 4 turns, and reports which technique it used each turn.

**Defenses.** D1, a hardened prompt. D2, a guard model (Llama Prompt Guard 2) that ends a conversation at the first flagged customer message. D3, spotlighting by datamarking. D5, a policy engine at the tool boundary, which allows a refund only if it and earlier refunds stay within what the store's records entitle the signed-in customer to. D6, human approval above a threshold, with an assumed perfect reviewer. D7, a velocity limit per conversation. D0 is no defense. D4, the dual-LLM pattern, was not evaluated.

**Replay.** D2, D5, D6 and D7 act only on what crosses a boundary and do not change what the agent says before they act, so they can be applied to recorded conversations without running the models again. This let every replayed defense use the full sample. A guard stop ends the conversation, so it is exact. A block at the tool boundary is exact up to the block; afterwards the real conversation might have differed, and such trials are reported as diverged. One live run checks the replay.

**Statistics.** Rates carry Wilson 95% intervals. They describe this fixed set of scenarios, each weighted equally, not attacks in general. Differences carry Newcombe's interval. Comparisons use a permutation test that shuffles labels within each scenario, with Holm's adjustment across models. Fisher's exact test on pooled counts is shown for comparison. Dollar figures use a scenario-stratified bootstrap. The first half of each baseline run is compared with its second half as an A/A check, and the test's false-positive rate is checked by simulation.

**Pre-registration.** Each experiment's hypotheses, sample size, analysis and stopping rule were committed to the repository before its runs, and each run records the protocol's SHA-256. Reports show only progress until a run reaches its fixed size or cutoff. The wording of the headline ("eliminated", "reduced", "no clear difference") was fixed in advance. Every run pins temperature, seed, and the hashes of the prompt and tool definitions, and records what the provider reported serving.

**Sample sizes.** All models ran on a free tier allowing about 75 conversations per model per day. This set N at 10 trials per scenario for experiment 01, 5 for spotlighting, 3 for the attack suite and 2 for the adaptive attacker.

## 4. Results

### 4.1 Baseline rates and a hardened prompt

<!-- results:e01:start -->
*Inserted when experiment 01 finishes.*
<!-- results:e01:end -->

### 4.2 Comparing defenses

<!-- results:e02:start -->
*Inserted when experiment 02 finishes.*
<!-- results:e02:end -->

### 4.3 The adaptive attacker

<!-- results:e03:start -->
*Inserted when experiment 03 finishes.*
<!-- results:e03:end -->

### 4.4 Indirect injection and the wider suite

<!-- results:e04:start -->
*Inserted when experiment 04 finishes.*
<!-- results:e04:end -->

## 5. Discussion

<!-- results:discussion:start -->
*To be written from the results above, using the wording rules fixed in the protocols.*
<!-- results:discussion:end -->

## 6. Limitations

The full list is in [LIMITATIONS.md](LIMITATIONS.md). The most important: results describe a fixed synthetic suite, not attacks in general; samples are small because of free-tier limits; only three models were tested, all small, which falls short of the benchmark's own target of five; hosted models can change without notice; replay flatters D6 and D7, whose real effect an adapting attacker could reduce; the human reviewer in D6 is assumed perfect; the adaptive attacker is a small free model; and experiments ran on the built-in test rail, not on PayPal.

## 7. Conclusion

<!-- results:conclusion:start -->
*To be written once the results are in.*
<!-- results:conclusion:end -->

All code, data, protocols and recordings are at <https://github.com/sandhiyaa031/ai-agent-payment-security>, and recorded conversations can be replayed at <https://crashtest-7wl9.onrender.com>.

## References

1. E. Debenedetti et al. [AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents](https://proceedings.neurips.cc/paper_files/paper/2024/hash/97091a5177d8dc64b1da8bf3e1f6fb54-Abstract.html). NeurIPS 2024, Datasets and Benchmarks.
2. Q. Zhan, Z. Liang, Z. Ying, D. Kang. [InjecAgent: Benchmarking Indirect Prompt Injections in Tool-Integrated Large Language Model Agents](https://github.com/uiuc-kang-lab/InjecAgent). Findings of ACL 2024.
3. H. Zhang et al. [Agent Security Bench (ASB): Formalizing and Benchmarking Attacks and Defenses in LLM-based Agents](https://proceedings.iclr.cc/paper_files/paper/2025/hash/5750f91d8fb9d5c02bd8ad2c3b44456b-Abstract-Conference.html). ICLR 2025.
4. Y. Ruan et al. [Identifying the Risks of LM Agents with an LM-Emulated Sandbox](https://arxiv.org/abs/2309.15817). arXiv 2309.15817.
5. K. Hines et al. [Defending Against Indirect Prompt Injection Attacks With Spotlighting](https://arxiv.org/abs/2403.14720). arXiv 2403.14720.
6. S. Willison. [The Dual LLM pattern for building AI assistants that can resist prompt injection](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/). 25 April 2023.
7. E. Debenedetti et al. [Defeating Prompt Injections by Design](https://arxiv.org/abs/2503.18813). arXiv 2503.18813.
8. L. Newcombe. Interval estimation for the difference between independent proportions: comparison of eleven methods. Statistics in Medicine, 1998.
