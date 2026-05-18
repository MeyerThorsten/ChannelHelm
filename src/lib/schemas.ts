import { z } from 'zod';

/**
 * Shared Zod schemas. Imported by API routes today; workers will share them
 * starting in Session 03.
 *
 * Status values are kept as `z.string()` for now — the contract's §2.1 / §10
 * enums will be tightened in a later session once worker state transitions
 * are wired up. Processing profiles are fixed in §5.5 and are an enum today.
 */

export const ProcessingProfile = z.enum([
  'fast_audio_only',
  'standard_audio_visual',
  'premium_multimodal',
]);
export type ProcessingProfile = z.infer<typeof ProcessingProfile>;

export const SourceKind = z.enum(['youtube_url', 'uploaded_video', 'podcast', 'transcript_only']);

const JsonObject = z.record(z.unknown());
const StringArray = z.array(z.string());

// ─── brands ──────────────────────────────────────────────────────

export const BrandCreate = z.object({
  id: z.string().regex(/^brd_/).optional(),
  slug: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  active: z.boolean().optional(),
  voiceProfile: JsonObject.optional(),
  zernioProfileId: z.string().optional(),
  dojoclawSites: z.array(z.unknown()).optional(),
  youtubeChannelId: z.string().optional(),
  defaultPublishingSchedule: z.string().optional(),
  defaultProcessingProfile: ProcessingProfile.optional(),
  approvalRequiredFor: StringArray.optional(),
  autoDispatchFor: StringArray.optional(),
});
export type BrandCreate = z.infer<typeof BrandCreate>;

export const BrandUpdate = BrandCreate.partial().omit({ id: true });
export type BrandUpdate = z.infer<typeof BrandUpdate>;

// ─── sources ─────────────────────────────────────────────────────

export const SourceCreate = z.object({
  brandId: z.string().regex(/^brd_/),
  kind: SourceKind,
  originUrl: z.string().url().optional(),
  localMediaPath: z.string().optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  language: z.string().optional(),
  title: z.string().optional(),
  metadata: JsonObject.optional(),
});
export type SourceCreate = z.infer<typeof SourceCreate>;

// ─── packages ────────────────────────────────────────────────────

export const PackageCreate = z.object({
  brandId: z.string().regex(/^brd_/),
  sourceId: z.string().regex(/^src_/),
  status: z.string().optional(),
  processingProfile: ProcessingProfile.optional(),
  intelligence: JsonObject.optional(),
  routing: JsonObject.optional(),
});
export type PackageCreate = z.infer<typeof PackageCreate>;

export const PackageUpdate = z
  .object({
    status: z.string(),
    processingProfile: ProcessingProfile,
    intelligence: JsonObject,
    routing: JsonObject,
    approvedAt: z.string().datetime().nullable(),
    approvedBy: z.string().nullable(),
  })
  .partial();
export type PackageUpdate = z.infer<typeof PackageUpdate>;

// ─── assets (no create from API — workers produce assets) ────────

export const AssetUpdate = z
  .object({
    status: z.string(),
    approvalRequired: z.boolean(),
    payload: JsonObject,
    provenance: JsonObject,
    dispatch: JsonObject,
    signals: JsonObject,
  })
  .partial();
export type AssetUpdate = z.infer<typeof AssetUpdate>;

// ─── list-endpoint query parsers ─────────────────────────────────

export const BrandListQuery = z.object({
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export const SourceListQuery = z.object({
  brandId: z.string().regex(/^brd_/),
  kind: SourceKind.optional(),
});

export const PackageListQuery = z.object({
  brandId: z.string().regex(/^brd_/),
  status: z.string().optional(),
  sourceId: z.string().regex(/^src_/).optional(),
});

export const AssetListQuery = z.object({
  packageId: z.string().regex(/^pkg_/),
  type: z.string().optional(),
  status: z.string().optional(),
});
