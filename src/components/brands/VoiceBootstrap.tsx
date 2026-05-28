'use client';

import { GENERATABLE_TEXT_TYPES, type VoiceCountRow } from '@/lib/voice-types';
import {
  bootstrapFromPublishedAssets,
  importVoiceExamples,
} from '@/server-actions/voice-bootstrap';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';

type Props = {
  brandId: string;
  initialCounts: VoiceCountRow[];
};

const TYPE_LABELS: Record<string, string> = {
  youtube_title_set: 'YouTube Titles',
  youtube_description: 'YouTube Description',
  linkedin_post: 'LinkedIn Post',
  x_post: 'X / Tweet',
  x_thread: 'X Thread',
  article_brief: 'Article Brief',
  newsletter_summary: 'Newsletter Summary',
  facebook_post: 'Facebook Post',
  threads_post: 'Threads Post',
  bluesky_post: 'Bluesky Post',
  reddit_post: 'Reddit Post',
  pinterest_pin: 'Pinterest Pin',
  telegram_post: 'Telegram Post',
  discord_message: 'Discord Message',
  google_business_post: 'Google Business Post',
  youtube_pinned_comment: 'YouTube Pinned Comment',
};

function countFor(counts: VoiceCountRow[], type: string): number {
  return counts.find((r) => r.assetType === type)?.count ?? 0;
}

