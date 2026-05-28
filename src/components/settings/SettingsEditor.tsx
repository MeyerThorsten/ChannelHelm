'use client';

import { saveSettingValue } from '@/server-actions/settings';
import { useState, useTransition } from 'react';

const MASK = '••••••••';

export type SettingItem = {
  key: string;
  value: string; // already masked on the server for sensitive keys
  isSet: boolean;
  sensitive: boolean;
  kind: 'string' | 'number' | 'boolean';
  help: string;
  bootOnly: boolean;
};

/**
 * Editable list of runtime settings. Mirrors the DojoClaw settings page UX:
 *  - secrets show the mask placeholder; an unedited blur is a no-op save
 *  - boolean fields render as a toggle; numbers as `inputMode=numeric`
 *  - one Save button per row, with a transient "Saved" indicator
 *
 * On submit we save just the one key through a Server Action — fewer
 * concurrent writes, clearer error surfacing, and the pg_notify channel
 * propagates the change to the worker pool within the round-trip.
 *
 * `subscriberLive` controls the post-save phrasing: "propagated to workers"
 * when the LISTEN connection is up on this process, or a softer "saved —
 * restart workers to apply" when it isn't.
 */
export function SettingsEditor({
  items,
  subscriberLive = true,
}: {
  items: SettingItem[];
  subscriberLive?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((item) => (
        <Row key={item.key} item={item} subscriberLive={subscriberLive} />
      ))}
    </div>
  );
}

function Row({ item, subscriberLive }: { item: SettingItem; subscriberLive: boolean }) {
  const [value, setValue] = useState(item.value);
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  function save(next?: string): void {
    setError(null);
    const submitted = next ?? value;
    if (item.sensitive && submitted === MASK) {
      // Mask placeholder = no change; treat as a no-op save for UI feedback.
      setSavedAt(Date.now());
      return;
    }
    startTransition(async () => {
      try {
        const result = await saveSettingValue(item.key, submitted);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setSavedAt(Date.now());
        setTouched(false);
        // For sensitive keys, re-mask after a successful save so the new
        // value isn't sitting on screen.
        if (item.sensitive) setValue(MASK);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  function onValueChange(v: string): void {
    setValue(v);
    setTouched(true);
    setError(null);
    setSavedAt(null);
  }

  const rowStyle: React.CSSProperties = {
    padding: 14,
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    opacity: item.bootOnly ? 0.7 : 1,
  };

  return (
    <div style={rowStyle}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          <code style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>{item.key}</code>
          {item.sensitive && <Tag label="secret" tone="amber" />}
          {item.bootOnly && <Tag label="boot only" tone="faint" />}
          {item.isSet ? <Tag label="set" tone="emerald" /> : <Tag label="unset" tone="faint" />}
        </div>
      </div>

      <p style={{ margin: '6px 0 10px', fontSize: 12, color: 'var(--text-faint)' }}>{item.help}</p>

      {item.bootOnly ? (
        <BootOnlyDisplay value={item.value} isSet={item.isSet} sensitive={item.sensitive} />
      ) : item.kind === 'boolean' ? (
        <BooleanInput
          value={value}
          onChange={(v) => {
            onValueChange(v);
            save(v);
          }}
          disabled={pending}
        />
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            className="ch-input"
            type={item.sensitive && !touched ? 'text' : item.sensitive ? 'password' : 'text'}
            inputMode={item.kind === 'number' ? 'numeric' : undefined}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            onFocus={() => {
              if (item.sensitive && value === MASK) {
                // Clear the mask so typing replaces rather than appends.
                setValue('');
                setTouched(true);
              }
            }}
            onBlur={() => {
              if (item.sensitive && value === '') {
                // Restore the mask if they tabbed out without typing.
                setValue(MASK);
                setTouched(false);
              }
            }}
            placeholder={item.sensitive ? (item.isSet ? '•••••••• saved' : '') : ''}
            spellCheck={false}
            autoComplete="off"
            style={{ flex: 1, minWidth: 0 }}
          />
          <button
            type="button"
            disabled={pending || (!touched && !(item.sensitive && value !== MASK && value !== ''))}
            onClick={() => save()}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 500,
              borderRadius: 6,
              background: 'var(--accent)',
              color: '#fff',
              border: '1px solid color-mix(in oklab, var(--accent) 75%, white)',
              cursor: pending ? 'wait' : 'pointer',
              opacity:
                pending || (!touched && !(item.sensitive && value !== MASK && value !== ''))
                  ? 0.5
                  : 1,
            }}
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {error && (
        <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--status-failed)' }}>{error}</p>
      )}
      {savedAt && !error && (
        <p
          style={{
            margin: '8px 0 0',
            fontSize: 12,
            color: subscriberLive ? 'var(--status-published)' : 'var(--status-ready)',
          }}
        >
          {subscriberLive
            ? '✓ Saved — propagated live to subscribed processes'
            : '✓ Saved to database — restart pnpm dev:all once for live propagation'}
        </p>
      )}
    </div>
  );
}

function BooleanInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const on = value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'on';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(on ? '0' : '1')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        background: on
          ? 'color-mix(in oklab, var(--status-published) 14%, transparent)'
          : 'var(--bg-elev-2)',
        border: `1px solid ${on ? 'color-mix(in oklab, var(--status-published) 28%, transparent)' : 'var(--border)'}`,
        borderRadius: 6,
        color: on ? 'var(--status-published)' : 'var(--text-faint)',
        fontSize: 12,
        fontFamily: 'var(--font-mono)',
        cursor: disabled ? 'wait' : 'pointer',
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: on ? 'var(--status-published)' : 'var(--text-faint)',
        }}
      />
      {on ? 'on (1)' : 'off (0)'}
    </button>
  );
}

function BootOnlyDisplay({
  value,
  isSet,
  sensitive,
}: {
  value: string;
  isSet: boolean;
  sensitive: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 10px',
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--border)',
        borderRadius: 6,
      }}
    >
      <code
        style={{
          fontSize: 12,
          fontFamily: 'var(--font-mono)',
          color: isSet ? 'var(--status-published)' : 'var(--text-faint)',
        }}
      >
        {isSet ? (sensitive ? MASK : value) : '(unset)'}
      </code>
      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-faint)' }}>
        edit .env + restart
      </span>
    </div>
  );
}

function Tag({ label, tone }: { label: string; tone: 'amber' | 'emerald' | 'faint' }) {
  const color =
    tone === 'amber'
      ? 'var(--status-ready)'
      : tone === 'emerald'
        ? 'var(--status-published)'
        : 'var(--text-faint)';
  return (
    <span
      style={{
        fontSize: 9,
        fontFamily: 'var(--font-mono)',
        padding: '1px 6px',
        borderRadius: 999,
        color,
        background: `color-mix(in oklab, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in oklab, ${color} 24%, transparent)`,
        letterSpacing: 0.02,
      }}
    >
      {label}
    </span>
  );
}
