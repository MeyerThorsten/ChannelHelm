/**
 * LLM provider abstraction — a unified interface across providers, modeled
 * on DojoClaw's src/lib/llm. ChannelHelm only needs non-streaming chat for
 * the pipeline + a connection test for the settings UI.
 */

export type LlmMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type LlmResponse = {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
};

export type LlmOptions = {
  maxTokens?: number;
  temperature?: number;
  model?: string;
};

export interface LlmProvider {
  chat(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse>;
  testConnection(): Promise<{ ok: boolean; error?: string; model?: string }>;
  getName(): string;
  getModel(): string;
  getType(): string;
}

export type ProviderConfig = {
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
};
