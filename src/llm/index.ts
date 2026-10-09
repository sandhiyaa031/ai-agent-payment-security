import { AnthropicModel, DEFAULT_ANTHROPIC_MODEL } from "./anthropic";
import type { ChatModel } from "./model";
import { OpenAiCompatibleModel } from "./openai-compatible";

interface Preset {
  baseUrl: string;
  model: string;
  needsKey: boolean;
}

/** Providers with a free tier at the time of writing, plus a local option. */
const PRESETS: Record<string, Preset> = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", needsKey: true },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free", needsKey: true },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", needsKey: true },
  ollama: { baseUrl: "http://localhost:11434/v1", model: "llama3.1", needsKey: false },
};

const env = (name: string) => process.env[name]?.trim() || undefined;

/** The provider in use: LLM_PROVIDER if set, otherwise Anthropic when its key is present. */
export function providerName(): string | undefined {
  return env("LLM_PROVIDER")?.toLowerCase() ?? (env("ANTHROPIC_API_KEY") ? "anthropic" : undefined);
}

/** Whether a model is ready to use. Reports presence only, never values. */
export function modelConfigured(): boolean {
  const provider = providerName();
  if (!provider) return false;
  if (provider === "anthropic") return Boolean(env("ANTHROPIC_API_KEY"));
  if (provider === "custom") return Boolean(env("LLM_BASE_URL") && env("LLM_MODEL"));
  const preset = PRESETS[provider];
  return preset !== undefined && (!preset.needsKey || Boolean(env("LLM_API_KEY")));
}

export interface ModelSettings {
  provider: string;
  model: string;
  /** Absent for Anthropic, which uses its own SDK. */
  baseUrl?: string;
  apiKey?: string;
}

/** Resolves .env into concrete settings. The role only decides which model-name override applies. */
export function modelSettings(role: "subject" | "attacker"): ModelSettings {
  const provider = providerName();
  const override = env(role === "subject" ? "CRASHTEST_SUBJECT_MODEL" : "CRASHTEST_ATTACKER_MODEL") ?? env("LLM_MODEL");
  const known = [...Object.keys(PRESETS), "custom", "anthropic"].join(", ");

  if (!provider) {
    throw new Error(`No AI model is set up. Add LLM_PROVIDER (one of: ${known}) and LLM_API_KEY to .env (see SETUP.md).`);
  }
  if (provider === "anthropic") return { provider, model: override ?? DEFAULT_ANTHROPIC_MODEL };

  const preset = provider === "custom" ? undefined : PRESETS[provider];
  if (provider !== "custom" && !preset) {
    throw new Error(`Unknown LLM_PROVIDER "${provider}". Use one of: ${known}.`);
  }
  const baseUrl = env("LLM_BASE_URL") ?? preset?.baseUrl;
  const model = override ?? preset?.model;
  const apiKey = env("LLM_API_KEY");
  if (!baseUrl || !model) throw new Error("LLM_PROVIDER=custom needs LLM_BASE_URL and LLM_MODEL in .env.");
  if ((preset?.needsKey ?? false) && !apiKey) {
    throw new Error(`LLM_API_KEY is not set. Add your ${provider} key to .env (see SETUP.md).`);
  }
  return { provider, model, baseUrl, apiKey };
}

export function createModel(role: "subject" | "attacker"): ChatModel {
  const settings = modelSettings(role);
  if (settings.baseUrl === undefined) return new AnthropicModel(settings.model);
  return new OpenAiCompatibleModel({
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
  });
}
