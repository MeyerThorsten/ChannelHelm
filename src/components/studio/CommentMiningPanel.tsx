'use client';

/**
 * CommentMiningPanel — post-publish "comment mining → content loop" UI.
 *
 * Mount point: ConsoleLayout > YoutubeStack, alongside ExperimentsPanel, gated
 * on a published video existing (StudioShell). Calls the mineComments server
 * action (synchronous LLM carve-out) and renders the returned counts plus the
 * content_ideas + faq assets loaded by the server page.
 */

import { Eyebrow, GhostBtn } from '@/components/ui';
import { mineComments } from '@/server-actions/comment-mining';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

export type ContentIdea = { title: string; angle: string };
export type FaqItem = { question: string; answer: string };

export type CommentMiningPanelProps = {
  packageId: string;
  hasPublishedVideo: boolean;
  ideas: ContentIdea[];
  faq: FaqItem[];
};

export function CommentMiningPanel({
  packageId,
  hasPublishedVideo,
  ideas,
  faq,
}: CommentMiningPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ comments: number; ideas: number; faq: number } | null>(
    null,
  );

  function run() {
    setError(null);
    startTransition(async () => {
      try {
        const r = await mineComments(packageId);
        setResult(r);
        router.refresh(); // pull the freshly-upserted assets back into the page
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  const hasContent = ideas.length > 0 || faq.length > 0;

  return (
    <div
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        overflow: 'hidden',
        marginTop: 14,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--panel-strong)',
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--border)',
            borderRadius: 5,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          💬
        </span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Comment mining</span>
        <span style={{ flex: 1 }} />
        <GhostBtn
          size="sm"
          icon="⛏"
          onClick={run}
          disabled={pending || !hasPublishedVideo}
          title={
            hasPublishedVideo
              ? 'Pull top YouTube comments → next-video ideas + viewer FAQ'
              : 'Publish the video to YouTube first'
          }
        >
          {pending ? 'Mining…' : hasContent ? 'Re-mine comments' : 'Mine comments'}
        </GhostBtn>
      </div>

      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {!hasPublishedVideo && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
            Comments only exist after the video is live. Publish via YouTube Direct, then mine.
          </p>
        )}

        {error && (
          <p
            style={{
              fontSize: 12,
              color: 'var(--status-failed)',
              margin: 0,
              whiteSpace: 'pre-wrap',
            }}
          >
            {error}
          </p>
        )}

        {result && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
            Mined {result.comments} comments → {result.ideas} ideas, {result.faq} FAQ entries.
          </p>
        )}

        {ideas.length > 0 && (
          <div>
            <Eyebrow>Next-video ideas</Eyebrow>
            <ol style={{ margin: '8px 0 0', paddingLeft: 18, display: 'grid', gap: 8 }}>
              {ideas.map((idea, i) => (
                <li key={`idea-${i}-${idea.title}`} style={{ fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>{idea.title}</span>
                  {idea.angle && (
                    <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12 }}>
                      {idea.angle}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}

        {faq.length > 0 && (
          <div>
            <Eyebrow>Viewer FAQ</Eyebrow>
            <dl style={{ margin: '8px 0 0', display: 'grid', gap: 10 }}>
              {faq.map((item, i) => (
                <div key={`faq-${i}-${item.question}`}>
                  <dt style={{ fontSize: 13, fontWeight: 600 }}>{item.question}</dt>
                  <dd style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                    {item.answer}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {hasPublishedVideo && !hasContent && !pending && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
            No mined ideas yet. Click “Mine comments” to pull the top comments and turn them into
            next-video ideas + a viewer FAQ.
          </p>
        )}
      </div>
    </div>
  );
}