export function VoiceBootstrap({ brandId, initialCounts }: Props) {
  const router = useRouter();
  const [counts, setCounts] = useState<VoiceCountRow[]>(initialCounts);
  const [selectedType, setSelectedType] = useState<string>(GENERATABLE_TEXT_TYPES[0]);
  const [pasteText, setPasteText] = useState('');
  const [importing, startImport] = useTransition();
  const [bootstrapping, startBootstrap] = useTransition();
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    msg: string;
    forAction: 'import' | 'bootstrap';
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function refreshCounts(updated: VoiceCountRow[], type: string, delta: number) {
    // Optimistically update the count for the affected type.
    const next = [...updated];
    const idx = next.findIndex((r) => r.assetType === type);
    if (idx >= 0) {
      next[idx] = { ...next[idx]!, count: (next[idx]?.count ?? 0) + delta };
    } else if (delta > 0) {
      next.push({ assetType: type, count: delta });
    }
    setCounts(next);
    router.refresh();
  }

  function handleImport() {
    const texts = pasteText
      .split('\n')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (texts.length === 0) {
      setFeedback({
        type: 'error',
        msg: 'Paste at least one non-empty line.',
        forAction: 'import',
      });
      return;
    }
    setFeedback(null);
    startImport(async () => {
      try {
        const result = await importVoiceExamples({
          brandId,
          assetType: selectedType,
          texts,
        });
        setFeedback({
          type: 'success',
          msg: `Inserted ${result.inserted}, skipped ${result.skipped} duplicate${result.skipped !== 1 ? 's' : ''}.`,
          forAction: 'import',
        });
        if (result.inserted > 0) {
          refreshCounts(counts, selectedType, result.inserted);
          setPasteText('');
        }
      } catch (e) {
        setFeedback({
          type: 'error',
          msg: e instanceof Error ? e.message : String(e),
          forAction: 'import',
        });
      }
    });
  }

  function handleBootstrap(type: string) {
    setFeedback(null);
    startBootstrap(async () => {
      try {
        const result = await bootstrapFromPublishedAssets({ brandId, assetType: type });
        setFeedback({
          type: 'success',
          msg: `Inserted ${result.inserted} from published assets, skipped ${result.skipped} duplicate${result.skipped !== 1 ? 's' : ''}.`,
          forAction: 'bootstrap',
        });
        if (result.inserted > 0) {
          refreshCounts(counts, type, result.inserted);
        }
      } catch (e) {
        setFeedback({
          type: 'error',
          msg: e instanceof Error ? e.message : String(e),
          forAction: 'bootstrap',
        });
      }
    });
  }

  const busy = importing || bootstrapping;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      {/* ── Paste import ──────────────────────────────────────────── */}
      <section
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: 20,
        }}
      >
        <h2
          style={{
            margin: '0 0 4px',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text)',
          }}
        >
          Paste samples
        </h2>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-muted)' }}>
          One sample per line. Each non-empty line becomes one voice example seeded at score 0.7
          (below proven A/B winners at 0.9, above the generic floor).
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <label
            htmlFor="asset-type-select"
            style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}
          >
            Asset type
          </label>
          <select
            id="asset-type-select"
            value={selectedType}
            onChange={(e) => {
              setSelectedType(e.target.value);
              setFeedback(null);
            }}
            style={{
              flex: 1,
              padding: '5px 8px',
              fontSize: 12,
              background: 'var(--bg-elev)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              outline: 'none',
            }}
          >
            {GENERATABLE_TEXT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t] ?? t}
              </option>
            ))}
          </select>
        </div>

        <textarea
          ref={textareaRef}
          value={pasteText}
          onChange={(e) => {
            setPasteText(e.target.value);
            setFeedback(null);
          }}
          placeholder={`Paste ${TYPE_LABELS[selectedType] ?? selectedType} examples here, one per line…`}
          rows={7}
          style={{
            width: '100%',
            padding: '10px 12px',
            fontSize: 12,
            fontFamily: 'var(--font-sans)',
            lineHeight: 1.6,
            background: 'var(--bg-elev)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            resize: 'vertical',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />

        {feedback?.forAction === 'import' && (
          <p
            style={{
              margin: '8px 0 0',
              fontSize: 11,
              color:
                feedback.type === 'success' ? 'var(--status-published)' : 'var(--status-failed)',
            }}
          >
            {feedback.msg}
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
          <button
            type="button"
            onClick={handleImport}
            disabled={busy || pasteText.trim().length === 0}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '7px 14px',
              fontSize: 12,
              fontWeight: 600,
              color: '#fff',
              background: 'var(--accent)',
              border: '1px solid color-mix(in oklab, var(--accent) 80%, white)',
              borderRadius: 6,
              cursor: busy || pasteText.trim().length === 0 ? 'not-allowed' : 'pointer',
              opacity: busy || pasteText.trim().length === 0 ? 0.55 : 1,
              transition: 'filter 0.12s',
            }}
            onMouseEnter={(e) => {
              if (!busy) e.currentTarget.style.filter = 'brightness(1.08)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.filter = 'brightness(1)';
            }}
          >
            {importing ? (
              <>
                <span className="spinner" />
                Importing…
              </>
            ) : (
              'Import examples'
            )}
          </button>
        </div>
      </section>

      {/* ── Per-type table with Bootstrap buttons ─────────────────── */}
      <section
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            Voice example counts &amp; bootstrap
          </h2>
          <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
            "Bootstrap" seeds from this brand's already-approved/published assets — no paste needed.
          </p>
          {feedback?.forAction === 'bootstrap' && (
            <p
              style={{
                margin: '8px 0 0',
                fontSize: 11,
                color:
                  feedback.type === 'success' ? 'var(--status-published)' : 'var(--status-failed)',
              }}
            >
              {feedback.msg}
            </p>
          )}
        </div>

        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 12,
          }}
        >
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th
                style={{
                  padding: '8px 20px',
                  textAlign: 'left',
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                  color: 'var(--text-faint)',
                  textTransform: 'uppercase',
                }}
              >
                Type
              </th>
              <th
                style={{
                  padding: '8px 20px',
                  textAlign: 'right',
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                  color: 'var(--text-faint)',
                  textTransform: 'uppercase',
                  width: 80,
                }}
              >
                Examples
              </th>
              <th
                style={{
                  padding: '8px 20px',
                  textAlign: 'right',
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                  color: 'var(--text-faint)',
                  textTransform: 'uppercase',
                  width: 140,
                }}
              >
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {GENERATABLE_TEXT_TYPES.map((type, idx) => {
              const n = countFor(counts, type);
              return (
                <tr
                  key={type}
                  style={{
                    borderBottom:
                      idx < GENERATABLE_TEXT_TYPES.length - 1 ? '1px solid var(--border)' : 'none',
                  }}
                >
                  <td style={{ padding: '9px 20px', color: 'var(--text)' }}>
                    <span style={{ fontWeight: 500 }}>{TYPE_LABELS[type] ?? type}</span>
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 10,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-faint)',
                      }}
                    >
                      {type}
                    </span>
                  </td>
                  <td
                    style={{
                      padding: '9px 20px',
                      textAlign: 'right',
                      fontFamily: 'var(--font-mono)',
                      color: n === 0 ? 'var(--text-dim)' : 'var(--text)',
                    }}
                  >
                    {n}
                  </td>
                  <td style={{ padding: '9px 20px', textAlign: 'right' }}>
                    <button
                      type="button"
                      onClick={() => handleBootstrap(type)}
                      disabled={busy}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        padding: '4px 8px',
                        fontSize: 11,
                        fontWeight: 500,
                        color: busy ? 'var(--text-dim)' : 'var(--text)',
                        background: 'var(--bg-elev)',
                        border: '1px solid var(--border)',
                        borderRadius: 5,
                        cursor: busy ? 'not-allowed' : 'pointer',
                        opacity: busy ? 0.6 : 1,
                        transition: 'background 0.1s',
                        whiteSpace: 'nowrap',
                      }}
                      onMouseEnter={(e) => {
                        if (!busy) e.currentTarget.style.background = 'var(--bg-hover)';
                      }}
                      onMouseLeave={(e) => {
                        if (!busy) e.currentTarget.style.background = 'var(--bg-elev)';
                      }}
                    >
                      {bootstrapping ? (
                        <>
                          <span className="spinner" style={{ width: 10, height: 10 }} />
                          Bootstrapping…
                        </>
                      ) : (
                        <>↑ Bootstrap</>
                      )}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
