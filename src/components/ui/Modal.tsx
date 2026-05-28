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
 *   - Focus trap (v1.1): focuses the first focusable element on open, cycles
 *     Tab / Shift+Tab within the modal, and restores focus to the previously
 *     focused element on close.
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
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Element focused before the modal opened, restored on close so keyboard
  // users land back where they were.
  const prevFocusRef = useRef<HTMLElement | null>(null);

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  // Escape to close + body scroll lock + focus trap while open. Effect re-runs
  // only on open/onClose change so a parent re-render doesn't keep adding
  // listeners. The portal content has already mounted by the time this effect
  // runs (effects fire after render), so contentRef is populated.
  useEffect(() => {
    if (!open) return;

    prevFocusRef.current = (document.activeElement as HTMLElement) ?? null;
    // Focus the first focusable element inside the modal (or the content box
    // itself as a fallback) so Tab cycling starts contained.
    const focusFirst = () => {
      const nodes = contentRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      (nodes && nodes.length > 0 ? nodes[0] : contentRef.current)?.focus();
    };
    focusFirst();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const nodes = contentRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      // Wrap focus at the edges; if focus somehow escaped the modal, pull it back.
      if (e.shiftKey) {
        if (active === first || !contentRef.current?.contains(active)) {
          e.preventDefault();
          last?.focus();
        }
      } else if (active === last || !contentRef.current?.contains(active)) {
        e.preventDefault();
        first?.focus();
      }
    };

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      prevFocusRef.current?.focus?.();
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
        ref={contentRef}
        tabIndex={-1}
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
          outline: 'none',
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
