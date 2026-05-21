import type { brands } from '@/db/schema';

type Brand = typeof brands.$inferSelect;

const PROFILES = ['fast_audio_only', 'standard_audio_visual', 'premium_multimodal'] as const;

const INPUT =
  'mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-zinc-700 dark:bg-zinc-950';
const LABEL = 'block text-sm font-medium text-zinc-700 dark:text-zinc-300';
const HELP = 'mt-1 text-xs text-zinc-500';

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

  return (
    <form action={action} className="space-y-5">
      <div>
        <label className={LABEL} htmlFor="slug">
          Slug
        </label>
        <input
          id="slug"
          name="slug"
          required
          pattern="[a-z0-9-]+"
          defaultValue={brand?.slug ?? ''}
          disabled={!!brand}
          className={INPUT}
        />
        <p className={HELP}>kebab-case, used in /var/channelhelm/media/&lt;slug&gt;/…</p>
      </div>

      <div>
        <label className={LABEL} htmlFor="name">
          Display name
        </label>
        <input id="name" name="name" required defaultValue={brand?.name ?? ''} className={INPUT} />
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
