import { parseConcepts } from '@workers/kinds/thumbnail_concepts';
import { describe, expect, it } from 'vitest';

describe('parseConcepts', () => {
  it('parses a clean JSON array', () => {
    const out = parseConcepts(
      '[{"visual_prompt":"a dramatic GPU on black","headline":"IT MELTED"}]',
    );
    expect(out).toEqual([{ visual_prompt: 'a dramatic GPU on black', headline: 'IT MELTED' }]);
  });

  it('strips ```json fences', () => {
    const out = parseConcepts('```json\n[{"visual_prompt":"x","headline":"Y"}]\n```');
    expect(out).toHaveLength(1);
    expect(out[0]?.visual_prompt).toBe('x');
  });

  it('extracts the array when wrapped in prose before and after', () => {
    const out = parseConcepts(
      'Sure! Here are the concepts:\n[{"visual_prompt":"scene one"},{"visual_prompt":"scene two"}]\nHope that helps.',
    );
    expect(out.map((c) => c.visual_prompt)).toEqual(['scene one', 'scene two']);
  });

  it('treats headline as optional', () => {
    const out = parseConcepts('[{"visual_prompt":"no headline here"}]');
    expect(out[0]?.headline).toBeUndefined();
  });

  it('drops entries without a string visual_prompt', () => {
    const out = parseConcepts(
      '[{"headline":"missing prompt"},{"visual_prompt":42},{"visual_prompt":"keep me"}]',
    );
    expect(out).toEqual([{ visual_prompt: 'keep me', headline: undefined }]);
  });

  it('drops a non-string headline', () => {
    const out = parseConcepts('[{"visual_prompt":"p","headline":123}]');
    expect(out[0]?.headline).toBeUndefined();
  });

  it('returns [] for a JSON object (not array)', () => {
    expect(parseConcepts('{"visual_prompt":"x"}')).toEqual([]);
  });

  it('returns [] for malformed JSON', () => {
    expect(parseConcepts('[{visual_prompt: unquoted}]')).toEqual([]);
    expect(parseConcepts('not json at all')).toEqual([]);
    expect(parseConcepts('')).toEqual([]);
  });
});
