# Responsible use

Crashtest sends deceptive messages at an AI agent to see what it will do. Use it only on systems you are allowed to test.

- **Test agents you own, or have written permission to test.** Do not point it at another company's support chat, however public that chat is. Tricking a live system into giving a refund is fraud, even if you call it a test.
- **Use test money only.** Improper refunds may complete only on the built-in test rail. The code refuses any PayPal host except the sandbox, and on a real provider the policy defense cannot be switched off. Do not remove these guards.
- **Keep keys out of the repository and out of recordings.** They belong in `.env`, which git ignores.
- **Respect each provider's terms and rate limits.** Attack prompts sent to a model are still subject to its usage policy. The attacker here role-plays a customer in an authorised test of a fictional store.
- **Report what you find to the people who run the system, privately, and give them time to fix it.** Attack scripts from this project are aimed at a fictional store; do not adapt them against real ones.
- **Do not put real customers' data in scenarios.** Scenario files are shared. Use made-up names, emails and orders.

The results describe a benchmark, not a guarantee. A passing score does not mean an agent is safe. See [LIMITATIONS.md](LIMITATIONS.md).
