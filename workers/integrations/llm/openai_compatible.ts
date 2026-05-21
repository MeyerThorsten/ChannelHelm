import type { LlmMessage, LlmOptions, LlmProvider, LlmResponse, ProviderConfig } from './types';

/**
 * OpenAI-compatible provider — OpenAI, OpenRouter, Ollama, LM Studio,
 * OpenClaw. All expose /v1/chat/completions. Raw fetch (no SDK) so any
 * compatible endpoint works.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  constructor(private config: ProviderConfig) {}

  getName(): string {
    return this.config.name;
  }
  getModel(): string {
    return this.config.model;
  }
  getType(): string {
    return this.config.type;
  }

  private isLocal(): boolean {
    return (
      this.config.baseUrl.includes('localhost') ||
      this.config.baseUrl.includes('127.0.0.1') ||
      /\.local(:|\/|$)/.test(this.config.baseUrl)
    );
  }

  async chat(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;

    // Local models (LM Studio, Ollama) can take minutes on long generations.
    const timeoutMs = this.isLocal() ? 600_000 : 120_000;

    const body: Record<string, unknown> = {
      model: options?.model ?? this.config.model,
      messages,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
      temperature: options?.temperature ?? this.config.temperature,
    };
    if (this.isLocal()) {
      // Qwen3: skip <think> tokens (they bloat the context); damp repetition.
      body.enable_thinking = false;
      body.repetition_penalty = 1.08;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${this.config.name} (${res.status}): ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content ?? '',
      model: data.model ?? this.config.model,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      finishReason: choice?.finish_reason ?? 'unknown',
    };
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; model?: string }> {
    try {
      const r = await this.chat([{ role: 'user', content: 'ping — reply with "pong".' }], {
        maxTokens: 8,
        temperature: 0,
      });
      return { ok: true, model: r.model };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
