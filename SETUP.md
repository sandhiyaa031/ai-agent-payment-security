# Setup

Three stages. Stage 1 needs no accounts and takes two minutes. Stages 2 and 3 can be done in either order.

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

`npm run demo` runs every scenario against two built-in agents on a pretend payment system. One agent refunds anyone who asks and loses almost everything; the other follows the policy and loses nothing.

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
   ANTHROPIC_API_KEY=
   ```

8. Fill in the Client ID, the Secret and the card details after the `=` signs, with no spaces or quotes. Write the expiry as `YYYY-MM`, for example `2029-08`. Leave `ANTHROPIC_API_KEY` empty until Stage 3.

Then check it:

```bash
npm run paypal:check
```

This takes a $1.00 test payment, refunds $0.40 and reads the refund back from PayPal. If a step fails, it prints PayPal's own error message; the usual causes are a Live key instead of a Sandbox key, card payments not enabled on the app, or an expired test card.

Once it passes, run the scenarios on PayPal:

```bash
npm run crashtest -- --rail paypal
```

You can see every payment and refund it creates by logging in at [sandbox.paypal.com](https://www.sandbox.paypal.com) with the sandbox **business** account listed under **Testing Tools > Sandbox Accounts**.

## Stage 3: test a real AI agent

1. Create an API key at [console.anthropic.com](https://console.anthropic.com). This one is paid: each full run makes a few dozen model calls.
2. Paste it into `.env` as `ANTHROPIC_API_KEY`.

Run a model-backed agent against the scripted attacks:

```bash
npm run crashtest -- --subject claude
```

Let a second model play an attacker that changes tactics each turn:

```bash
npm run crashtest -- --subject claude --attacker adaptive
```

Add `--rail paypal` to either command to move the money on the PayPal sandbox instead of the pretend system. The dashboard offers the same choices in its menus once the keys are in `.env`; restart it after editing that file.

Two optional lines in `.env` choose the models: `CRASHTEST_SUBJECT_MODEL` and `CRASHTEST_ATTACKER_MODEL`. Both default to `claude-opus-5-5`.

## Keeping keys safe

- Keys go only in `.env`. That file is listed in `.gitignore`, so git will not upload it.
- Never paste a key into a chat, an issue, or a commit.
- If a key does leak, delete it in the PayPal or Anthropic dashboard and create a new one.
