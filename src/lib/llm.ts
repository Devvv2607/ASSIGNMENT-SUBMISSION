import { anthropic } from "@ai-sdk/anthropic";
import { generateText, Output, type ModelMessage } from "ai";
import type { z } from "zod";
import { retry } from "./util";

/** All model choices live here so they can be swapped by env var. */
export const MODELS = {
  smart: process.env.MODEL_SMART || "claude-sonnet-5-5", // analysis, planning, debriefs
  fast: process.env.MODEL_FAST || "claude-haiku-5-5", // individual date turns
};

type Args<S extends z.ZodType> = {
  tier: keyof typeof MODELS;
  schema: S;
  system: string;
  prompt?: string;
  messages?: ModelMessage[];
  maxOutputTokens?: number;
  label?: string;
};

/** Structured-output call: Zod-validated object or throw (after retries). */
export async function llmObject<S extends z.ZodType>(a: Args<S>): Promise<z.infer<S>> {
  return retry(
    async () => {
      const res = await generateText({
        model: anthropic(MODELS[a.tier]),
        output: Output.object({ schema: a.schema }),
        system: a.system,
        ...(a.messages ? { messages: a.messages } : { prompt: a.prompt ?? "" }),
        maxOutputTokens: a.maxOutputTokens ?? 4000,
        maxRetries: 1,
      });
      return a.schema.parse(res.output) as z.infer<S>;
    },
    3,
    a.label ?? "llm",
  );
}
