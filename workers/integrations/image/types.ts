/**
 * Image-generation provider abstraction — the sister of the LLM provider
 * layer (`workers/integrations/llm`). Kept separate because text-to-image
 * APIs don't share the chat interface. First implementation is Runware
 * (modeled on DojoClaw's runware-client); the abstraction leaves room for
 * OpenAI gpt-image / others later.
 */

export type ImageGenRequest = {
  prompt: string;
  negativePrompt?: string;
  /** Pixels. Providers may round to a supported multiple (Runware → /64). */
  width?: number;
  height?: number;
  numberResults?: number;
};

export type ImageGenResult = {
  /** Remote URL the provider hosts the result at (download before use). */
  imageUrl: string;
  /** Provider-reported generation cost in USD, when available. */
  cost?: number;
  model: string;
};

export type ImageProviderConfig = {
  name: string;
  type: string; // 'runware'
  baseUrl: string;
  apiKey: string;
  model: string;
};

export interface ImageProvider {
  /** Generate one or more images. Returns remote URLs (caller downloads). */
  generateImages(req: ImageGenRequest): Promise<ImageGenResult[]>;
  /** Cheap reachability/auth check (does not spend image credits). */
  testConnection(): Promise<{ ok: boolean; error?: string }>;
  getName(): string;
  getModel(): string;
  getType(): string;
}
