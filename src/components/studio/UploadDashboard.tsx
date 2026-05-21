'use client';

import { createSourceFromForm } from '@/server-actions/sources';
import { useRouter } from 'next/navigation';
import { type DragEvent, useRef, useState, useTransition } from 'react';

type Brand = { id: string; slug: string; name: string };
const PROFILES = ['fast_audio_only', 'standard_audio_visual', 'premium_multimodal'] as const;

export function UploadDashboard({ brands }: { brands: Brand[] }) {
  const router = useRouter();
  const [brandId, setBrandId] = useState(brands[0]?.id ?? '');
  const [profile, setProfile] = useState<string>('standard_audio_visual');
  const [url, setUrl] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);

  if (brands.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
        Create a brand first to start ingesting videos.{' '}
        <a href="/brands/new" className="text-sky-600 hover:underline">
          New brand →
        </a>
      </div>
    );
  }

  function submitUrl() {
    if (!url.trim()) return;
    setError(null);
    const fd = new FormData();
    fd.set('brandId', brandId);
    fd.set('kind', 'youtube_url');
    fd.set('originUrl', url.trim());
    fd.set('processingProfile', profile);
    fd.set('createPackage', 'on');
    startTransition(async () => {
      try {
        await createSourceFromForm(fd); // redirects to /packages/[id]
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  async function uploadFile(file: File) {
    setError(null);
    setBusy(`Uploading ${file.name}…`);
    try {
      const qs = new URLSearchParams({
        brandId,
        filename: file.name,
        profile,
      });
      const res = await fetch(`/api/uploads?${qs.toString()}`, { method: 'POST', body: file });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `upload failed (${res.status})`);
      }
      const data = (await res.json()) as { package: { id: string } };
      router.push(`/packages/${data.package.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void uploadFile(file);
  }

  const inputCls =
    'rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950';

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-4 flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Brand
          <select value={brandId} onChange={(e) => setBrandId(e.target.value)} className={inputCls}>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.slug} — {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Profile
          <select value={profile} onChange={(e) => setProfile(e.target.value)} className={inputCls}>
            {PROFILES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Drop zone */}
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center transition ${
          dragOver
            ? 'border-sky-400 bg-sky-50 dark:bg-sky-950/30'
            : 'border-zinc-300 hover:border-zinc-400 dark:border-zinc-700'
        }`}
      >
        <span className="text-3xl" aria-hidden>
          ⬆
        </span>
        <span className="text-sm font-medium">
          {busy ?? 'Drop a video here, or click to choose a file'}
        </span>
        <span className="text-xs text-zinc-400">mp4 · mov · webm · m4v · mkv</span>
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="video/*,.mkv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void uploadFile(f);
        }}
      />

      {/* URL paste */}
      <div className="mt-4 flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submitUrl()}
          placeholder="…or paste a YouTube / video URL"
          className={`flex-1 ${inputCls}`}
        />
        <button
          type="button"
          onClick={submitUrl}
          disabled={pending || !url.trim()}
          className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {pending ? 'Starting…' : 'Ingest link'}
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
    </div>
  );
}
