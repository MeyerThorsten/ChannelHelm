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

// ─── status enums ────────────────────────────────────────────────
//
// PackageStatus is exactly the §10 lifecycle. AssetStatus is the §2.2 set
// PLUS the documented internal review marker `ready_for_review` (assets are
// surfaced for operator review before approval — see the §2.2 note in the
// contract). Workers set in-flight values; API consumers set the
// terminal-ish values via the approval/dispatch flow.

export const PackageStatus = z.enum([
  'draft',
  'ingested',
  'transcribing',
  'analyzing_visual',
  'fused',
  'analyzed',
  'ready_for_review',
  'approved',
  'dispatching',
  'dispatched',
  'partially_dispatched',
  'failed',
]);
export type PackageStatus = z.infer<typeof PackageStatus>;

export const AssetStatus = z.enum([
  'draft',
  'ready_for_review', // internal review marker (documented in §2.2)
  'approved',
  'rejected',
  'dispatched',
  'published',
  'failed',
]);
export type AssetStatus = z.infer<typeof AssetStatus>;

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
  status: PackageStatus.optional(),
  processingProfile: ProcessingProfile.optional(),
  intelligence: JsonObject.optional(),
  routing: JsonObject.optional(),
});
export type PackageCreate = z.infer<typeof PackageCreate>;

export const PackageUpdate = z
  .object({
    status: PackageStatus,
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
    status: AssetStatus,
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
  status: PackageStatus.optional(),
  sourceId: z.string().regex(/^src_/).optional(),
});

export const AssetListQuery = z.object({
  // §3 / #13: asset reads are brand-scoped.
  brandId: z.string().regex(/^brd_/),
  packageId: z.string().regex(/^pkg_/),
  type: z.string().optional(),
  status: AssetStatus.optional(),
});

// ─── jobs (enqueue from the API) ─────────────────────────────────

export const JobEnqueue = z.object({
  kind: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
  idempotencyKey: z.string().min(1).optional(),
  priority: z.number().int().min(0).max(9).optional(),
  runAfter: z.string().datetime().optional(),
});
export type JobEnqueue = z.infer<typeof JobEnqueue>;
