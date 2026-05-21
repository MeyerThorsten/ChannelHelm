/**
 * Fetch the available model ids from a provider, so the operator can pick one
 * instead of typing it. Mirrors DojoClaw's /api/providers/models.
 *
 *   openai-compatible → GET {baseUrl}/models  (LM Studio, OpenAI, Ollama, …)
 *   anthropic         → GET {baseUrl}/models  (Messages API models endpoint)
 *
 * Best-effort: on any failure returns a small static fallback so the UI still
 * offers something. `fallback: true` flags that case.
 */
export async function fetchAvailableModels(opts: {
  type: string;
  baseUrl: string;
  apiKey: string;
}): Promise<{ models: string[]; fallback?: boolean }> {
  const baseUrl = opts.baseUrl.trim().replace(/\/$/, '');
  if (!baseUrl) throw new Error('baseUrl required');

  try {
    const url = `${baseUrl}/models`;
    const headers: Record<string, string> = {};
    if (opts.type === 'anthropic') {
      headers['x-api-key'] = opts.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (opts.apiKey) {
      headers.authorization = `Bearer ${opts.apiKey}`;
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { models: defaultModels(opts.type, baseUrl), fallback: true };

    const data = (await res.json()) as { data?: { id?: string }[] } | { id?: string }[];
    const list = Array.isArray(data) ? data : (data.data ?? []);
    const models = list
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort((a, b) => a.localeCompare(b));
    if (models.length === 0) return { models: defaultModels(opts.type, baseUrl), fallback: true };
    return { models };
  } catch {
    return { models: defaultModels(opts.type, baseUrl), fallback: true };
  }
}

/** Static fallbacks keyed by endpoint, used only when the live fetch fails. */
export function defaultModels(type: string, baseUrl: string): string[] {
  if (type === 'anthropic') {
    return ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
  }
  if (baseUrl.includes('openai.com')) return ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini'];
  if (baseUrl.includes('openrouter.ai')) {
    return ['openai/gpt-4o', 'anthropic/claude-sonnet-4', 'meta-llama/llama-3.1-70b-instruct'];
  }
  if (baseUrl.includes(':11434')) return ['llama3.1:8b', 'qwen2.5:32b', 'mistral:7b'];
  if (baseUrl.includes(':1234')) return ['qwen/qwen3-32b', 'qwen/qwen3-235b-a22b-2507'];
  return [];
}
