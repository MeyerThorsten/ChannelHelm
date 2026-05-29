'use client';

import { setYoutubeDispatchTarget } from '@/server-actions/youtube-brand';
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * "YouTube connection" card on /brands/[id]. Three states:
 *  - **Not configured (env)** — operator hasn't pasted GOOGLE_OAUTH_CLIENT_ID yet
 *    → show a hint linking to /settings.
 *  - **Connected** — show channel name + Disconnect + dispatch-target selector.
 *  - **Not connected** — show Connect button (links to /api/youtube/oauth/start).
 *
 * Server-rendered status is passed in via `initialStatus`; client owns the
 * disconnect + target-switch transitions.
 */
export function YoutubeConnectionCard({
  brandId,
  oauthClientConfigured,
  initialStatus,
  initialTarget,
  flash,
}: {
  brandId: string;
  oauthClientConfigured: boolean;
  initialStatus: {
    connected: boolean;
    channelTitle: string | null;
    channelId: string | null;
    connectedAt: string | null;
  };
  initialTarget: 'manual' | 'youtube_direct' | 'zernio';
  flash: { kind: 'connected' | 'cancelled' | 'error'; msg?: string; channel?: string } | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [target, setTarget] = useState(initialTarget);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // The OAuth routes build redirect_uri from the live request origin
  // (req.nextUrl.origin), so the URI to register in Google Cloud Console is
  // whatever origin you're browsing on — not a hardcoded port. Resolve it
  // client-side to stay correct across port changes (e.g. 3000 → 3002).
  const [callbackUri, setCallbackUri] = useState('/api/youtube/oauth/callback');
  useEffect(() => {
    setCallbackUri(`${window.location.origin}/api/youtube/oauth/callback`);
  }, []);

  function disconnect(): void {
    setError(null);
    start(async () => {
      try {
        const res = await fetch(
          `/api/youtube/oauth/disconnect?brandId=${encodeURIComponent(brandId)}`,
          { method: 'POST' },
        );
        if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'disconnect failed');
        setStatus({ connected: false, channelTitle: null, channelId: null, connectedAt: null });
        setTarget('manual');
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function changeTarget(next: 'manual' | 'youtube_direct' | 'zernio'): void {
    setError(null);
    setTarget(next);
    start(async () => {
      try {
        await setYoutubeDispatchTarget(brandId, next);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        // Roll back optimistic state.
        setTarget(initialTarget);
      }
    });
  }

  return (
    <section
      style={{
        marginBottom: 22,
        padding: 18,
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span
          style={{
            width: 28,
            height: 20,
            background: '#ff0033',
            borderRadius: 5,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          YT
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>YouTube connection</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            Direct upload via YouTube Data API v3 — bypasses Zernio and the Cloudflare Tunnel.
          </div>
        </div>
        {status.connected && (
          <span
            style={{
              padding: '2px 9px',
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              borderRadius: 999,
              color: 'var(--status-published)',
              background: 'color-mix(in oklab, var(--status-published) 12%, transparent)',
              border: '1px solid color-mix(in oklab, var(--status-published) 28%, transparent)',
            }}
          >
            connected
          </span>
        )}
      </div>

      {flash?.kind === 'connected' && (
        <FlashBanner tone="ok">
          ✓ Connected to {flash.channel ? <strong>{flash.channel}</strong> : 'YouTube'} —
          tokens encrypted at rest.
        </FlashBanner>
      )}
      {flash?.kind === 'cancelled' && (
        <FlashBanner tone="warn">Cancelled — no tokens stored.</FlashBanner>
      )}
      {flash?.kind === 'error' && (
        <FlashBanner tone="err">OAuth failed: {flash.msg ?? 'unknown error'}</FlashBanner>
      )}

      {!oauthClientConfigured ? (
        <div
          style={{
            padding: 12,
            background: 'color-mix(in oklab, var(--status-ready) 8%, var(--bg-elev-2))',
            border: '1px solid color-mix(in oklab, var(--status-ready) 25%, var(--border))',
            borderRadius: 8,
            fontSize: 13,
            color: 'var(--text-muted)',
            lineHeight: 1.55,
          }}
        >
          ⚠ Google OAuth client isn&apos;t configured yet. Set{' '}
          <code>GOOGLE_OAUTH_CLIENT_ID</code> + <code>GOOGLE_OAUTH_CLIENT_SECRET</code> on{' '}
          <a href="/settings" style={{ color: 'var(--accent)' }}>
            /settings
          </a>{' '}
          first. The values come from Google Cloud Console → APIs &amp; Services → Credentials
          (Web app OAuth client). Authorized redirect URI:{' '}
          <code>{callbackUri}</code>.
        </div>
      ) : status.connected ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div
            style={{
              padding: 12,
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--border)',
              borderRadius: 7,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              {status.channelTitle ?? '(channel name unavailable)'}
            </div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-faint)',
                fontFamily: 'var(--font-mono)',
                marginTop: 4,
              }}
            >
              {status.channelId ?? '—'} · connected{' '}
              {status.connectedAt ? new Date(status.connectedAt).toLocaleString() : ''}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label
              style={{
                fontSize: 11,
                color: 'var(--text-faint)',
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Dispatch target for this brand&apos;s YouTube videos
            </label>
            <TargetPicker target={target} onChange={changeTarget} disabled={pending} />
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={disconnect}
              disabled={pending}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                background: 'transparent',
                color: 'var(--status-failed)',
                border: '1px solid color-mix(in oklab, var(--status-failed) 30%, var(--border))',
                borderRadius: 6,
                cursor: pending ? 'wait' : 'pointer',
              }}
            >
              {pending ? '…' : 'Disconnect'}
            </button>
          </div>
        </div>
      ) : (
        <ConnectArea brandId={brandId} />
      )}

      {error && (
        <p
          style={{
            marginTop: 10,
            fontSize: 12,
            color: 'var(--status-failed)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {error}
        </p>
      )}
    </section>
  );
}

function ConnectArea({ brandId }: { brandId: string }) {
  const [hint, setHint] = useState('');
  const trimmed = hint.trim();
  const connectHref =
    `/api/youtube/oauth/start?brandId=${encodeURIComponent(brandId)}` +
    (trimmed ? `&login_hint=${encodeURIComponent(trimmed)}` : '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p
        style={{
          margin: 0,
          fontSize: 13,
          color: 'var(--text-muted)',
          lineHeight: 1.55,
        }}
      >
        One-time consent on Google. You&apos;ll be redirected to{' '}
        <code>accounts.google.com</code>, then back here. Tokens are encrypted at rest with{' '}
        <code>PROVIDER_SECRET_KEY</code> and never sent back to the browser.
      </p>
      <div
        style={{
          padding: 12,
          background: 'color-mix(in oklab, var(--accent) 6%, var(--bg-elev-2))',
          border: '1px solid color-mix(in oklab, var(--accent) 22%, var(--border))',
          borderRadius: 8,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-faint)',
            fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: 6,
          }}
        >
          Pick the right Google account
        </div>
        <p
          style={{
            margin: '0 0 10px',
            fontSize: 12.5,
            color: 'var(--text-muted)',
            lineHeight: 1.55,
          }}
        >
          On the next screen, Google will show its account chooser even if your browser is
          already signed in. Pick <strong>the Google account that owns your YouTube channel</strong>{' '}
          — that&apos;s the one that needs the upload grant. Pre-fill the chooser below if you
          want to skip the scroll.
        </p>
        <input
          type="email"
          placeholder="photomocha@gmail.com  (optional pre-fill)"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          spellCheck={false}
          autoComplete="email"
          style={{
            width: '100%',
            padding: '8px 10px',
            fontSize: 13,
            background: 'var(--bg-elev)',
            border: '1px solid var(--border-strong)',
            borderRadius: 6,
            color: 'var(--text)',
            fontFamily: 'var(--font-mono)',
            marginBottom: 10,
          }}
        />
        <a
          href={connectHref}
          style={{
            display: 'inline-block',
            padding: '9px 14px',
            fontSize: 13,
            fontWeight: 600,
            borderRadius: 7,
            background: '#ff0033',
            color: '#fff',
            border: '1px solid color-mix(in oklab, #ff0033 80%, white)',
            textDecoration: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          ▶ Connect YouTube{trimmed ? ` as ${trimmed}` : ''}
        </a>
      </div>
      <p
        style={{
          margin: 0,
          fontSize: 11.5,
          color: 'var(--text-faint)',
          lineHeight: 1.55,
        }}
      >
        <strong style={{ color: 'var(--status-ready)' }}>Tip:</strong> if Google still picks the
        wrong account, sign out of every Google session in this browser first (
        <a
          href="https://accounts.google.com/Logout"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--accent)' }}
        >
          accounts.google.com/Logout
        </a>
        ), then come back and Connect — or do the whole flow in a Chrome profile / incognito
        window signed in as the right account.
      </p>
    </div>
  );
}

function TargetPicker({
  target,
  onChange,
  disabled,
}: {
  target: 'manual' | 'youtube_direct' | 'zernio';
  onChange: (next: 'manual' | 'youtube_direct' | 'zernio') => void;
  disabled: boolean;
}) {
  const opts: { v: 'manual' | 'youtube_direct' | 'zernio'; label: string; help: string }[] = [
    { v: 'manual', label: 'Manual', help: 'You paste the URL after uploading via YouTube Studio.' },
    {
      v: 'youtube_direct',
      label: 'Direct (this connection)',
      help: 'Approving the package uploads the video via the connected YouTube account.',
    },
    {
      v: 'zernio',
      label: 'Zernio (LATE)',
      help: 'Requires Cloudflare Tunnel + brand.zernio_accounts.youtube set.',
    },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {opts.map((o) => (
        <label
          key={o.v}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '6px 10px',
            background: target === o.v ? 'color-mix(in oklab, var(--accent) 8%, transparent)' : 'transparent',
            border: `1px solid ${target === o.v ? 'color-mix(in oklab, var(--accent) 30%, transparent)' : 'var(--border)'}`,
            borderRadius: 6,
            cursor: disabled ? 'wait' : 'pointer',
            opacity: disabled ? 0.6 : 1,
          }}
        >
          <input
            type="radio"
            name="ytTarget"
            checked={target === o.v}
            disabled={disabled}
            onChange={() => onChange(o.v)}
            style={{ marginTop: 3 }}
          />
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{o.label}</div>
            <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{o.help}</div>
          </div>
        </label>
      ))}
    </div>
  );
}

function FlashBanner({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'err';
  children: React.ReactNode;
}) {
  const color =
    tone === 'ok'
      ? 'var(--status-published)'
      : tone === 'warn'
        ? 'var(--status-ready)'
        : 'var(--status-failed)';
  return (
    <div
      style={{
        margin: '0 0 12px',
        padding: '8px 12px',
        background: `color-mix(in oklab, ${color} 10%, transparent)`,
        border: `1px solid color-mix(in oklab, ${color} 28%, transparent)`,
        borderRadius: 6,
        fontSize: 12,
        color,
        fontFamily: 'var(--font-sans)',
      }}
    >
      {children}
    </div>
  );
}
