import { z } from "zod";
import { db } from "./db";

/** All model choices live here so they can be swapped by env var. Provider: Groq (OpenAI-compatible API). */
export const MODELS = {
  smart: process.env.MODEL_SMART || "openai/gpt-oss-120b", // analysis, planning, debriefs
  fast: process.env.MODEL_FAST || "openai/gpt-oss-20b", // individual date turns
  vision: process.env.MODEL_VISION || "qwen/qwen3.8-27b", // Instagram photos, max 3 per request
};
export const MAX_IMAGES_PER_VISION_CALL = 3;

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// ---------- Global concurrency cap (per process) ----------

const MAX_CONCURRENT = 3;
let active = 0;
const waiters: (() => void)[] = [];
async function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((r) => waiters.push(r));
  active++;
}
function release() {
  active--;
  waiters.shift()?.();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Low-level call with 429/5xx backoff ----------

type Content = string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];
type Msg = { role: "system" | "user" | "assistant"; content: Content };
type Usage = { prompt_tokens: number; completion_tokens: number };

export class LlmError extends Error {}

async function groq(model: string, messages: Msg[], maxTokens: number, reasoning: boolean): Promise<{ text: string; usage: Usage }> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new LlmError("Missing GROQ_API_KEY");
  const body: Record<string, unknown> = { model, messages, response_format: { type: "json_object" }, max_completion_tokens: maxTokens, temperature: 0.7 };
  if (reasoning) body.reasoning_effort = "low"; // gpt-oss: keep hidden reasoning short to save tokens

  for (let attempt = 0; ; attempt++) {
    await acquire();
    let res: Response;
    try {
      res = await fetch(GROQ_URL, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      release();
      if (attempt >= 4) throw new LlmError(`Groq network error: ${(e as Error).message}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    release();
    if (res.ok) {
      const j = await res.json();
      return { text: j.choices?.[0]?.message?.content ?? "", usage: j.usage ?? { prompt_tokens: 0, completion_tokens: 0 } };
    }
    const errText = await res.text();
    // Groq's JSON mode rejects invalid model JSON with a 400 json_validate_failed: surface it for the repair retry.
    if (res.status === 400 && errText.includes("json_validate_failed")) {
      const failed = (() => {
        try {
          return JSON.parse(errText).error?.failed_generation ?? "";
        } catch {
          return "";
        }
      })();
      throw new InvalidJson("Model returned invalid JSON", failed);
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 7) throw new LlmError(`Groq ${res.status} (${model}): ${errText.slice(0, 300)}`);
    const after = Number(res.headers.get("retry-after"));
    await sleep(Math.min(60_000, (after > 0 ? after * 1000 : 0) + 1000 * 2 ** attempt + Math.random() * 500));
  }
}

class InvalidJson extends Error {
  constructor(msg: string, public raw: string) {
    super(msg);
  }
}

// ---------- Usage logging (real cost numbers for the README) ----------

export type UsageTag = { person_id?: string; date_id?: string; step: string };

async function logUsage(model: string, u: Usage, tag?: UsageTag) {
  if (!tag) return;
  await db().from("llm_usage").insert({ model, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, person_id: tag.person_id ?? null, date_id: tag.date_id ?? null, step: tag.step });
}

// ---------- Structured output ----------

type Args<S extends z.ZodType> = {
  tier: keyof typeof MODELS;
  schema: S;
  system: string;
  user: Content;
  maxOutputTokens?: number;
  tag?: UsageTag;
};

/** JSON-mode call validated by Zod. On invalid JSON / schema failure, retries once with the error appended. */
export async function llmObject<S extends z.ZodType>(a: Args<S>): Promise<z.infer<S>> {
  const model = MODELS[a.tier];
  const schemaJson = JSON.stringify(z.toJSONSchema(a.schema, { io: "input" }));
  const messages: Msg[] = [
    { role: "system", content: `${a.system}\n\nRespond with ONLY a JSON object that conforms to this JSON Schema (no prose, no markdown):\n${schemaJson}` },
    { role: "user", content: a.user },
  ];
  const reasoning = a.tier !== "vision";
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw = "";
    let problem: string;
    try {
      const { text, usage } = await groq(model, messages, a.maxOutputTokens ?? 2000, reasoning);
      await logUsage(model, usage, a.tag);
      raw = text;
      const parsed = a.schema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data as z.infer<S>;
      problem = z.prettifyError(parsed.error);
    } catch (e) {
      if (e instanceof InvalidJson) {
        raw = e.raw;
        problem = "Output was not valid JSON.";
      } else if (e instanceof SyntaxError) {
        problem = `Output was not valid JSON: ${e.message}`;
      } else throw e;
    }
    if (attempt === 0) {
      messages.push({ role: "assistant", content: raw.slice(0, 6000) || "(empty)" });
      messages.push({ role: "user", content: `That response failed validation:\n${problem}\nReturn the corrected JSON object only.` });
    } else {
      throw new LlmError(`${model} returned output that failed validation twice: ${problem.slice(0, 400)}`);
    }
  }
  throw new LlmError("unreachable");
}
