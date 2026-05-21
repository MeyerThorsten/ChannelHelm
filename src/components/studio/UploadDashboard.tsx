'use client';

import { Avatar, Eyebrow, PrimaryBtn } from '@/components/ui';
import { brandColor } from '@/lib/brand-color';
import { ingestYoutubeUrl } from '@/server-actions/sources';
import { useRouter } from 'next/navigation';
import { type DragEvent, useRef, useState, useTransition } from 'react';

type Brand = { id: string; slug: string; name: string };
const PROFILES = [
  { id: 'fast_audio_only', label: 'Fast', sub: 'audio only', icon: '♬' },
  { id: 'standard_audio_visual', label: 'Standard', sub: 'audio + visual', icon: '▦' },
  { id: 'premium_multimodal', label: 'Premium', sub: 'full multimodal', icon: '✦' },
];

export function UploadDashboard({ brands }: { brands: Brand[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<'drop' | 'url'>('drop');
  const [brandId, setBrandId] = useState(brands[0]?.id ?? '');
  const [profile, setProfile] = useState('standard_audio_visual');
  const [url, setUrl] = useState('');
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);
  const brand = brands.find((b) => b.id === brandId) ?? brands[0];

  if (brands.length === 0) {
    return (
      <div
        style={{
          borderRadius: 14,
          border: '1px dashed var(--border-strong)',
          padding: 32,
          textAlign: 'center',
          color: 'var(--text-muted)',
          fontSize: 13,
        }}
      >
        Create a brand first to start ingesting videos.{' '}
        <a href="/brands/new" style={{ color: 'var(--accent)' }}>
          New brand →
        </a>
      </div>
    );
  }

  function submitUrl() {
    if (!url.trim()) return;
    setError(null);
    startTransition(async () => {
      try {
        await ingestYoutubeUrl(url.trim(), profile, brandId || undefined);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes('NEXT_REDIRECT')) setError(msg);
      }
    });
  }

  async function uploadFile(file: File) {
    setError(null);
    setBusy(`Creating package · ${file.name}…`);
    try {
      const qs = new URLSearchParams({ brandId, filename: file.name, profile });
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
    setHover(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void uploadFile(file);
  }

  const tabBtn = (active: boolean) => ({
    display: 'inline-flex' as const,
    alignItems: 'center' as const,
    gap: 6,
    padding: '5px 10px',
    fontSize: 12,
    fontWeight: 500,
    color: active ? 'var(--text)' : 'var(--text-muted)',
    background: active ? 'var(--bg-elev)' : 'transparent',
    border: `1px solid ${active ? 'var(--border)' : 'transparent'}`,
    borderRadius: 6,
    cursor: 'pointer',
  });

  return (
    <div
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 14,
        overflow: 'hidden',
        boxShadow: '0 1px 0 rgba(255,255,255,0.02) inset, 0 12px 40px rgba(0,0,0,0.2)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          gap: 4,
          background: 'var(--panel-strong)',
          flexWrap: 'wrap',
        }}
      >
        <button type="button" onClick={() => setMode('drop')} style={tabBtn(mode === 'drop')}>
          <span style={{ fontSize: 12, opacity: 0.7 }}>⬆</span> File
        </button>
        <button type="button" onClick={() => setMode('url')} style={tabBtn(mode === 'url')}>
          <span style={{ fontSize: 12, opacity: 0.7 }}>🔗</span> URL
        </button>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Eyebrow>Brand</Eyebrow>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 6px 3px 5px',
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 6,
            }}
          >
            {brand && (
              <Avatar
                glyph={brand.slug.slice(0, 2).toUpperCase()}
                color={brandColor(brand.slug)}
                size={16}
              />
            )}
            <select
              value={brandId}
              onChange={(e) => setBrandId(e.target.value)}
              style={{
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontSize: 12,
                color: 'var(--text)',
              }}
            >
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          {mode === 'url' && (
            <span
              title="For YouTube links the brand is auto-detected from the channel"
              style={{
                fontSize: 9,
                padding: '1px 5px',
                borderRadius: 3,
                background: 'color-mix(in oklab, var(--status-published) 16%, transparent)',
                color: 'var(--status-published)',
                border: '1px solid color-mix(in oklab, var(--status-published) 30%, transparent)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              auto
            </span>
          )}
        </div>
      </div>

      <div style={{ padding: 18 }}>
        {mode === 'drop' ? (
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setHover(true);
            }}
            onDragLeave={() => setHover(false)}
            onDrop={onDrop}
            style={{
              position: 'relative',
              width: '100%',
              border: `1.5px dashed ${hover ? 'var(--accent)' : 'var(--border-strong)'}`,
              background: hover ? 'var(--accent-soft)' : 'var(--bg)',
              borderRadius: 10,
              padding: '48px 24px',
              textAlign: 'center',
              transition: 'all 0.16s',
              cursor: 'pointer',
            }}
          >
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 14,
                background: 'linear-gradient(180deg, var(--bg-elev), var(--panel))',
                border: '1px solid var(--border)',
                margin: '0 auto 14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 8px 20px rgba(0,0,0,0.2)',
              }}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M12 19V5" />
                <path d="M5 12l7-7 7 7" />
              </svg>
            </div>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
              {busy ? '' : 'Drop a video, or click to choose'}
            </div>
            <div
              style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}
            >
              .mp4 · .mov · .webm · .m4v · .mkv
            </div>
            {busy && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'var(--bg)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  borderRadius: 10,
                }}
              >
                <span className="spinner" />
                <span style={{ fontSize: 13 }}>{busy}</span>
              </div>
            )}
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitUrl()}
              placeholder="Paste a YouTube, podcast, or webinar URL…"
              style={{
                flex: 1,
                padding: '12px 14px',
                background: 'var(--bg)',
                border: '1px solid var(--border-strong)',
                borderRadius: 8,
                fontSize: 14,
                outline: 'none',
                color: 'var(--text)',
              }}
            />
            <PrimaryBtn onClick={submitUrl} loading={pending} icon="→">
              Ingest link
            </PrimaryBtn>
          </div>
        )}

        <input
          ref={fileInput}
          type="file"
          accept="video/*,.mkv"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadFile(f);
          }}
        />

        <div style={{ marginTop: 14, display: 'flex', gap: 12 }}>
          {PROFILES.map((p) => {
            const active = p.id === profile;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setProfile(p.id)}
                style={{
                  flex: 1,
                  textAlign: 'left',
                  padding: '10px 12px',
                  background: active ? 'var(--accent-soft)' : 'var(--bg-elev)',
                  border: `1px solid ${active ? 'color-mix(in oklab, var(--accent) 40%, transparent)' : 'var(--border)'}`,
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 6,
                    background: active
                      ? 'color-mix(in oklab, var(--accent) 22%, transparent)'
                      : 'var(--bg-elev-2)',
                    color: active ? 'var(--accent)' : 'var(--text-muted)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 13,
                    fontFamily: 'var(--font-mono)',
                    border: `1px solid ${active ? 'color-mix(in oklab, var(--accent) 30%, transparent)' : 'var(--border)'}`,
                  }}
                >
                  {p.icon}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>{p.label}</div>
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--text-faint)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {p.sub}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {error && (
          <p style={{ marginTop: 12, fontSize: 12, color: 'var(--status-failed)' }}>{error}</p>
        )}
      </div>
    </div>
  );
}
