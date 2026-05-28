'use client';

/**
 * First-class modal primitive for ChannelHelm.
 *
 * Until now the codebase relied entirely on inline panels — `ui.tsx` has
 * no Dialog/Overlay/Portal exports. This is the first dialog: 80 lines,
 * inline styles to match the rest of `ui.tsx`, no animation dependency,
 * no headless-ui dep.
 *
 * Behaviours:
 *   - Portal to document.body (so it escapes overflow/transform parents)
 *   - Backdrop click → onClose
 *   - Escape → onClose
 *   - Body scroll lock while open
 *   - Click inside content area DOES NOT close (event.stopPropagation)
 *   - aria-modal=true, role=dialog, aria-labelledby points at title
 *
 * Focus trap is intentionally NOT included in v1 — the use cases so far
 * (Publish, etc.) have a small enough surface (~3 buttons) that tabbing
 * out is fine. Add later if needed.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export function Modal({
  open,
  onClose,
  title,
  children,
  maxWidth = 560,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  maxWidth?: number;
}) {
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2, 9)}`);

  // Escape to close + body scroll lock while open. Effect re-runs only on
  // open/onClose change so a parent re-render doesn't keep adding listeners.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  // Render nothing until mounted on the client AND open=true; createPortal
  // needs document.body which doesn't exist server-side.
  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId.current : undefined}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(2px)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '8vh 16px 16px',
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--border-strong)',
          borderRadius: 12,
          padding: 20,
          width: '100%',
          maxWidth,
          boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
          color: 'var(--text)',
        }}
      >
        {title && (
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              marginBottom: 14,
              gap: 14,
            }}
          >
            <h2
              id={titleId.current}
              style={{
                margin: 0,
                fontSize: 18,
                fontWeight: 600,
                letterSpacing: '-0.2px',
              }}
            >
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-faint)',
                fontSize: 18,
                lineHeight: 1,
                padding: 4,
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
