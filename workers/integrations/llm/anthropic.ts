import type { LlmMessage, LlmOptions, LlmProvider, LlmResponse, ProviderConfig } from './types';

/**
 * Anthropic provider — Messages API (/v1/messages). System prompt is a
 * separate top-level field, not a message. baseUrl defaults to
 * https://api.anthropic.com/v1.
 */
export class AnthropicProvider implements LlmProvider {
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

  async chat(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse> {
    const base = this.config.baseUrl.replace(/\/$/, '') || 'https://api.anthropic.com/v1';
    const url = `${base}/messages`;
    const system = messages.find((m) => m.role === 'system')?.content;
    const turns = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model: options?.model ?? this.config.model,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
      temperature: options?.temperature ?? this.config.temperature,
      messages: turns,
    };
    if (system) body.system = system;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${this.config.name} (${res.status}): ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      model?: string;
      content?: { type: string; text?: string }[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const content = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return {
      content,
      model: data.model ?? this.config.model,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      finishReason: data.stop_reason ?? 'unknown',
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
