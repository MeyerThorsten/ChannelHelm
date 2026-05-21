'use client';

import type { llmProviders } from '@/db/schema';
import { useState } from 'react';

type Provider = typeof llmProviders.$inferSelect;

const INPUT =
  'mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-zinc-700 dark:bg-zinc-950';
const LABEL = 'block text-sm font-medium text-zinc-700 dark:text-zinc-300';
const HELP = 'mt-1 text-xs text-zinc-500';

const TYPES = [
  {
    value: 'openai-compatible',
    label: 'OpenAI-compatible (OpenAI · OpenRouter · Ollama · LM Studio · OpenClaw)',
  },
  { value: 'anthropic', label: 'Anthropic (Claude Messages API)' },
];
const PURPOSES = ['all', 'fast_audio_only', 'standard_audio_visual', 'premium_multimodal'];

export function ProviderForm({
  provider,
  action,
  submitLabel,
}: {
  provider?: Provider;
  action: (formData: FormData) => Promise<void>;
  submitLabel: string;
}) {
  const [type, setType] = useState(provider?.type ?? 'openai-compatible');
  const baseUrlPlaceholder =
    type === 'anthropic' ? 'https://api.anthropic.com/v1' : 'http://localhost:1234/v1';
  const modelPlaceholder = type === 'anthropic' ? 'claude-sonnet-4-6' : 'qwen/qwen3-32b';

  return (
    <form action={action} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="name">
            Name
          </label>
          <input
            id="name"
            name="name"
            required
            defaultValue={provider?.name ?? ''}
            className={INPUT}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="type">
            Type
          </label>
          <select
            id="type"
            name="type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className={INPUT}
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className={LABEL} htmlFor="baseUrl">
          Base URL
        </label>
        <input
          id="baseUrl"
          name="baseUrl"
          required
          placeholder={baseUrlPlaceholder}
          defaultValue={provider?.baseUrl ?? ''}
          className={INPUT}
        />
        <p className={HELP}>Include the /v1 suffix for OpenAI-compatible + Anthropic endpoints.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="model">
            Model
          </label>
          <input
            id="model"
            name="model"
            required
            placeholder={modelPlaceholder}
            defaultValue={provider?.model ?? ''}
            className={INPUT}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="apiKey">
            API key{' '}
            {type !== 'anthropic' && <span className="text-zinc-400">(blank for local)</span>}
          </label>
          <input
            id="apiKey"
            name="apiKey"
            type="password"
            placeholder={provider?.apiKey ? '•••••• (unchanged if left blank? no — re-enter)' : ''}
            defaultValue={provider?.apiKey ?? ''}
            className={INPUT}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <label className={LABEL} htmlFor="purpose">
            Purpose
          </label>
          <select
            id="purpose"
            name="purpose"
            defaultValue={provider?.purpose ?? 'all'}
            className={INPUT}
          >
            {PURPOSES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <p className={HELP}>Route a profile to this provider, or “all”.</p>
        </div>
        <div>
          <label className={LABEL} htmlFor="maxTokens">
            Max tokens
          </label>
          <input
            id="maxTokens"
            name="maxTokens"
            type="number"
            defaultValue={provider?.maxTokens ?? 2048}
            className={INPUT}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="temperature">
            Temperature
          </label>
          <input
            id="temperature"
            name="temperature"
            type="number"
            step="0.05"
            defaultValue={provider?.temperature ?? 0.5}
            className={INPUT}
          />
        </div>
      </div>

      <div className="flex gap-6 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="isDefault" defaultChecked={provider?.isDefault ?? false} />
          Default
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="enabled" defaultChecked={provider?.enabled ?? true} />
          Enabled
        </label>
      </div>

      <button
        type="submit"
        className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
      >
        {submitLabel}
      </button>
    </form>
  );
}
