# Setup

Three stages, all free. Stage 1 needs no accounts and takes two minutes. Stages 2 and 3 can be done in either order.

Everything here uses the PayPal **sandbox**: a free practice copy of PayPal where the money is fake. The code has no way to reach PayPal's live system.

## Stage 1: run it offline

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
```

```bash
npm test
```

```bash
npm run demo
```

`npm run demo` runs every scenario against a built-in agent that refunds anyone who asks, on a pretend payment system. It runs twice: once with nothing in the way, where the agent loses almost everything, and once with the refund policy enforced in code, where the same attempts are stopped.

To watch the same thing in a browser, start the dashboard and open http://127.0.0.1:4173:

```bash
npm run dashboard
```

## Stage 2: connect the PayPal sandbox

PayPal renames dashboard menus from time to time, so a label below may differ slightly from what you see.

1. Go to [developer.paypal.com](https://developer.paypal.com) and log in, or sign up for free.
2. Open **Apps & Credentials** and make sure the toggle at the top says **Sandbox**, not Live.
3. Click **Create App**, give it any name, choose type **Merchant**, and create it.
4. On the app's page, copy the **Client ID** and the **Secret**.
5. On the same page, under features, make sure accepting payments, including card payments, is switched on, then save.
6. Open **Testing Tools > Credit Card Generator**, generate a Visa card, and note the number, expiry and CVV.
7. In the project folder, create a new file named exactly `.env` and paste in these lines:

   ```
   PAYPAL_CLIENT_ID=
   PAYPAL_CLIENT_SECRET=
   PAYPAL_TEST_CARD_NUMBER=
   PAYPAL_TEST_CARD_EXPIRY=
   PAYPAL_TEST_CARD_CVV=
   ```

8. Fill in the Client ID, the Secret and the card details after the `=` signs, with no spaces or quotes. Write the expiry as `YYYY-MM`, for example `2029-08`.

Then check it:

```bash
npm run paypal:check
```

This takes a $1.00 test payment, refunds $0.40, sends the same refund request again to confirm PayPal does not refund twice, and reads the result back from PayPal. If a step fails, it prints PayPal's own error message; the usual causes are a Live key instead of a Sandbox key, card payments not enabled on the app, or an expired test card.

Once it passes, run the scenarios on PayPal:

```bash
npm run crashtest -- --profile sandbox
```

You can see every payment and refund it creates by logging in at [sandbox.paypal.com](https://www.sandbox.paypal.com) with the sandbox **business** account listed under **Testing Tools > Sandbox Accounts**.

## Stage 3: test a real AI agent, for free

Crashtest works with any AI service that offers tool calling. These cost nothing:

| `LLM_PROVIDER` | Where to get a key | Notes |
|---|---|---|
| `groq` | [console.groq.com](https://console.groq.com) | Recommended. No card needed. Fast, with per-minute and per-day limits; Crashtest waits and retries when it hits them. |
| `openrouter` | [openrouter.ai](https://openrouter.ai) | Uses its free-model router. Which model answers can change from run to run. |
| `gemini` | [aistudio.google.com](https://aistudio.google.com) | Google's free tier. Daily limits vary by account. |
| `ollama` | [ollama.com](https://ollama.com) | Runs a model on your own computer. No key, no limits, but needs a capable machine. |

Free tiers change. If one stops being free or a model name is retired, switch `LLM_PROVIDER` or set `LLM_MODEL`; nothing else needs to change.

1. Create a free account with one provider and make an API key.
2. Add these two lines to `.env`:

   ```
   LLM_PROVIDER=groq
   LLM_API_KEY=
   ```

3. Paste the key after `LLM_API_KEY=`.

Then check it:

```bash
npm run llm:check
```

This asks the model for a reply and then for a tool call. If it fails, it prints the provider's error and the model names that provider currently offers.

Run an AI agent against the scripted attacks:

```bash
npm run crashtest -- --subject model
```

Let a second model play an attacker that changes tactics each turn:

```bash
npm run crashtest -- --subject model --attacker adaptive
```

Once Stage 2 is also done, test an agent that refunds through PayPal's own Agent Toolkit:

```bash
npm run crashtest -- --subject toolkit --profile sandbox
```

Add `--profile guarded` to either earlier command to see how enforcing the policy in code changes the result, or `--profile sandbox` to move the money on the PayPal sandbox. In the sandbox profile the policy is always enforced, so only refunds the policy owes are ever sent to PayPal. The dashboard offers the same choices in its menus once the keys are in `.env`; restart it after editing that file.

Free tiers also have a daily allowance for each model. On Groq in October 2026 it was 200,000 tokens and 1,000 requests a day per model, which was enough for one to three runs of all 22 scenarios at 3 trials, depending on the model. When it runs out, Crashtest does not fail: it prints a line saying it is waiting and carries on as the allowance refills, which can stretch a run from minutes to hours. Run one job per model at a time; two jobs on the same model share one allowance.

Optional `.env` lines:

- `LLM_MODEL` picks a different model from the same provider.
- `CRASHTEST_SUBJECT_MODEL` and `CRASHTEST_ATTACKER_MODEL` set the agent's and the attacker's models separately.
- `LLM_PROVIDER=custom` with `LLM_BASE_URL` and `LLM_MODEL` points at any other OpenAI-format service.
- `LLM_MAX_WAIT_MINUTES` sets how long one request may wait for a rate limit to clear before the scenario is recorded as an error. The default is 60.
- `LLM_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` uses Claude. That one is paid.

## Saving a run for others to watch

```bash
npm run crashtest -- --subject model --attacker adaptive --record first-real-run
```

This writes `recordings/first-real-run.json`. Recordings in that folder are part of the repository, and the dashboard lists them under **Saved runs** for anyone to replay, with no keys needed. Runs started from the dashboard are kept in `runs/`, which stays on your machine.

## Stage 4: host a public copy, for free

A hosted copy lets anyone open the dashboard with no setup. It runs only the built-in agents on the pretend payment system and replays the recordings in `recordings/`. It holds no keys, so it cannot spend anything or reach your PayPal sandbox.

1. Create a free account at [render.com](https://render.com) and connect your GitHub account.
2. Click **New**, then **Blueprint**.
3. Pick this repository. Render reads `render.yaml` and proposes one free web service called `crashtest`.
4. Click **Apply**. The first build takes a few minutes.
5. Open the address Render gives you.

The copy for this repository is at [crashtest-7wl9.onrender.com](https://crashtest-7wl9.onrender.com).

Do not add any keys to the hosted service. The free plan sleeps when idle, so the first visit after a pause takes up to a minute to load.

## Keeping keys safe

- Keys go only in `.env`. That file is listed in `.gitignore`, so git will not upload it.
- Never paste a key into a chat, an issue, or a commit.
- If a key does leak, delete it in that provider's dashboard and create a new one.
