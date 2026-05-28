'use client';

import { Avatar } from '@/components/ui';
import { brandColor } from '@/lib/brand-color';
import { usePathname, useRouter } from 'next/navigation';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';

export type NavBrand = { id: string; slug: string; name: string };
export type NavPackage = { id: string; title: string; brand: string };

const TABS = [
  { href: '/', label: 'New', glyph: '+' },
  { href: '/brands', label: 'Brands', glyph: null },
  { href: '/performance', label: 'Performance', glyph: null },
  { href: '/jobs', label: 'Jobs', glyph: null },
  { href: '/providers', label: 'Providers', glyph: null },
  { href: '/settings', label: 'Settings', glyph: null },
];

export function Nav({
  brands = [],
  packages = [],
}: { brands?: NavBrand[]; packages?: NavPackage[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [cmdOpen, setCmdOpen] = useState(false);

  useEffect(() => {
    setTheme((localStorage.getItem('ch-theme') as 'dark' | 'light') || 'dark');
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('ch-theme', next);
    } catch {
      // ignore
    }
  }

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        height: 48,
        borderBottom: '1px solid var(--border)',
        background: 'color-mix(in oklab, var(--bg) 88%, transparent)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        gap: 16,
      }}
    >
      <button
        type="button"
        onClick={() => router.push('/')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          background: 'none',
          border: 'none',
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            background: 'var(--accent)',
            borderRadius: 5,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow:
              '0 0 0 1px color-mix(in oklab, var(--accent) 50%, white), 0 4px 16px var(--accent-glow)',
          }}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M2 12 L2 4 L5 4 L8 7 L11 4 L14 4 L14 12 L11 12 L11 8 L8 11 L5 8 L5 12 Z"
              fill="white"
            />
          </svg>
        </span>
        <span style={{ fontWeight: 600, fontSize: 14, letterSpacing: -0.2 }}>ChannelHelm</span>
      </button>

      <nav style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 8 }}>
        {TABS.map((t) => {
          const active =
            t.href === '/'
              ? pathname === '/' || pathname.startsWith('/packages')
              : pathname.startsWith(t.href);
          return (
            <button
              key={t.href}
              type="button"
              onClick={() => router.push(t.href)}
              style={{
                padding: '6px 10px',
                fontSize: 12,
                fontWeight: 500,
                color: active ? 'var(--text)' : 'var(--text-muted)',
                background: active ? 'var(--bg-hover)' : 'transparent',
                border: 'none',
                borderRadius: 6,
                transition: 'all 0.12s',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                cursor: 'pointer',
              }}
            >
              {t.glyph && (
                <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{t.glyph}</span>
              )}
              {t.label}
            </button>
          );
        })}
      </nav>

      <div style={{ flex: 1 }} />

      <button
        type="button"
        onClick={() => setCmdOpen(true)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 8px 5px 10px',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          fontSize: 11,
          color: 'var(--text-faint)',
          minWidth: 240,
          cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 11, opacity: 0.7 }}>⌕</span>
        <span>Jump to package, brand, or job…</span>
        <span style={{ flex: 1 }} />
        <kbd
          style={{
            padding: '1px 5px',
            fontSize: 10,
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--border)',
            borderRadius: 3,
            fontFamily: 'var(--font-mono)',
          }}
        >
          ⌘K
        </kbd>
      </button>

      <BrandSwitcher
        brands={brands}
        onPick={(id) => router.push(id === 'new' ? '/brands/new' : `/brands/${id}`)}
      />

      <button
        type="button"
        onClick={toggleTheme}
        title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
        style={{
          width: 28,
          height: 28,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          borderRadius: 6,
          color: 'var(--text-muted)',
          cursor: 'pointer',
        }}
      >
        {theme === 'dark' ? '☾' : '☀'}
      </button>

      {cmdOpen && (
        <CommandPalette
          brands={brands}
          packages={packages}
          onClose={() => setCmdOpen(false)}
          onNavigate={(href) => {
            setCmdOpen(false);
            router.push(href);
          }}
        />
      )}
    </header>
  );
}

