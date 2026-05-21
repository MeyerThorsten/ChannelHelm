'use client';

import type { llmProviders } from '@/db/schema';
import { listProviderModels } from '@/server-actions/providers';
import { useState, useTransition } from 'react';

type Provider = typeof llmProviders.$inferSelect;

const INPUT = 'ch-input';
const LABEL = 'ch-label';
const HELP = 'ch-help';

const TYPES = [
  {
    value: 'openai-compatible',
    label: 'OpenAI-compatible (OpenAI · OpenRouter · Ollama · LM Studio · OpenClaw)',
  },
  { value: 'anthropic', label: 'Anthropic (Claude Messages API)' },
  { value: 'codex-cli', label: 'Codex CLI (ChatGPT subscription)' },
];
const PURPOSES = ['all', 'fast_audio_only', 'standard_audio_visual', 'premium_multimodal'];

type Preset = { name: string; type: string; baseUrl: string; model: string };
const PRESETS: Preset[] = [
  {
    name: 'OpenAI',
    type: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  },
  {
    name: 'Claude (Anthropic)',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-6',
  },
  {
    name: 'OpenRouter',
    type: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.1-70b-instruct',
  },
  {
    name: 'Ollama (Local)',
    type: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1:8b',
  },
  {
    name: 'LM Studio (Local)',
    type: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    model: 'qwen/qwen3-32b',
  },
  {
    name: 'OpenClaw (fleet proxy)',
    type: 'openai-compatible',
    baseUrl: '',
    model: 'qwen/qwen3-32b',
  },
  { name: 'Codex (ChatGPT subscription)', type: 'codex-cli', baseUrl: '', model: 'gpt-5.5' },
];

export function ProviderForm({
  provider,
  action,
  submitLabel,
}: {
  provider?: Provider;
  action: (formData: FormData) => Promise<void>;
  submitLabel: string;
}) {
  const [name, setName] = useState(provider?.name ?? '');
  const [type, setType] = useState(provider?.type ?? 'openai-compatible');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(provider?.apiKey ?? '');
  const [model, setModel] = useState(provider?.model ?? '');
  const [models, setModels] = useState<string[]>([]);
  const [modelMsg, setModelMsg] = useState<string | null>(null);
  const [loadingModels, startLoadModels] = useTransition();

  const isCodex = type === 'codex-cli';
  const baseUrlPlaceholder =
    type === 'anthropic' ? 'https://api.anthropic.com/v1' : 'http://localhost:1234/v1';
  const modelPlaceholder = isCodex
    ? 'gpt-5.5'
    : type === 'anthropic'
      ? 'claude-sonnet-4-6'
      : 'qwen/qwen3-32b';

  function applyPreset(p: Preset) {
    setName(p.name);
    setType(p.type);
    setBaseUrl(p.baseUrl);
    setModel(p.model);
    setModels([]);
    setModelMsg(null);
  }

  function loadModels() {
    setModelMsg(null);
    startLoadModels(async () => {
      try {
        const r = await listProviderModels({ type, baseUrl, apiKey });
        setModels(r.models);
        setModelMsg(
          r.models.length === 0
            ? 'No models returned.'
            : `${r.models.length} models${r.fallback ? ' (fallback — couldn’t reach the endpoint)' : ''}`,
        );
      } catch (e) {
        setModelMsg(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <form action={action} className="space-y-4">
      {/* Quick presets */}
      <div>
        <span className={LABEL}>Quick preset</span>
        <div className="mt-1 flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => applyPreset(p)}
              style={{
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'var(--bg-elev)',
                color: 'var(--text)',
                padding: '4px 10px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="name">
            Name
          </label>
          <input
            id="name"
            name="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
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

      {isCodex ? (
        <p
          style={{
            borderRadius: 6,
            border: '1px solid color-mix(in oklab, var(--accent) 28%, transparent)',
            background: 'var(--accent-soft)',
            color: 'var(--text-muted)',
            padding: '8px 12px',
            fontSize: 11,
            lineHeight: 1.6,
          }}
        >
          Uses the local <code>codex</code> CLI with your ChatGPT subscription (OAuth). No Base URL
          or API key needed — auth is read from <code>~/.codex</code>. Make sure <code>codex</code>{' '}
          is installed and you’ve run <code>codex login</code> on the machine the worker runs on.
          {/* keep the field present so FormData always has baseUrl/apiKey */}
          <input type="hidden" name="baseUrl" value="" />
          <input type="hidden" name="apiKey" value="" />
        </p>
      ) : (
        <div>
          <label className={LABEL} htmlFor="baseUrl">
            Base URL
          </label>
          <input
            id="baseUrl"
            name="baseUrl"
            required
            placeholder={baseUrlPlaceholder}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className={INPUT}
          />
          <p className={HELP}>
            Include the /v1 suffix for OpenAI-compatible + Anthropic endpoints.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <div className="flex items-center justify-between">
            <label className={LABEL} htmlFor="model">
              Model
            </label>
            {!isCodex && (
              <button
                type="button"
                onClick={loadModels}
                disabled={loadingModels || !baseUrl}
                className="text-xs font-medium text-sky-600 hover:underline disabled:opacity-50"
              >
                {loadingModels ? 'Loading…' : '↻ Load models'}
              </button>
            )}
          </div>
          {!isCodex && models.length > 0 && (
            <select
              aria-label="Available models"
              value={models.includes(model) ? model : ''}
              onChange={(e) => e.target.value && setModel(e.target.value)}
              className={INPUT}
            >
              <option value="">— select a model —</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
          <input
            id="model"
            name="model"
            required
            placeholder={modelPlaceholder}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className={INPUT}
          />
          <p className={HELP}>
            {isCodex
              ? 'ChatGPT-account Codex accepts gpt-5.5 or gpt-5.4. Use “default” to follow ~/.codex/config.toml. (gpt-5-codex / gpt-5 are API-only and will fail.)'
              : (modelMsg ??
                'Pick from the list, or type a model id. Click “Load models” to fetch them.')}
          </p>
        </div>
        {!isCodex && (
          <div>
            <label className={LABEL} htmlFor="apiKey">
              API key{' '}
              {type !== 'anthropic' && <span className="text-zinc-400">(blank for local)</span>}
            </label>
            <input
              id="apiKey"
              name="apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className={INPUT}
            />
          </div>
        )}
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
