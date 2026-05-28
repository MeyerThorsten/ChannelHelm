'use client';

import {
  setYoutubePublishOptions,
  type YoutubePrivacy,
} from '@/server-actions/youtube-publish-options';
import { useEffect, useState, useTransition } from 'react';

type Option = { v: YoutubePrivacy; label: string; help: string };

const OPTIONS: Option[] = [
  { v: 'public', label: '🌐  Public — live on upload', help: 'Live immediately when the upload finishes.' },
  { v: 'unlisted', label: '🔗  Unlisted — link only', help: 'Anyone with the link, not in search or recommendations.' },
  { v: 'private', label: '🔒  Private (default)', help: 'Only you. Flip to public in YouTube Studio when ready.' },
  { v: 'schedule', label: '⏰  Schedule for…', help: 'Upload as private; YouTube auto-publishes at the chosen time.' },
];

/**
 * Compact per-package YouTube publish options. Lives inside the narrow
 * Approve panel sidebar, so it uses a native <select> rather than a tile
 * grid. Auto-saves on change — there's no Save button for the radio side;
 * the schedule input commits on blur or Enter.
 *
 * Only renders when the brand has Direct selected + connected; otherwise
 * YouTube Studio handles privacy and this control is meaningless.
 */
export function YoutubePublishOptions({
  packageId,
  initialPrivacy,
  initialPublishAt,
  visible,
}: {
  packageId: string;
  initialPrivacy: YoutubePrivacy;
  initialPublishAt: string | null;
  visible: boolean;
}) {
  const [privacy, setPrivacy] = useState<YoutubePrivacy>(initialPrivacy);
  const [publishAt, setPublishAt] = useState<string>(
    initialPublishAt ? toLocalInputValue(initialPublishAt) : '',
  );
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  function commit(nextPrivacy: YoutubePrivacy, nextPublishAt?: string): void {
    setError(null);
    if (nextPrivacy === 'schedule' && !nextPublishAt) return; // waiting on a date
    const payload =
      nextPrivacy === 'schedule'
        ? {
            privacy: nextPrivacy,
            publishAt: nextPublishAt ? new Date(nextPublishAt).toISOString() : undefined,
          }
        : { privacy: nextPrivacy };
    start(async () => {
      try {
        await setYoutubePublishOptions(packageId, payload);
        setSavedAt(Date.now());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(null), 2500);
    return () => clearTimeout(t);
  }, [savedAt]);

  if (!visible) return null;

  const currentHelp = OPTIONS.find((o) => o.v === privacy)?.help ?? '';

  return (
    <section
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '12px 12px 14px',
        marginBottom: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 10,
            color: 'var(--text-faint)',
            fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          YT publish options
        </span>
        {pending ? (
          <span style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>saving…</span>
        ) : savedAt ? (
          <span style={{ fontSize: 10, color: 'var(--status-published)', fontFamily: 'var(--font-mono)' }}>✓ saved</span>
        ) : null}
      </div>

      <select
        value={privacy}
        disabled={pending}
        onChange={(e) => {
          const v = e.target.value as YoutubePrivacy;
          setPrivacy(v);
          if (v !== 'schedule') commit(v);
          else if (publishAt) commit('schedule', publishAt);
        }}
        style={{
          width: '100%',
          padding: '7px 10px',
          fontSize: 13,
          background: 'var(--panel-2)',
          border: '1px solid var(--border-strong)',
          borderRadius: 6,
          color: 'var(--text)',
          fontFamily: 'var(--font-sans)',
          cursor: pending ? 'wait' : 'pointer',
          appearance: 'auto',
        }}
      >
        {OPTIONS.map((o) => (
          <option key={o.v} value={o.v}>
            {o.label}
          </option>
        ))}
      </select>

      <p
        style={{
          margin: '6px 2px 0',
          fontSize: 11,
          color: 'var(--text-faint)',
          lineHeight: 1.5,
        }}
      >
        {currentHelp}
      </p>

      {privacy === 'schedule' && (
        <div style={{ marginTop: 10 }}>
          <input
            type="datetime-local"
            value={publishAt}
            min={minLocalDatetime()}
            disabled={pending}
            onChange={(e) => setPublishAt(e.target.value)}
            onBlur={() => publishAt && commit('schedule', publishAt)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (publishAt) commit('schedule', publishAt);
              }
            }}
            style={{
              width: '100%',
              padding: '7px 10px',
              fontSize: 13,
              background: 'var(--bg-elev)',
              border: '1px solid var(--border-strong)',
              borderRadius: 6,
              color: 'var(--text)',
              fontFamily: 'var(--font-mono)',
            }}
          />
          <p
            style={{
              margin: '6px 2px 0',
              fontSize: 10,
              color: 'var(--text-faint)',
              lineHeight: 1.5,
            }}
          >
            Local time · ≥1 min in the future · saves on blur.
          </p>
        </div>
      )}

      {error && (
        <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--status-failed)', fontFamily: 'var(--font-mono)' }}>
          {error}
        </p>
      )}
    </section>
  );
}

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function minLocalDatetime(): string {
  const d = new Date(Date.now() + 2 * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
