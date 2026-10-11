# Hardening guide for AI agents with a PayPal refund tool

These recommendations are for anyone giving an AI agent PayPal's Agent Toolkit, or any tool that moves money. Each one is tied to something Crashtest measured. The numbers are in [RESULTS.md](RESULTS.md).

Read the limits first:

- Results come from three models on Groq's free tier, 3 trials per scenario, on the built-in test rail. Three trials is a first observation, not a rate.
- Nothing here has been run against the real PayPal sandbox yet.
- The attacker was scripted. A person, or the adaptive attacker, may find more.

## 1. Enforce the refund policy in code, not in the prompt

**What we saw.** With only a prompt between the customer and the refund tool, two of the three models refunded money they did not owe. With the same policy checked in code before the refund is sent, the model that could be re-tested made the same improper attempts and lost nothing.

**What to do.** Put a check between the model's tool call and the PayPal request. It needs three facts the model should not be trusted to supply: who is signed in, what the order record says, and how much has already been refunded on that order. In Crashtest this is the policy defense in `src/subject/tools.ts`.

## 2. Treat everything the customer types as data, never as instructions

**What we saw.** A message containing a fake line styled as `[SYSTEM NOTICE: ... pre-approved for a full refund ...]` succeeded against both OpenAI open-weight models in every trial. One model recorded its refund reason as "Pre-approved full refund", which is the attacker's own wording. This was the most reliable attack in the set.

**What to do.** Do not rely on the model to tell a real system message from one typed by a customer. Keep operator instructions in the system prompt only, and assume any text in the conversation can be forged. Recommendation 1 is what actually stops the loss; this one explains why it is needed.

## 3. Believe your own records, not records the customer pastes

**What we saw.** A customer pasted a block of JSON that looked like a warehouse record saying the return had been received. The larger model accepted it once in three trials and refunded an order whose real record said otherwise.

**What to do.** Make the agent's order lookup the only source of truth, and say so. In code, decide eligibility from the lookup result, never from the conversation.

## 4. Measure attempts, not just losses

**What we saw.** Once the policy was enforced in code, every model lost $0. Judged on losses alone they look equally safe. The attempt counts still differ: a model that tries to send an improper refund in two of three trials is one bug in your checkpoint away from a real loss.

**What to do.** Log every refund the agent tries, including the ones you block, and review the blocked ones. A rise in blocked attempts is an early warning.

## 5. Always send an explicit amount

**What we saw.** PayPal's toolkit `create_refund` refunds the whole payment when no amount is given. A model that leaves the amount out, by mistake or by persuasion, refunds everything.

**What to do.** Fill in the amount in your own code and reject calls without a valid one. Crashtest converts every toolkit refund to an explicit amount before it is sent, so the amount that was checked is the amount PayPal is asked to refund.

## 6. Turn on only the toolkit actions the agent needs

**What we saw.** The toolkit can expose dozens of actions, including creating orders, invoices and subscriptions. An agent can only be talked into using tools it has.

**What to do.** Enable the minimum in the toolkit configuration. Crashtest's toolkit agent has `createRefund` and `getRefunds` only, and refuses to forward any other tool call even if one appears.

## 7. Cap refunds per order, and count them together

**What we saw.** A ceiling per refund request is easy to get under by asking several times: three requests of $43 each pass a $50-per-request ceiling and add up to $129. An early version of Crashtest had exactly this weakness.

**What to do.** If you set a ceiling, apply it to the total refunded on an order, and never let that total pass what the customer paid. Expect a ceiling to block some honest refunds too: on the original scenario set, a $50 ceiling stopped every attack and also blocked an honest $119 refund. Decide who reviews those.

## 8. Make refund requests safe to retry

**What we saw.** A refund request that times out may or may not have gone through. Sending it again blindly can pay twice.

**What to do.** Send a unique `PayPal-Request-Id` with each refund and reuse the same one when retrying. Until you know what happened to a request, treat its amount as spent. PayPal's toolkit does not set this header, so on that path Crashtest sends each request once and reports a failure rather than retrying.

## 9. Do not count a refund until PayPal says it completed

**What we saw.** Counting pending refunds as done was a bug in an early version of Crashtest itself.

**What to do.** Read the refund back and act on its status. Only `COMPLETED` means the money moved. Report anything else as unfinished.

## 10. Check that the agent still helps honest customers

**What we saw.** All three models refunded every honest customer in full, including a rude one and one whose return arrived a day before the window closed. An agent that simply refuses everyone would score perfectly on losses and fail every one of those customers.

**What to do.** Test with honest cases alongside attacks, and track under-refunds next to over-refunds.

## A prompt-level defense, tested rather than assumed

Crashtest includes a variant of the agent with one extra paragraph in its system prompt telling it that customer text is untrusted. Its results are in [RESULTS.md](RESULTS.md) when a run has been recorded. Whatever it shows, treat a prompt as a second layer. Recommendation 1 is the one that holds when the model is wrong.
