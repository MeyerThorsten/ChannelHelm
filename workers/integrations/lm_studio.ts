import 'dotenv/config';
import { hostname } from 'node:os';
import { getProvider } from './llm/get_provider';
import type { LlmMessage } from './llm/types';

/**
 * LLM entry point for the pipeline. `complete()` resolves a configured
 * provider (via the llm_providers table; falls back to env LM Studio) by the
 * package's processing profile, calls it, and returns the text plus a §2.2
 * provenance block. Provider selection lives in ./llm — this file is just the
 * convenience wrapper the workers call.
 *
 * Per-profile routing (§5.5): a provider whose `purpose` matches the profile
 * is preferred; otherwise the default/`all` provider is used.
 */
export type Profile = 'fast_audio_only' | 'standard_audio_visual' | 'premium_multimodal';

export type ChatProvenance = {
  provider: string; // provider name, e.g. "LM Studio (env)", "OpenAI", "Claude"
  provider_type: string; // 'openai-compatible' | 'anthropic'
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
};

export async function complete(opts: {
  profile: Profile | string;
  system?: string;
  user: string;
  promptVersion: string | null;
  inputRefs: string[];
  maxTokens?: number;
  temperature?: number;
  /** Accepted for back-compat; ignored (we never send json_object). */
  responseFormat?: 'text' | 'json_object';
}): Promise<ChatResult> {
  const provider = await getProvider(String(opts.profile));
  const messages: LlmMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.user });

  const res = await provider.chat(messages, {
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
  });

  return {
    text: res.content,
    provenance: {
      provider: provider.getName(),
      provider_type: provider.getType(),
      model: res.model,
      host: hostname(),
      prompt_version: opts.promptVersion,
      input_refs: opts.inputRefs,
      generated_at: new Date().toISOString(),
      profile: String(opts.profile),
      input_tokens: res.inputTokens,
      output_tokens: res.outputTokens,
    },
  };
}
