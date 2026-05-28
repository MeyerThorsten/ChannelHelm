'use client';

/**
 * The Shorts editor shell — composes the preview, timeline, transcript,
 * subtitle styling, metadata, and publish controls into one page.
 *
 * Layout (desktop): two-column 60/40.
 *   Left  → preview · timeline · transcript
 *   Right → collapsible sections: Title & Caption · Subtitles · Description
 *           & Links · Publish options
 *
 * State model:
 *   - The plan's clip is the source of truth, passed in via `clip` prop.
 *   - Editor holds DRAFT state for fields the operator is editing right now.
 *   - Debounced auto-save calls `saveClipEdits` on change.
 *   - Trim changes commit on drag-end (the Timeline component snaps then
 *     emits `onTrimCommit`).
 *   - "Render" button calls `renderClip` and shows a pending indicator.
 *   - "Publish" button opens the modal — same one ShortsList uses.
 */

import { Modal } from '@/components/ui/Modal';
import type { AssStyle } from '@/lib/ass-subtitles';
import type { WordTiming } from '@/lib/word-snap';
import { generateClipDescription, renderClip, saveClipEdits } from '@/server-actions/clip-edit';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { ClipPublishOptions } from './ClipPublishOptions';
import { PreviewPlayer } from './PreviewPlayer';
import { SubtitleOverlay } from './SubtitleOverlay';
import { DEFAULT_STYLE, SubtitleStylePanel } from './SubtitleStylePanel';
import { SubtitleTranslatePanel } from './SubtitleTranslatePanel';
import { Timeline } from './Timeline';
import { TranscriptPanel } from './TranscriptPanel';

type ClipShape = {
  start?: number;
  end?: number;
  trim?: { start: number; end: number };
  title?: string;
  caption?: string;
  description?: string;
  description_generated_at?: string;
  tags?: string[];
  hook_score?: number;
  styling?: Partial<AssStyle>;
  description_links?: { label: string; url: string }[];
  b_roll_enabled?: boolean;
  render_rev?: number;
  pending_render?: boolean;
  publish_options?: {
    platforms?: { youtube?: boolean; tiktok?: boolean; instagram?: boolean };
    privacy?: 'public' | 'unlisted' | 'private' | 'schedule';
    publish_at?: string;
  };
  subtitle_translations?: Record<
    string,
    { srt_path: string; ass_path: string; segments: number; used_fallback?: boolean }
  >;
};

