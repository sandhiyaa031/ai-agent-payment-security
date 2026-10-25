import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sha256 } from "../manifest";

/**
 * D2: a guard model that screens each customer message before the agent sees
 * it, and ends the conversation at the first message it flags.
 *
 * The guard used here is Meta's Llama Prompt Guard 2 (86M parameters), a
 * classifier trained to spot prompt injection and jailbreak attempts, served
 * free by Groq. It returns the probability that a text is an attack.
 */
export interface GuardModel {
  readonly label: string;
  /** Probability, from 0 to 1, that the text is an attack. */
  score(text: string): Promise<number>;
}

export const PROMPT_GUARD_MODEL = "meta-llama/llama-prompt-guard-2-86m";

/** A classifier served through an OpenAI-format chat endpoint that answers with a probability as text. */
export class ChatClassifierGuard implements GuardModel {
  readonly label: string;

  constructor(
    private readonly options: {
      baseUrl: string;
      model: string;
      apiKey?: string;
      fetchImpl?: typeof fetch;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    this.label = options.model;
  }

  async score(text: string): Promise<number> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetchImpl(`${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.options.model, messages: [{ role: "user", content: text }] }),
      });
      const body = (await response.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
      if (response.status === 429 && attempt < 10) {
        const wait = Number(response.headers.get("retry-after"));
        await sleep((Number.isFinite(wait) && wait > 0 ? wait : 2 ** attempt) * 1000);
        continue;
      }
      if (!response.ok) throw new Error(`${this.label} failed (${response.status}): ${body.error?.message ?? response.statusText}`);
      const value = Number(body.choices?.[0]?.message?.content);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`${this.label} did not answer with a probability: ${JSON.stringify(body.choices?.[0]?.message?.content)}`);
      }
      return value;
    }
  }
}

/**
 * Guard scores keyed by the SHA-256 of each message, kept in a file next to
 * the experiment so the analysis can be repeated without calling the guard
 * again. Only scenario messages are scored; they hold no personal data.
 */
export class ScoreBook {
  private readonly scores: Record<string, number>;

  constructor(private readonly path: string) {
    this.scores = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { scores: Record<string, number> }).scores : {};
  }

  get(text: string): number | undefined {
    return this.scores[sha256(text)];
  }

  async scoreAll(texts: string[], guard: GuardModel, onProgress?: (done: number, total: number) => void): Promise<void> {
    const missing = [...new Set(texts)].filter((text) => this.get(text) === undefined);
    for (const [index, text] of missing.entries()) {
      this.scores[sha256(text)] = await guard.score(text);
      // Saved as it goes, so an interrupted pass loses nothing.
      if (index % 25 === 24 || index === missing.length - 1) this.save(guard.label);
      onProgress?.(index + 1, missing.length);
    }
  }

  private save(model: string): void {
    const sorted = Object.fromEntries(Object.entries(this.scores).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(this.path, `${JSON.stringify({ model, scores: sorted }, null, 1)}\n`);
  }
}

/** Indexes of the customer messages the guard flags at this threshold. */
export function flaggedTurns(messages: string[], book: ScoreBook, threshold: number): Set<number> {
  const flagged = new Set<number>();
  messages.forEach((message, index) => {
    const score = book.get(message);
    if (score === undefined) throw new Error("A message has no guard score yet. Run the scoring step first.");
    if (score >= threshold) flagged.add(index);
  });
  return flagged;
}
