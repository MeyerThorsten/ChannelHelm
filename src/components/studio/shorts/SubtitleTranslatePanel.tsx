'use client';

/**
 * "Translate subtitles" control for the Shorts editor.
 *
 * A minimal language multi-select (toggle chips) + a Translate button that
 * calls the `translateClipSubtitles` server action. Produced languages are
 * listed back with their segment count; languages that already have a
 * translation on the plan are marked. Re-translating a language overwrites
 * the existing sidecar files.
 *
 * Scope note (DEFERRED): this generates translated SRT + ASS *sidecar* files
 * only. It does NOT burn the translation into a re-rendered video and does
 * NOT do TTS dubbing — both are tracked follow-ups in the contract addendum.
 */

import { SUPPORTED_LANGUAGES } from '@/lib/subtitle-translate';
import { translateClipSubtitles } from '@/server-actions/subtitle-translate';
import { useState, useTransition } from 'react';

type ExistingTranslations = Record<
  string,
  { srt_path: string; ass_path: string; segments: number; used_fallback?: boolean }
>;

const LANG_ENTRIES = Object.entries(SUPPORTED_LANGUAGES) as [string, string][];

export function SubtitleTranslatePanel({
  planAssetId,
  clipIndex,
  existing,
  hasTranscript,
  onTranslated,
}: {
  planAssetId: string;
  clipIndex: number;
  existing: ExistingTranslations;
  hasTranscript: boolean;
  onTranslated: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ language: string; segments: number; usedFallback: boolean }[]>(
    [],
  );

  const existingCodes = Object.keys(existing);

  function toggle(code: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function translate(): void {
    if (selected.size === 0) return;
    setError(null);
    setDone([]);
    const languages = Array.from(selected);
    start(async () => {
      try {
        const results = await translateClipSubtitles({ planAssetId, clipIndex, languages });
        setDone(results);
        setSelected(new Set());
        onTranslated();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Label>Translate subtitles</Label>
      <p style={hint()}>
        Generate translated <code style={code()}>.srt</code> + <code style={code()}>.ass</code>{' '}
        caption tracks beside the clip. Pick one or more languages, then Translate.
      </p>

      {!hasTranscript && (
        <p style={{ ...hint(), color: 'var(--status-failed)' }}>
          ⚠ no word-level transcript for this package — translation uses segment-level transcript
          text and may be unavailable.
        </p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {LANG_ENTRIES.map(([code, label]) => {
          const isSelected = selected.has(code);
          const alreadyDone = existingCodes.includes(code);
          return (
            <button
              key={code}
              type="button"
              onClick={() => toggle(code)}
              title={alreadyDone ? `${label} — already translated (will overwrite)` : label}
              style={chip(isSelected, alreadyDone)}
            >
              {label}
              {alreadyDone && <span style={{ marginLeft: 5, opacity: 0.7 }}>✓</span>}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={translate}
        disabled={pending || selected.size === 0}
        style={translateBtn(pending || selected.size === 0)}
      >
        {pending
          ? 'Translating…'
          : selected.size > 0
            ? `Translate ${selected.size} language${selected.size > 1 ? 's' : ''}`
            : 'Translate'}
      </button>

      {error && (
        <p
          style={{
            margin: 0,
            padding: '6px 10px',
            background: 'color-mix(in oklab, var(--status-failed) 10%, transparent)',
            border: '1px solid color-mix(in oklab, var(--status-failed) 28%, transparent)',
            borderRadius: 6,
            fontSize: 11,
            color: 'var(--status-failed)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {error}
        </p>
      )}

      {done.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {done.map((r) => (
            <div key={r.language} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ color: 'var(--status-published)' }}>✓</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>
                {SUPPORTED_LANGUAGES[r.language] ?? r.language} · {r.segments} lines
              </span>
              {r.usedFallback && (
                <span style={{ color: 'var(--status-failed)', fontSize: 10 }}>
                  (used source text — translation line count mismatched)
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {existingCodes.length > 0 && (
        <div style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
          existing tracks: {existingCodes.join(', ')}
        </div>
      )}
    </div>
  );
}

// ─── small primitives (match SubtitleStylePanel) ────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        color: 'var(--text-faint)',
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}
    >
      {children}
    </div>
  );
}

function hint(): React.CSSProperties {
  return { margin: 0, fontSize: 10, color: 'var(--text-faint)', lineHeight: 1.5 };
}

function code(): React.CSSProperties {
  return { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' };
}

function chip(active: boolean, done: boolean): React.CSSProperties {
  return {
    padding: '5px 9px',
    fontSize: 11,
    background: active ? 'color-mix(in oklab, var(--accent) 12%, transparent)' : 'var(--panel-2)',
    color: active ? 'var(--accent)' : 'var(--text)',
    border: `1px solid ${
      active
        ? 'color-mix(in oklab, var(--accent) 38%, transparent)'
        : done
          ? 'color-mix(in oklab, var(--status-published) 35%, var(--border))'
          : 'var(--border-strong)'
    }`,
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
  };
}

function translateBtn(disabled: boolean): React.CSSProperties {
  return {
    alignSelf: 'flex-start',
    padding: '7px 14px',
    fontSize: 12,
    fontWeight: 600,
    background: disabled ? 'var(--panel-2)' : 'var(--accent)',
    color: disabled ? 'var(--text-faint)' : '#fff',
    border: `1px solid ${
      disabled ? 'var(--border-strong)' : 'color-mix(in oklab, var(--accent) 80%, white)'
    }`,
    borderRadius: 7,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}