export function ShortsEditor({
  packageId,
  packageTitle,
  planAssetId,
  clipIndex,
  clip,
  sourceVideoUrl,
  sourceDuration,
  words,
  renderedAssetId,
  renderedVideoUrl,
  renderedStatus,
  defaultDescriptionLink,
}: {
  packageId: string;
  packageTitle: string;
  planAssetId: string;
  clipIndex: number;
  clip: ClipShape;
  sourceVideoUrl: string;
  sourceDuration: number;
  words: WordTiming[];
  renderedAssetId: string | null;
  renderedVideoUrl: string | null;
  renderedStatus: string | null;
  /** Source long-form URL (e.g. YouTube watch URL). Used to seed the
   *  first Description Link on plans that don't already have any. */
  defaultDescriptionLink: { label: string; url: string } | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);

  // Effective initial trim/styling — fall back to LLM-suggested values.
  const initialTrim = {
    start: clip.trim?.start ?? clip.start ?? 0,
    end: clip.trim?.end ?? clip.end ?? sourceDuration,
  };
  const initialStyling: AssStyle = {
    ...DEFAULT_STYLE,
    ...(clip.styling ?? {}),
  } as AssStyle;

  // Editor draft state.
  const [title, setTitle] = useState(clip.title ?? '');
  const [caption, setCaption] = useState(clip.caption ?? '');
  const [description, setDescription] = useState(clip.description ?? '');
  const [descriptionPending, setDescriptionPending] = useState(false);
  const [tagsText, setTagsText] = useState((clip.tags ?? []).join(', '));
  const [trim, setTrim] = useState(initialTrim);
  const [styling, setStyling] = useState<AssStyle>(initialStyling);
  const [descriptionLinks, setDescriptionLinks] = useState(clip.description_links ?? []);

  // Live timeline state (separate from trim — drag changes don't save until drop).
  const [draftTrim, setDraftTrim] = useState(initialTrim);
  const [currentTime, setCurrentTime] = useState(initialTrim.start);
  const [playing, setPlaying] = useState(false);

  // Auto-save: any field change schedules a debounced save 800ms later.
  // Trim is committed via Timeline.onTrimCommit (snap-on-drop), which calls
  // doSave({ trim }) immediately — no debounce needed there.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const tags = tagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      doSave({
        title,
        caption,
        description,
        tags,
        styling,
        description_links: descriptionLinks,
      });
    }, 800);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, caption, description, tagsText, styling, descriptionLinks]);

  // ── One-time mount effects: seed Description Links + auto-generate
  //    description. Both gate on "field has never been populated" so
  //    operator edits (including explicit empties) stick across reloads.
  const mountSeedDoneRef = useRef(false);
  useEffect(() => {
    if (mountSeedDoneRef.current) return;
    mountSeedDoneRef.current = true;

    // Seed the first Description Link with the source long-form video URL
    // when the field has never been set (clip.description_links is
    // strictly undefined — distinguished from an operator-emptied []).
    if (clip.description_links === undefined && defaultDescriptionLink) {
      setDescriptionLinks([defaultDescriptionLink]);
    }

    // Auto-generate a description when it's still empty AND we've never
    // tried before for this clip. The server action stamps
    // description_generated_at on success/failure to prevent loops.
    const neverGenerated = !clip.description_generated_at;
    const empty = !clip.description || clip.description.trim() === '';
    if (empty && neverGenerated) {
      setDescriptionPending(true);
      start(async () => {
        try {
          const generated = await generateClipDescription(planAssetId, clipIndex);
          if (generated) setDescription(generated);
        } catch (e) {
          setSaveError(e instanceof Error ? e.message : String(e));
        } finally {
          setDescriptionPending(false);
        }
      });
    }
    // run once on mount — clip/route changes navigate to a fresh editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function doSave(edits: Parameters<typeof saveClipEdits>[2]): void {
    setSaveError(null);
    start(async () => {
      try {
        await saveClipEdits(planAssetId, clipIndex, edits);
        setSavedAt(Date.now());
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function onTrimCommit(next: { start: number; end: number }): void {
    setTrim(next);
    setDraftTrim(next);
    // Pull the playhead inside the new trim if needed.
    if (currentTime < next.start) setCurrentTime(next.start);
    if (currentTime > next.end) setCurrentTime(next.end);
    doSave({ trim: next });
  }

  function doRender(): void {
    setSaveError(null);
    start(async () => {
      try {
        await renderClip(planAssetId, clipIndex);
        router.refresh();
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  const tagsArray = tagsText
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  return (
    <main style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 24px 60px' }}>
      <Header
        packageId={packageId}
        packageTitle={packageTitle}
        clipIndex={clipIndex}
        savedAt={savedAt}
        pending={pending}
        pendingRender={!!clip.pending_render}
        renderedStatus={renderedStatus}
        onRender={doRender}
        onPublish={() => setPublishOpen(true)}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
          gap: 24,
          marginTop: 18,
        }}
      >
        {/* LEFT — preview · timeline · transcript */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 18,
              display: 'flex',
              justifyContent: 'center',
            }}
          >
            {/* position:relative wrapper sized to the video element so the
                SubtitleOverlay can position absolutely on top of it. The
                overlay is hidden when we're already playing the
                burned-in rendered MP4 — two sets of subs = visual mess. */}
            <div
              style={{
                position: 'relative',
                width: '100%',
                maxWidth: 360,
                aspectRatio: '9/16',
              }}
            >
              <PreviewPlayer
                src={renderedVideoUrl ?? sourceVideoUrl}
                currentTime={currentTime}
                playing={playing}
                trimStart={trim.start}
                trimEnd={trim.end}
                onTimeUpdate={setCurrentTime}
                onPlayingChange={setPlaying}
              />
              {/* Always show the overlay — operator wants live styling
                  feedback even when a rendered MP4 with older burned-in
                  subs is playing, so they can compare "what's live now"
                  vs "what the next render would produce". */}
              <SubtitleOverlay
                currentTime={currentTime}
                trimStart={trim.start}
                trimEnd={trim.end}
                words={words}
                style={styling}
              />
              {words.length === 0 && (
                <div
                  style={{
                    position: 'absolute',
                    top: 8,
                    left: 8,
                    padding: '4px 8px',
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--status-failed)',
                    background: 'rgba(0,0,0,0.65)',
                    borderRadius: 4,
                    pointerEvents: 'none',
                    maxWidth: '85%',
                  }}
                >
                  ⚠ no word-level transcript for this package — live subtitle overlay disabled.
                  Re-run transcribe_audio with word_timestamps=true to enable.
                </div>
              )}
            </div>
          </div>

          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 18,
            }}
          >
            <Timeline
              trimStart={draftTrim.start}
              trimEnd={draftTrim.end}
              currentTime={currentTime}
              sourceDuration={sourceDuration}
              words={words}
              onTrimChange={setDraftTrim}
              onTrimCommit={onTrimCommit}
              onSeek={setCurrentTime}
            />
          </div>

          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 18,
            }}
          >
            <TranscriptPanel
              words={words}
              trimStart={trim.start}
              trimEnd={trim.end}
              currentTime={currentTime}
              onSeek={setCurrentTime}
            />
          </div>
        </div>

        {/* RIGHT — collapsible sections */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <Section title="Title & Caption">
            <FieldLabel>Title</FieldLabel>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={`Clip ${clipIndex + 1}`}
              maxLength={100}
              style={textInput()}
            />
            <p style={hint()}>≤ 70 chars renders best on YouTube Shorts / TikTok</p>

            <FieldLabel style={{ marginTop: 10 }}>Caption Title (on-screen overlay)</FieldLabel>
            <input
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Big overlay text — keep short"
              maxLength={200}
              style={textInput()}
            />
            <p style={hint()}>≤ 50 chars stays readable in vertical view</p>
          </Section>

          <Section title="Subtitles">
            <SubtitleStylePanel value={styling} onChange={setStyling} />
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <SubtitleTranslatePanel
                planAssetId={planAssetId}
                clipIndex={clipIndex}
                existing={clip.subtitle_translations ?? {}}
                hasTranscript={words.length > 0}
                onTranslated={() => router.refresh()}
              />
            </div>
          </Section>

          <Section title="Description & Tags">
            <FieldLabel>
              Description (post body for TikTok / Reels / Shorts)
              {descriptionPending && (
                <span style={{ marginLeft: 8, color: 'var(--accent)' }}>✨ generating…</span>
              )}
            </FieldLabel>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              placeholder={
                descriptionPending
                  ? 'Generating a description from the clip transcript…'
                  : 'Lead with the hook, add 2-3 hashtags inline, end with a question or CTA.'
              }
              disabled={descriptionPending}
              style={{
                ...textareaStyle(),
                opacity: descriptionPending ? 0.6 : 1,
              }}
            />

            <FieldLabel style={{ marginTop: 10 }}>Tags (comma-separated)</FieldLabel>
            <input
              type="text"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="ai, prompt engineering, hardware"
              style={textInput('mono')}
            />
            {tagsArray.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                {tagsArray.map((t, i) => (
                  <span
                    key={`${t}-${i}`}
                    style={{
                      fontSize: 11,
                      padding: '2px 7px',
                      background: 'var(--panel-2)',
                      border: '1px solid var(--border-strong)',
                      borderRadius: 4,
                      color: 'var(--text-muted)',
                    }}
                  >
                    #{t}
                  </span>
                ))}
              </div>
            )}

            <FieldLabel style={{ marginTop: 10 }}>Description Links</FieldLabel>
            <DescriptionLinksEditor value={descriptionLinks} onChange={setDescriptionLinks} />
          </Section>

          <Section title="Publish options">
            <ClipPublishOptions
              planAssetId={planAssetId}
              clipIndex={clipIndex}
              renderedAssetId={renderedAssetId}
              initialPlatforms={clip.publish_options?.platforms ?? {}}
              initialPrivacy={clip.publish_options?.privacy ?? 'private'}
              initialPublishAt={clip.publish_options?.publish_at ?? null}
              onDone={() => router.refresh()}
            />
          </Section>
        </div>
      </div>

      {saveError && (
        <p
          style={{
            marginTop: 14,
            padding: '8px 12px',
            background: 'color-mix(in oklab, var(--status-failed) 10%, transparent)',
            border: '1px solid color-mix(in oklab, var(--status-failed) 28%, transparent)',
            borderRadius: 6,
            fontSize: 12,
            color: 'var(--status-failed)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {saveError}
        </p>
      )}

      <Modal open={publishOpen} onClose={() => setPublishOpen(false)} title="Publish Short">
        <ClipPublishOptions
          planAssetId={planAssetId}
          clipIndex={clipIndex}
          renderedAssetId={renderedAssetId}
          initialPlatforms={clip.publish_options?.platforms ?? {}}
          initialPrivacy={clip.publish_options?.privacy ?? 'private'}
          initialPublishAt={clip.publish_options?.publish_at ?? null}
          onDone={() => {
            setPublishOpen(false);
            router.refresh();
          }}
        />
      </Modal>
    </main>
  );
}

// ─── presentational sub-components ───────────────────────────────────────

function Header({
  packageId,
  packageTitle,
  clipIndex,
  savedAt,
  pending,
  pendingRender,
  renderedStatus,
  onRender,
  onPublish,
}: {
  packageId: string;
  packageTitle: string;
  clipIndex: number;
  savedAt: number | null;
  pending: boolean;
  pendingRender: boolean;
  renderedStatus: string | null;
  onRender: () => void;
  onPublish: () => void;
}) {
  const recentlySaved = savedAt && Date.now() - savedAt < 3000;
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        paddingBottom: 14,
        borderBottom: '1px solid var(--border)',
      }}
    >
      <a
        href={`/packages/${packageId}`}
        style={{
          fontSize: 12,
          color: 'var(--text-muted)',
          textDecoration: 'none',
          padding: '6px 10px',
          background: 'var(--panel-2)',
          border: '1px solid var(--border-strong)',
          borderRadius: 6,
        }}
      >
        ←
      </a>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-faint)',
            fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {packageTitle} · clip {clipIndex + 1}
        </div>
        <h1
          style={{
            margin: '4px 0 0',
            fontSize: 24,
            fontWeight: 600,
            letterSpacing: '-0.3px',
          }}
        >
          Short editor
        </h1>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {pending && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-faint)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            saving…
          </span>
        )}
        {!pending && recentlySaved && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--status-published)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            ✓ saved
          </span>
        )}
        {renderedStatus && (
          <span
            style={{
              fontSize: 10,
              padding: '2px 8px',
              borderRadius: 999,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-muted)',
              border: '1px solid var(--border-strong)',
              background: 'var(--panel-2)',
            }}
          >
            {renderedStatus}
          </span>
        )}
        <button
          type="button"
          onClick={onRender}
          disabled={pending || pendingRender}
          style={{
            padding: '8px 14px',
            fontSize: 13,
            fontWeight: 600,
            background: 'var(--panel-2)',
            color: 'var(--text)',
            border: '1px solid var(--border-strong)',
            borderRadius: 7,
            cursor: pending || pendingRender ? 'wait' : 'pointer',
          }}
        >
          {pendingRender ? '⏳ Rendering…' : '↺ Render'}
        </button>
        <button
          type="button"
          onClick={onPublish}
          disabled={pending}
          style={{
            padding: '8px 16px',
            fontSize: 13,
            fontWeight: 600,
            background: 'var(--accent)',
            color: '#fff',
            border: '1px solid color-mix(in oklab, var(--accent) 80%, white)',
            borderRadius: 7,
            cursor: 'pointer',
          }}
        >
          ↗ Publish
        </button>
      </div>
    </header>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 16,
      }}
    >
      <h3
        style={{
          margin: '0 0 12px',
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text)',
        }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

