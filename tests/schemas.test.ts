import {
  AssetStatus,
  BrandCreate,
  JobEnqueue,
  PackageCreate,
  PackageStatus,
  PackageUpdate,
  ProcessingProfile,
  SourceCreate,
} from '@/lib/schemas';
import { describe, expect, it } from 'vitest';

describe('ProcessingProfile', () => {
  it('accepts the three §5.5 values', () => {
    for (const p of ['fast_audio_only', 'standard_audio_visual', 'premium_multimodal']) {
      expect(ProcessingProfile.parse(p)).toBe(p);
    }
  });
  it('rejects unknown profile', () => {
    expect(() => ProcessingProfile.parse('legendary')).toThrow();
  });
});

describe('PackageStatus / AssetStatus', () => {
  it('rejects free-form strings now (tighter than v1.0)', () => {
    expect(() => PackageStatus.parse('analyziiing')).toThrow();
    expect(() => AssetStatus.parse('almost-approved')).toThrow();
  });
  it('accepts the §10 / §2.2 contracted enums', () => {
    expect(PackageStatus.parse('approved')).toBe('approved');
    expect(PackageStatus.parse('ingested')).toBe('ingested');
    expect(PackageStatus.parse('fused')).toBe('fused');
    expect(PackageStatus.parse('dispatched')).toBe('dispatched');
    expect(PackageStatus.parse('partially_dispatched')).toBe('partially_dispatched');
    expect(AssetStatus.parse('dispatched')).toBe('dispatched');
    expect(AssetStatus.parse('ready_for_review')).toBe('ready_for_review');
  });
  it('rejects values not in the contract (package published, asset scheduled)', () => {
    expect(() => PackageStatus.parse('published')).toThrow();
    expect(() => AssetStatus.parse('scheduled')).toThrow();
    expect(() => AssetStatus.parse('dispatching')).toThrow();
  });
});

describe('BrandCreate', () => {
  it('requires slug and name', () => {
    expect(() => BrandCreate.parse({})).toThrow();
    expect(BrandCreate.parse({ slug: 'x', name: 'X' })).toMatchObject({ slug: 'x', name: 'X' });
  });
  it('accepts an explicit brd_ id', () => {
    const r = BrandCreate.parse({ id: 'brd_abc', slug: 'x', name: 'X' });
    expect(r.id).toBe('brd_abc');
  });
  it('rejects an id without the brd_ prefix', () => {
    expect(() => BrandCreate.parse({ id: 'abc', slug: 'x', name: 'X' })).toThrow();
  });
});

describe('SourceCreate', () => {
  it('requires brand_id and kind', () => {
    expect(() => SourceCreate.parse({})).toThrow();
    expect(SourceCreate.parse({ brandId: 'brd_x', kind: 'youtube_url' })).toMatchObject({
      brandId: 'brd_x',
    });
  });
  it('rejects unknown kind', () => {
    expect(() => SourceCreate.parse({ brandId: 'brd_x', kind: 'wax-cylinder' })).toThrow();
  });
});

describe('PackageCreate / PackageUpdate', () => {
  it('PackageCreate requires brand+source ids with prefixes', () => {
    expect(() => PackageCreate.parse({ brandId: 'x', sourceId: 'y' })).toThrow();
    expect(PackageCreate.parse({ brandId: 'brd_x', sourceId: 'src_y' })).toMatchObject({});
  });
  it('PackageUpdate is fully partial', () => {
    expect(PackageUpdate.parse({})).toEqual({});
    expect(PackageUpdate.parse({ status: 'approved' })).toEqual({ status: 'approved' });
  });
});

describe('JobEnqueue', () => {
  it('defaults payload to {}', () => {
    const r = JobEnqueue.parse({ kind: 'noop' });
    expect(r.payload).toEqual({});
  });
  it('clamps priority to 0..9', () => {
    expect(() => JobEnqueue.parse({ kind: 'noop', priority: -1 })).toThrow();
    expect(() => JobEnqueue.parse({ kind: 'noop', priority: 10 })).toThrow();
    expect(JobEnqueue.parse({ kind: 'noop', priority: 5 }).priority).toBe(5);
  });
});
