import { loadEnv } from "../src/config";
import { createModel, modelSettings } from "../src/llm";

/**
 * Proves the AI model in .env works for Crashtest: it must answer, and it must
 * be able to call a tool, because the agent under test refunds through one.
 */
async function main(): Promise<void> {
  loadEnv();
  // A setup check should report a used-up allowance, not sit it out.
  process.env["LLM_MAX_WAIT_MINUTES"] ??= "1";
  const settings = modelSettings("subject");
  console.log(`Provider: ${settings.provider}   Model: ${settings.model}`);
  const model = createModel("subject");

  console.log("1. Asking for a plain reply...");
  const hello = await model.start("Reply with the single word READY.", []).say("Are you there?");
  if (!hello.text) throw new Error("The model returned an empty reply.");
  console.log(`   OK   "${hello.text.slice(0, 60)}"`);

  console.log("2. Asking it to call a tool...");
  const turn = await model
    .start("You are a support agent. Use the tool to look up any order the customer mentions.", [
      {
        name: "get_order",
        description: "Look up an order by id.",
        parameters: {
          type: "object",
          properties: { order_id: { type: "string" } },
          required: ["order_id"],
          additionalProperties: false,
        },
      },
    ])
    .say("Where is my order ABC12345?");
  const call = turn.toolCalls[0];
  if (call?.name !== "get_order" || call.input?.["order_id"] !== "ABC12345") {
    throw new Error("The model answered without calling the tool correctly. Pick a model that supports tool calling.");
  }
  console.log("   OK   it called get_order with the right order id");
  console.log("\nModel check passed. You can now run: npm run crashtest -- --subject model");
}

main().catch(async (error: unknown) => {
  console.error(`\nModel check FAILED: ${error instanceof Error ? error.message : String(error)}`);
  await listModels();
  process.exitCode = 1;
});

/** On failure, show what the provider offers, since model names change often. */
async function listModels(): Promise<void> {
  try {
    const { baseUrl, apiKey } = modelSettings("subject");
    if (!baseUrl) return;
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!response.ok) return;
    const body = (await response.json()) as { data?: { id?: string }[] };
    const ids = (body.data ?? []).map((entry) => entry.id).filter(Boolean);
    if (ids.length > 0) {
      console.error(`\nModels this provider offers (set one as LLM_MODEL in .env):\n  ${ids.slice(0, 40).join("\n  ")}`);
    }
  } catch {
    // listing is a courtesy; the original error is what matters
  }
}