function FieldLabel({
  children,
  style,
}: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        fontSize: 10,
        color: 'var(--text-faint)',
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        marginBottom: 4,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function textInput(font: 'sans' | 'mono' = 'sans'): React.CSSProperties {
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

function textareaStyle(): React.CSSProperties {
  return {
    ...textInput(),
    fontFamily: 'var(--font-sans)',
    resize: 'vertical',
    lineHeight: 1.55,
  };
}

function hint(): React.CSSProperties {
  return {
    margin: '4px 2px 0',
    fontSize: 10,
    color: 'var(--text-faint)',
    lineHeight: 1.5,
  };
}

function DescriptionLinksEditor({
  value,
  onChange,
}: {
  value: { label: string; url: string }[];
  onChange: (next: { label: string; url: string }[]) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {value.map((link, i) => (
        <div key={i} style={{ display: 'flex', gap: 4 }}>
          <input
            type="text"
            value={link.label}
            placeholder="Label"
            onChange={(e) => {
              const next = value.slice();
              next[i] = { ...link, label: e.target.value };
              onChange(next);
            }}
            style={{ ...textInput(), flex: 1 }}
          />
          <input
            type="url"
            value={link.url}
            placeholder="https://…"
            onChange={(e) => {
              const next = value.slice();
              next[i] = { ...link, url: e.target.value };
              onChange(next);
            }}
            style={{ ...textInput('mono'), flex: 2 }}
          />
          <button
            type="button"
            onClick={() => {
              const next = value.slice();
              next.splice(i, 1);
              onChange(next);
            }}
            style={{
              padding: '0 10px',
              background: 'transparent',
              border: '1px solid var(--border-strong)',
              borderRadius: 5,
              color: 'var(--text-faint)',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>
      ))}
      {value.length < 8 && (
        <button
          type="button"
          onClick={() => onChange([...value, { label: '', url: '' }])}
          style={{
            padding: '6px 10px',
            background: 'transparent',
            color: 'var(--accent)',
            border: '1px dashed color-mix(in oklab, var(--accent) 35%, var(--border))',
            borderRadius: 5,
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          + Add link
        </button>
      )}
    </div>
  );
}
