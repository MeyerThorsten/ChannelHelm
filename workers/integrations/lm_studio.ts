import 'dotenv/config';
import { hostname } from 'node:os';
import OpenAI from 'openai';

/**
 * Single shared LM Studio client. The OpenAI SDK is pointed at LM Studio's
 * OpenAI-compatible endpoint (or, when reachable, the OpenClaw routing proxy
 * which fronts multiple LM Studios across the fleet).
 *
 * Per-profile model selection (§5.5):
 *   fast_audio_only      → DEFAULT model (Qwen3 32B)
 *   standard_audio_visual → DEFAULT model (Qwen3 32B)
 *   premium_multimodal   → PREMIUM model (Qwen3 235B-A22B)
 */
const DEFAULT_BASE = process.env.LM_STUDIO_DEFAULT_HOST ?? 'http://m4max.local:1234/v1';
const PREMIUM_BASE = process.env.LM_STUDIO_PREMIUM_HOST ?? DEFAULT_BASE;
const OPENCLAW_BASE = process.env.OPENCLAW_BASE_URL;

export const DEFAULT_MODEL = process.env.LM_STUDIO_DEFAULT_MODEL ?? 'qwen/qwen3-32b';
export const PREMIUM_MODEL = process.env.LM_STUDIO_PREMIUM_MODEL ?? 'qwen/qwen3-235b-a22b-2507';

export type Profile = 'fast_audio_only' | 'standard_audio_visual' | 'premium_multimodal';

export function pickEndpoint(profile: Profile | string): {
  baseURL: string;
  model: string;
  host: string;
} {
  // Prefer OpenClaw when the operator has it configured — it knows which
  // physical box has spare VRAM for the requested model and routes us there.
  if (OPENCLAW_BASE) {
    return {
      baseURL: OPENCLAW_BASE,
      model: profile === 'premium_multimodal' ? PREMIUM_MODEL : DEFAULT_MODEL,
      host: OPENCLAW_BASE,
    };
  }
  if (profile === 'premium_multimodal') {
    return { baseURL: PREMIUM_BASE, model: PREMIUM_MODEL, host: PREMIUM_BASE };
  }
  return { baseURL: DEFAULT_BASE, model: DEFAULT_MODEL, host: DEFAULT_BASE };
}

export function client(baseURL: string): OpenAI {
  // LM Studio doesn't require an API key but the SDK insists on one being set.
  return new OpenAI({ baseURL, apiKey: 'lm-studio-local' });
}

export type ChatProvenance = {
  provider: 'lm-studio' | 'openclaw';
  model: string;
  host: string;
  prompt_version: string | null;
  input_refs: string[];
  generated_at: string;
  profile: string;
  input_tokens?: number;
  output_tokens?: number;
};

export type ChatResult = {
  text: string;
  provenance: ChatProvenance;
  raw: OpenAI.Chat.ChatCompletion;
};

/**
 * Convenience wrapper: one user-prompt completion, optional system prompt,
 * returns the text + a §2.2 provenance block ready to attach to an asset.
 */
export async function complete(opts: {
  profile: Profile | string;
  system?: string;
  user: string;
  promptVersion: string | null;
  inputRefs: string[];
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'text' | 'json_object';
}): Promise<ChatResult> {
  const ep = pickEndpoint(opts.profile);
  const oa = client(ep.baseURL);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.user });

  // Note: we deliberately do NOT send `response_format: {type: 'json_object'}`.
  // LM Studio's OpenAI-compatible API only accepts `json_schema` or `text`,
  // not OpenAI's `json_object`. The prompts already instruct "JSON only", and
  // the worker-side `parseJsonStrict` strips any stray markdown fences.
  const completion = await oa.chat.completions.create({
    model: ep.model,
    messages,
    temperature: opts.temperature ?? 0.5,
    max_tokens: opts.maxTokens ?? 1024,
  });

  const text = completion.choices[0]?.message?.content ?? '';
  const provider = OPENCLAW_BASE ? 'openclaw' : 'lm-studio';
  return {
    text,
    raw: completion,
    provenance: {
      provider,
      model: ep.model,
      host: provider === 'openclaw' ? ep.host : `${ep.host} @ ${hostname()}`,
      prompt_version: opts.promptVersion,
      input_refs: opts.inputRefs,
      generated_at: new Date().toISOString(),
      profile: String(opts.profile),
      input_tokens: completion.usage?.prompt_tokens,
      output_tokens: completion.usage?.completion_tokens,
    },
  };
}
