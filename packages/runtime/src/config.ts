import type { LLMConfig } from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_FALLBACK_MODELS: string[] = [];

export function loadLLMConfig(): LLMConfig {
  const apiKey = process.env.LLM_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey) {
    throw new Error("Missing API key. Set LLM_API_KEY or ANTHROPIC_AUTH_TOKEN.");
  }

  const model = process.env.LLM_MODEL ?? process.env.CLAUDE_MODEL ?? DEFAULT_MODEL;
  const fallbackModels = (
    process.env.LLM_FALLBACK_MODELS ??
    process.env.CLAUDE_FALLBACK_MODELS ??
    DEFAULT_FALLBACK_MODELS.join(",")
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index && item !== model);

  return {
    baseUrl: process.env.LLM_BASE_URL ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL,
    model,
    fallbackModels,
    apiKey
  };
}
