'use client';

/**
 * Per-clip publish options control. Renders:
 *   - 3 platform checkboxes (YouTube · TikTok · Instagram)
 *   - 4 privacy radios (Public · Unlisted · Private · Schedule)
 *   - datetime-local input (shown only for Schedule)
 *   - "Publish now" + "Save as draft" buttons
 *
 * Used in two contexts:
 *   - Inside the publish Modal (triggered from the Shorts list row or
 *     the editor's bottom bar)
 *   - Inline as a collapsible section in the editor's right rail
 *
 * The component owns its draft state; on Publish it (a) persists the
 * options via `setClipPublishOptions`, then (b) calls the parent's
 * `onPublish()` which typically invokes `publishAsset(renderedAssetId)`.
 * "Save as draft" only persists the options.
 */

import { publishAsset } from '@/server-actions/publish';
import { setClipPublishOptions } from '@/server-actions/clip-edit';
import { useState, useTransition } from 'react';

type Privacy = 'public' | 'unlisted' | 'private' | 'schedule';
type Platforms = { youtube?: boolean; tiktok?: boolean; instagram?: boolean };

export function ClipPublishOptions({
  planAssetId,
  clipIndex,
  renderedAssetId,
  initialPlatforms,
  initialPrivacy,
  initialPublishAt,
  onDone,
}: {
  planAssetId: string;
  clipIndex: number;
  /** When set, "Publish now" calls publishAsset(renderedAssetId). When null, only Save-as-draft is shown. */
  renderedAssetId: string | null;
  initialPlatforms: Platforms;
  initialPrivacy: Privacy;
  initialPublishAt: string | null;
  onDone?: () => void;
}) {
  const [platforms, setPlatforms] = useState<Platforms>(
    initialPlatforms.youtube || initialPlatforms.tiktok || initialPlatforms.instagram
      ? initialPlatforms
      : { youtube: true, tiktok: true, instagram: true },
  );
  const [privacy, setPrivacy] = useState<Privacy>(initialPrivacy);
  const [publishAt, setPublishAt] = useState<string>(
    initialPublishAt ? toLocalInputValue(initialPublishAt) : '',
  );
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  function togglePlatform(net: keyof Platforms): void {
    setPlatforms((p) => ({ ...p, [net]: !p[net] }));
  }

  function buildOptions() {
    if (privacy === 'schedule' && !publishAt) {
      throw new Error('Pick a publish date and time before saving the schedule.');
    }
    return {
      platforms,
      privacy,
      ...(privacy === 'schedule'
        ? { publish_at: new Date(publishAt).toISOString() }
        : {}),
    };
  }

  function saveDraft(): void {
    setError(null);
    setOkMsg(null);
    start(async () => {
      try {
        await setClipPublishOptions(planAssetId, clipIndex, buildOptions());
        setOkMsg('Saved as draft');
        onDone?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function publishNow(): void {
    setError(null);
    setOkMsg(null);
    if (!renderedAssetId) {
      setError('Render this clip first — there\'s nothing to publish yet.');
      return;
    }
    start(async () => {
      try {
        await setClipPublishOptions(planAssetId, clipIndex, buildOptions());
        await publishAsset(renderedAssetId);
        setOkMsg(
          privacy === 'schedule'
            ? `Scheduled for ${new Date(publishAt).toLocaleString()}`
            : 'Dispatching…',
        );
        onDone?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Section label="Platforms">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <PlatformRow icon="▶" name="YouTube Shorts" on={!!platforms.youtube} onClick={() => togglePlatform('youtube')} />
          <PlatformRow icon="♪" name="TikTok" on={!!platforms.tiktok} onClick={() => togglePlatform('tiktok')} />
          <PlatformRow icon="◎" name="Instagram Reels" on={!!platforms.instagram} onClick={() => togglePlatform('instagram')} />
        </div>
      </Section>

      <Section label="When">
        <select
          value={privacy}
          disabled={pending}
          onChange={(e) => setPrivacy(e.target.value as Privacy)}
          style={inputStyle()}
        >
          <option value="public">🌐  Public — live on publish</option>
          <option value="unlisted">🔗  Unlisted — link only</option>
          <option value="private">🔒  Draft / Private</option>
          <option value="schedule">⏰  Schedule for…</option>
        </select>
        {privacy === 'schedule' && (
          <div style={{ marginTop: 8 }}>
            <input
              type="datetime-local"
              value={publishAt}
              min={minLocalDatetime()}
              disabled={pending}
              onChange={(e) => setPublishAt(e.target.value)}
              style={inputStyle('mono')}
            />
            <p style={hintStyle()}>
              Local time · ≥1 minute in the future · YouTube/TikTok/Instagram auto-publish at the chosen time
            </p>
          </div>
        )}
      </Section>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={saveDraft} disabled={pending} style={ghostBtn()}>
          Save as draft
        </button>
        <button
          type="button"
          onClick={publishNow}
          disabled={pending || !renderedAssetId}
          style={primaryBtn(!renderedAssetId)}
          title={renderedAssetId ? '' : 'Render this clip first'}
        >
          {privacy === 'schedule' ? 'Schedule publish' : 'Publish now'}
        </button>
      </div>

      {error && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--status-failed)' }}>{error}</p>
      )}
      {okMsg && !error && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--status-published)' }}>✓ {okMsg}</p>
      )}
    </div>
  );
}

// ─── tiny helpers ─────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          color: 'var(--text-faint)',
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function PlatformRow({
  icon,
  name,
  on,
  onClick,
}: {
  icon: string;
  name: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        background: on
          ? 'color-mix(in oklab, var(--accent) 10%, transparent)'
          : 'var(--panel-2)',
        border: `1px solid ${on ? 'color-mix(in oklab, var(--accent) 35%, transparent)' : 'var(--border)'}`,
        borderRadius: 7,
        cursor: 'pointer',
        color: 'var(--text)',
        fontSize: 13,
        fontFamily: 'var(--font-sans)',
        textAlign: 'left',
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          background: on ? 'var(--accent)' : 'transparent',
          border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border-strong)'}`,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontSize: 10,
        }}
      >
        {on && '✓'}
      </span>
      <span style={{ fontSize: 14 }}>{icon}</span>
      <span>{name}</span>
    </button>
  );
}

function inputStyle(font: 'sans' | 'mono' = 'sans'): React.CSSProperties {
  return {
    width: '100%',
    padding: '8px 10px',
    fontSize: 13,
    background: 'var(--panel-2)',
    border: '1px solid var(--border-strong)',
    borderRadius: 6,
    color: 'var(--text)',
    fontFamily: font === 'mono' ? 'var(--font-mono)' : 'var(--font-sans)',
  };
}

function hintStyle(): React.CSSProperties {
  return {
    margin: '6px 2px 0',
    fontSize: 11,
    color: 'var(--text-faint)',
    lineHeight: 1.5,
  };
}

function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
    background: 'var(--accent)',
    color: '#fff',
    border: '1px solid color-mix(in oklab, var(--accent) 80%, white)',
    borderRadius: 7,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}

function ghostBtn(): React.CSSProperties {
  return {
    padding: '8px 14px',
    fontSize: 13,
    background: 'transparent',
    color: 'var(--text-muted)',
    border: '1px solid var(--border-strong)',
    borderRadius: 7,
    cursor: 'pointer',
  };
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