function BrandSwitcher({ brands, onPick }: { brands: NavBrand[]; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = brands[0];
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  if (!current) {
    return (
      <button
        type="button"
        onClick={() => onPick('new')}
        style={{
          padding: '4px 10px',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          fontSize: 12,
          color: 'var(--text-muted)',
          cursor: 'pointer',
        }}
      >
        + Brand
      </button>
    );
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 8px 4px 5px',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          fontSize: 12,
          color: 'var(--text)',
          cursor: 'pointer',
        }}
      >
        <Avatar
          glyph={current.slug.slice(0, 2).toUpperCase()}
          color={brandColor(current.slug)}
          size={20}
        />
        <span style={{ fontWeight: 500 }}>{current.name}</span>
        <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 4,
            minWidth: 240,
            boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
            animation: 'slide-up 0.16s ease-out',
          }}
        >
          <div className="uppercase-eyebrow" style={{ padding: '6px 8px 4px' }}>
            Brands
          </div>
          {brands.map((b) => (
            <MenuItem
              key={b.id}
              onClick={() => {
                onPick(b.id);
                setOpen(false);
              }}
            >
              <Avatar
                glyph={b.slug.slice(0, 2).toUpperCase()}
                color={brandColor(b.slug)}
                size={22}
              />
              <span style={{ flex: 1, fontSize: 12, fontWeight: 500 }}>{b.name}</span>
              <span
                style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}
              >
                {b.slug}
              </span>
            </MenuItem>
          ))}
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          <MenuItem
            onClick={() => {
              onPick('new');
              setOpen(false);
            }}
          >
            <span style={{ width: 22, textAlign: 'center', color: 'var(--accent)' }}>+</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>New brand</span>
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  const base: CSSProperties = {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 8px',
    borderRadius: 5,
    background: 'transparent',
    border: 'none',
    textAlign: 'left',
    cursor: 'pointer',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      style={base}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--bg-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {children}
    </button>
  );
}

function CommandPalette({
  brands,
  packages,
  onClose,
  onNavigate,
}: {
  brands: NavBrand[];
  packages: NavPackage[];
  onClose: () => void;
  onNavigate: (href: string) => void;
}) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const items = [
    ...packages.map((p) => ({
      kind: 'Package',
      label: p.title,
      sub: p.brand,
      href: `/packages/${p.id}`,
    })),
    ...brands.map((b) => ({ kind: 'Brand', label: b.name, sub: b.slug, href: `/brands/${b.id}` })),
    { kind: 'Page', label: 'New package', sub: 'Upload or paste URL', href: '/' },
    {
      kind: 'Page',
      label: 'Performance',
      sub: 'Published metrics & A/B results',
      href: '/performance',
    },
    { kind: 'Page', label: 'Jobs queue', sub: 'Pipeline inspector', href: '/jobs' },
    { kind: 'Page', label: 'Providers', sub: 'LLM provider config', href: '/providers' },
    { kind: 'Page', label: 'Webhooks', sub: 'Inbound events', href: '/webhooks' },
    { kind: 'Page', label: 'Voice', sub: 'Voice examples', href: '/voice-examples' },
  ];
  const filtered = q
    ? items.filter((i) => `${i.label} ${i.sub}`.toLowerCase().includes(q.toLowerCase()))
    : items.slice(0, 8);

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 120,
        animation: 'fade-in 0.12s',
      }}
    >
      <div
        role="dialog"
        aria-modal
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          background: 'var(--panel)',
          border: '1px solid var(--border-strong)',
          borderRadius: 12,
          boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
          overflow: 'hidden',
          animation: 'slide-up 0.16s ease-out',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 14px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <span style={{ color: 'var(--text-faint)' }}>⌕</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Jump to anything…"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: 14,
              color: 'var(--text)',
            }}
          />
          <kbd
            style={{
              padding: '2px 5px',
              fontSize: 10,
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--border)',
              borderRadius: 3,
              fontFamily: 'var(--font-mono)',
            }}
          >
            esc
          </kbd>
        </div>
        <div style={{ maxHeight: 360, overflow: 'auto', padding: 4 }}>
          {filtered.length === 0 && (
            <div
              style={{ padding: 24, textAlign: 'center', color: 'var(--text-faint)', fontSize: 12 }}
            >
              No matches
            </div>
          )}
          {filtered.map((item) => (
            <button
              key={`${item.kind}:${item.href}:${item.label}`}
              type="button"
              onClick={() => onNavigate(item.href)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
                borderRadius: 6,
                textAlign: 'left',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--bg-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <span
                style={{
                  fontSize: 9,
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: 0.4,
                  padding: '2px 5px',
                  background: 'var(--bg-elev-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 3,
                  color: 'var(--text-faint)',
                  textTransform: 'uppercase',
                  minWidth: 56,
                  textAlign: 'center',
                }}
              >
                {item.kind}
              </span>
              <span style={{ fontSize: 13, color: 'var(--text)' }}>{item.label}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{item.sub}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
