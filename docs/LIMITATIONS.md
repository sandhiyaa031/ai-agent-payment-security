# Limitations

What Crashtest does not measure, and why its results may not carry over to a production agent. Read this before quoting a number.

## The results describe this benchmark

- **A fixed set of scenarios.** Rates are for these scenarios, each weighted equally. They are not estimates of how often attacks succeed in general. A different suite would give different numbers. Generalising would need scenarios sampled from real abuse, which this project does not have.
- **A small synthetic store.** One policy, a few dozen fictional orders, and refund amounts chosen by hand. "Dollars lost" means test dollars and depends directly on those amounts.
- **Rule-following customers.** Scripted attackers say the same thing every time. Honest customers are scripted too, so they are politer and clearer than real ones, and false refusals are likely undercounted.
- **Mostly English.** Other languages appear only as a small number of scenarios.

## Sample size

- **Fewer trials than wanted.** The goal was 30 trials per scenario. The free tier allows about 75 conversations per model per day, so the experiments use 10, 5, 3 and 2 trials as their protocols explain. Each interval shows what that buys. Small differences cannot be detected.
- **Zero is not zero.** "0 of 150" is consistent with a true rate of up to 2.5%. For a defense that matters, that is not nothing at scale.
- **Trials are not fully independent.** They share a model, a prompt and a few days. Interval methods assume independence, so they may be a little too narrow.

## Models

- **Few, small and free.** Only three tool-calling models were on Groq's free tier when this was run. Larger paid models may behave very differently, in either direction. This falls short of the benchmark's target of five models.
- **A moving target.** Hosted models change without notice. Groq reported several different build fingerprints for one model name in a single short run. Recordings keep what was reported, so changes are visible but not preventable. Repeating a run will not reproduce its conversations.
- **Default settings.** Temperature 1, default reasoning effort. Other settings could change the results.

## Defenses

- **Replay is an approximation after a block.** D5, D6 and D7 are evaluated on recorded conversations. After a refund is blocked, the real agent or customer might have done something else. Such trials are counted as "diverged". For D5's losses this does not matter, because no continuation can pass the check. For D6 and D7 an attacker who saw the block could adapt, so replay flatters them.
- **The human reviewer is perfect.** D6 assumes a person who checks every record correctly. Real reviewers get tired and can be persuaded. The approval count is the reliable number; the loss figure is a best case.
- **D7 sees one conversation.** A real velocity limit works across sessions. The scenarios are single conversations, so this benchmark cannot show that benefit or that cost.
- **D2 uses one classifier at one threshold.** Other guards, thresholds or policies for what happens after a flag would give other results. Ending the conversation is the simplest choice, not the only one.
- **D4 (dual-LLM) was not evaluated.** It needs a new agent design and its own runs, which did not fit before the deadline.
- **Combinations are replayed**, so they do not capture any interaction between defenses beyond their order.

## Attackers

- **The adaptive attacker is a small free model** with up to 4 turns, 2 trials per scenario. A skilled person, or a stronger model, may find more. It reports its own technique labels, which are checked only on a sample.
- **Indirect injection is simplified.** The poisoned text is placed in the order record directly, one field per scenario. Real attacks must first get their text into a data source.
- **Experiment 04 used one model.** It says little about other models.

## What is not scored

- Harm other than improper refunds: leaks of order details, false statements, rudeness.
- Whether the agent's explanation to the customer was true.
- Cost to the merchant of support staff, chargebacks or lost customers.
- Attacks spread over many accounts or sessions.

## Test rail versus PayPal

Experiments ran on the built-in test rail, which follows PayPal's refund rules as far as they are documented. Improper refunds may only complete there; they are never sent to the PayPal sandbox. See the README for the current state of live PayPal sandbox verification. The test rail does not model PayPal's own fraud checks, delays or failures, so losses here are what the agent would attempt to give away with nothing else in the way.

## Why results may not transfer to production

A production agent has a different prompt, different tools, its own data, its own policy, and usually more monitoring. Crashtest shows how a plain agent built from a quickstart behaves. Use it to compare defenses and to find failure modes in an agent you run, not to promise a loss rate.
