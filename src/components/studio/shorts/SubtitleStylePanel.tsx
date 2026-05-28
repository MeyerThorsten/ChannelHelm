'use client';

/**
 * Subtitle styling controls: font · animation · colours · position · size.
 * Emits partial styling edits to the parent which debounces + saves via
 * `saveClipEdits({ styling: ... })`.
 *
 * Per the plan: all 6 animation styles are wired through to the ASS
 * subtitle emitter. The 4 less-common ones (Pop, Single Word, Typewriter,
 * Motion) need ASS animated transforms — they render correctly via
 * ffmpeg's libass but operators should know they're newer/less battle-
 * tested. We render them all on equal footing; the "new" badge marks
 * the freshly-added animations.
 */

import type { AssAnimation, AssFont, AssStyle } from '@/lib/ass-subtitles';

const FONTS: AssFont[] = ['Montserrat', 'Poppins', 'Roboto', 'Komika', 'TheBold', 'Opinion'];
const ANIMATIONS: { v: AssAnimation; label: string; sub: string; isNew?: boolean }[] = [
  { v: 'word_highlight', label: 'Word Highlight', sub: 'word-by-word highlight' },
  { v: 'pop', label: 'Pop', sub: 'scale-up rotation effect', isNew: true },
  { v: 'single_word', label: 'Single Word', sub: 'one big word at a time' },
  { v: 'typewriter', label: 'Typewriter', sub: 'fills in letter by letter', isNew: true },
  { v: 'motion', label: 'Motion', sub: 'word pairs with movement', isNew: true },
  { v: 'banner', label: 'Banner', sub: 'words on colored background' },
];

export const DEFAULT_STYLE: AssStyle = {
  font: 'Montserrat',
  font_size: 70,
  font_color: '#FFFFFF',
  highlight_color: '#39FF14',
  animation: 'word_highlight',
  x_pos: 0.5,
  y_pos: 0.65,
};

export function SubtitleStylePanel({
  value,
  onChange,
}: {
  value: AssStyle;
  onChange: (next: AssStyle) => void;
}) {
  const update = (patch: Partial<AssStyle>) => onChange({ ...value, ...patch });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Font picker */}
      <div>
        <Label>Font</Label>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 6,
            marginTop: 4,
          }}
        >
          {FONTS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => update({ font: f })}
              style={pickerBtn(value.font === f)}
            >
              {f}
            </button>
          ))}
        </div>
        <p style={hint()}>
          Some languages may render in a different font if the selected font doesn't support
          those characters.
        </p>
      </div>

      {/* Animation picker */}
      <div>
        <Label>Animation</Label>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 6,
            marginTop: 4,
          }}
        >
          {ANIMATIONS.map((a) => (
            <button
              key={a.v}
              type="button"
              onClick={() => update({ animation: a.v })}
              style={{
                ...pickerBtn(value.animation === a.v),
                textAlign: 'left',
                padding: '8px 10px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 2,
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600, display: 'flex', gap: 6 }}>
                {a.label}
                {a.isNew && (
                  <span
                    style={{
                      fontSize: 9,
                      padding: '0 5px',
                      borderRadius: 4,
                      background: 'color-mix(in oklab, var(--accent) 18%, transparent)',
                      color: 'var(--accent)',
                      border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
                      fontWeight: 500,
                    }}
                  >
                    new
                  </span>
                )}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{a.sub}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Colour pickers */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <ColorRow
          label="Font"
          value={value.font_color}
          onChange={(c) => update({ font_color: c })}
        />
        <ColorRow
          label="Highlight"
          value={value.highlight_color}
          onChange={(c) => update({ highlight_color: c })}
        />
      </div>

      {/* Position + size sliders */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Slider
          label="Y Pos"
          min={0}
          max={1}
          step={0.01}
          value={value.y_pos}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => update({ y_pos: v })}
        />
        <Slider
          label="X Pos"
          min={0}
          max={1}
          step={0.01}
          value={value.x_pos}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => update({ x_pos: v })}
        />
        <Slider
          label="Font Size"
          min={28}
          max={140}
          step={2}
          value={value.font_size}
          format={(v) => `${v}px`}
          onChange={(v) => update({ font_size: v })}
        />
      </div>
    </div>
  );
}

// ─── small primitives ────────────────────────────────────────────────────

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
  return {
    margin: '6px 2px 0',
    fontSize: 10,
    color: 'var(--status-ready)',
    lineHeight: 1.5,
  };
}

function pickerBtn(active: boolean): React.CSSProperties {
  return {
    padding: '7px 10px',
    fontSize: 12,
    background: active ? 'color-mix(in oklab, var(--accent) 10%, transparent)' : 'var(--panel-2)',
    color: active ? 'var(--accent)' : 'var(--text)',
    border: `1px solid ${active ? 'color-mix(in oklab, var(--accent) 35%, transparent)' : 'var(--border)'}`,
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
  };
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: 36,
            height: 28,
            padding: 0,
            background: 'transparent',
            border: '1px solid var(--border-strong)',
            borderRadius: 5,
            cursor: 'pointer',
          }}
        />
        <input
          type="text"
          value={value.toUpperCase()}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (/^#?[0-9a-fA-F]{6}$/.test(v)) {
              onChange(v.startsWith('#') ? v : `#${v}`);
            }
          }}
          style={{
            flex: 1,
            padding: '5px 8px',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            background: 'var(--panel-2)',
            border: '1px solid var(--border-strong)',
            borderRadius: 5,
            color: 'var(--text)',
          }}
        />
      </div>
    </div>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  format,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '60px 1fr 50px',
        gap: 10,
        alignItems: 'center',
      }}
    >
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ accentColor: 'var(--accent)' }}
      />
      <span
        style={{
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-faint)',
          textAlign: 'right',
        }}
      >
        {format(value)}
      </span>
    </div>
  );
}
