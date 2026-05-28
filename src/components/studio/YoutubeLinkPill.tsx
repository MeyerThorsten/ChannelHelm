'use client';

import { clearPackageYoutubeUrl, setPackageYoutubeUrl } from '@/server-actions/youtube-link';
import { useState, useTransition } from 'react';

/**
 * Header chip that:
 *  - When unset + at least one youtube_* asset is `dispatched`: shows a
 *    compact "+ Paste YouTube URL" affordance that expands to an inline
 *    input on click.
 *  - When set: shows "▶ youtu.be/<id>" as a clickable link (new tab) with a
 *    small ✎ to edit / 🗑 to clear.
 *  - When unset AND nothing has been dispatched yet: renders nothing — no
 *    point asking before the operator's uploaded.
 */
export function YoutubeLinkPill({
  packageId,
  initialUrl,
  initialVideoId,
  showPasteAffordance,
}: {
  packageId: string;
  initialUrl: string | null;
  initialVideoId: string | null;
  showPasteAffordance: boolean;
}) {
  const [url, setUrl] = useState<string | null>(initialUrl);
  const [videoId, setVideoId] = useState<string | null>(initialVideoId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function commit(): void {
    setError(null);
    const value = draft.trim();
    if (!value) {
      setEditing(false);
      return;
    }
    start(async () => {
      try {
        const ref = await setPackageYoutubeUrl(packageId, value);
        setUrl(ref.url);
        setVideoId(ref.videoId);
        setEditing(false);
        setDraft('');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function clear(): void {
    start(async () => {
      try {
        await clearPackageYoutubeUrl(packageId);
        setUrl(null);
        setVideoId(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  // Published — show link + edit affordances.
  if (url) {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 9px 3px 7px',
          fontSize: 11,
          fontWeight: 500,
          color: '#ff0033',
          background: 'color-mix(in oklab, #ff0033 12%, transparent)',
          border: '1px solid color-mix(in oklab, #ff0033 28%, transparent)',
          borderRadius: 999,
          fontFamily: 'var(--font-sans)',
        }}
      >
        <span style={{ fontSize: 9 }}>▶</span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: 'inherit',
            textDecoration: 'none',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
          }}
          title="Open on YouTube (new tab)"
        >
          youtu.be/{videoId}
        </a>
        <button
          type="button"
          onClick={() => {
            setDraft(url);
            setEditing(true);
          }}
          disabled={pending}
          title="Edit URL"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            padding: '0 2px',
            fontSize: 11,
            opacity: 0.7,
          }}
        >
          ✎
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={pending}
          title="Clear URL"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            padding: '0 2px',
            fontSize: 11,
            opacity: 0.5,
          }}
        >
          🗑
        </button>
        {editing && (
          <UrlEditor
            initial={url}
            draft={draft}
            setDraft={setDraft}
            commit={commit}
            cancel={() => {
              setEditing(false);
              setError(null);
              setDraft('');
            }}
            pending={pending}
            error={error}
          />
        )}
      </span>
    );
  }

  // Not yet published — only show the paste affordance once something's been
  // dispatched (no point asking otherwise).
  if (!showPasteAffordance) return null;

  if (editing) {
    return (
      <UrlEditor
        initial=""
        draft={draft}
        setDraft={setDraft}
        commit={commit}
        cancel={() => {
          setEditing(false);
          setError(null);
          setDraft('');
        }}
        pending={pending}
        error={error}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 9px',
        fontSize: 11,
        fontWeight: 500,
        color: 'var(--text-faint)',
        background: 'transparent',
        border: '1px dashed var(--border-strong)',
        borderRadius: 999,
        cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
      }}
      title="Paste the YouTube URL after you upload the video manually"
    >
      + Paste YouTube URL
    </button>
  );
}

function UrlEditor({
  initial: _initial,
  draft,
  setDraft,
  commit,
  cancel,
  pending,
  error,
}: {
  initial: string;
  draft: string;
  setDraft: (v: string) => void;
  commit: () => void;
  cancel: () => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        marginLeft: 6,
      }}
    >
      <input
        autoFocus
        type="url"
        placeholder="https://youtu.be/…"
        value={draft}
        disabled={pending}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') cancel();
        }}
        style={{
          padding: '3px 8px',
          fontSize: 11,
          minWidth: 220,
          background: 'var(--bg-elev)',
          border: '1px solid var(--border-strong)',
          borderRadius: 5,
          color: 'var(--text)',
          fontFamily: 'var(--font-mono)',
        }}
      />
      <button
        type="button"
        onClick={commit}
        disabled={pending || !draft.trim()}
        style={{
          padding: '3px 9px',
          fontSize: 11,
          fontWeight: 500,
          background: 'var(--accent)',
          color: '#fff',
          border: '1px solid color-mix(in oklab, var(--accent) 75%, white)',
          borderRadius: 5,
          cursor: pending ? 'wait' : 'pointer',
          opacity: !draft.trim() ? 0.5 : 1,
        }}
      >
        {pending ? '…' : 'Save'}
      </button>
      <button
        type="button"
        onClick={cancel}
        disabled={pending}
        style={{
          padding: '3px 6px',
          fontSize: 11,
          background: 'transparent',
          color: 'var(--text-faint)',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        Cancel
      </button>
      {error && (
        <span
          style={{
            fontSize: 10,
            color: 'var(--status-failed)',
            marginLeft: 4,
            fontFamily: 'var(--font-mono)',
          }}
        >
          {error}
        </span>
      )}
    </span>
  );
}
