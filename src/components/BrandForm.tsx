'use client';

import type { brands } from '@/db/schema';
import { slugify } from '@/lib/url';
import { useState } from 'react';

type Brand = typeof brands.$inferSelect;

const PROFILES = [
  'transcription_only',
  'fast_audio_only',
  'standard_audio_visual',
  'premium_multimodal',
] as const;

const INPUT = 'ch-input';
const LABEL = 'ch-label';
const HELP = 'ch-help';

export function BrandForm({
  brand,
  action,
  submitLabel,
}: {
  brand?: Brand;
  action: (formData: FormData) => Promise<void>;
  submitLabel: string;
}) {
  const defaultProfile = brand?.defaultProcessingProfile ?? 'standard_audio_visual';
  const approvalList = Array.isArray(brand?.approvalRequiredFor)
    ? (brand?.approvalRequiredFor as string[]).join(', ')
    : '';
  const autoList = Array.isArray(brand?.autoDispatchFor)
    ? (brand?.autoDispatchFor as string[]).join(', ')
    : '';

  // Auto-slugify: for a new brand the slug field tracks the name (until the
  // operator edits the slug directly). On edit the slug is immutable.
  const isNew = !brand;
  const [name, setName] = useState(brand?.name ?? '');
  const [slug, setSlug] = useState(brand?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(false);
  const shownSlug = isNew && !slugTouched ? slugify(name) : slug;

  return (
    <form action={action} className="space-y-5">
      <div>
        <label className={LABEL} htmlFor="name">
          Display name
        </label>
        <input
          id="name"
          name="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={INPUT}
        />
      </div>

      <div>
        <label className={LABEL} htmlFor="slug">
          Slug
        </label>
        <input
          id="slug"
          name="slug"
          required
          value={shownSlug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(slugify(e.target.value));
          }}
          disabled={!isNew}
          className={INPUT}
        />
        <p className={HELP}>
          Auto-derived from the name; kebab-case, used in /var/channelhelm/media/&lt;slug&gt;/…
          {!isNew && ' Immutable after creation (use “Normalize slug” to migrate).'}
        </p>
      </div>

      <div>
        <label className={LABEL} htmlFor="defaultProcessingProfile">
          Default processing profile
        </label>
        <select
          id="defaultProcessingProfile"
          name="defaultProcessingProfile"
          defaultValue={defaultProfile}
          className={INPUT}
        >
          {PROFILES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="website">
            Website
          </label>
          <input
            id="website"
            name="website"
            placeholder="https://example.com"
            defaultValue={brand?.website ?? ''}
            className={INPUT}
          />
          <p className={HELP}>Auto-filled when a brand is discovered from a YouTube channel.</p>
        </div>
        <div>
          <label className={LABEL} htmlFor="youtubeChannelId">
            YouTube channel ID
          </label>
          <input
            id="youtubeChannelId"
            name="youtubeChannelId"
            defaultValue={brand?.youtubeChannelId ?? ''}
            className={INPUT}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="zernioProfileId">
            LATE / Zernio profile ID
          </label>
          <input
            id="zernioProfileId"
            name="zernioProfileId"
            defaultValue={brand?.zernioProfileId ?? ''}
            className={INPUT}
          />
        </div>
      </div>

      <div>
        <label className={LABEL} htmlFor="approvalRequiredFor">
          Approval required for (comma-separated asset types)
        </label>
        <input
          id="approvalRequiredFor"
          name="approvalRequiredFor"
          defaultValue={approvalList}
          className={INPUT}
        />
        <p className={HELP}>
          Default behavior: approval required. Listed types stay manually approved even if{' '}
          <code>auto_dispatch_for</code> would skip them.
        </p>
      </div>

      <div>
        <label className={LABEL} htmlFor="autoDispatchFor">
          Auto-dispatch for (comma-separated asset types)
        </label>
        <input
          id="autoDispatchFor"
          name="autoDispatchFor"
          defaultValue={autoList}
          className={INPUT}
        />
        <p className={HELP}>
          Types listed here skip the approval step. Plans (<code>short_clip_plan</code>) cannot be
          auto-dispatched.
        </p>
      </div>

      {brand && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={brand.active} />
          Active
        </label>
      )}

      <button
        type="submit"
        className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
      >
        {submitLabel}
      </button>
    </form>
  );
}
