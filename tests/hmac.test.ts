import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyHmac } from '@/lib/hmac';

const SECRET = 'test-secret-do-not-use-in-prod';
const BODY = '{"event":"post.published","_id":"evt_1"}';
const SIG = createHmac('sha256', SECRET).update(BODY).digest('hex');

describe('verifyHmac', () => {
  it('returns unverified mode when secret is unset', () => {
    const r = verifyHmac({
      secret: undefined,
      headerName: 'x-sig',
      headerValue: 'whatever',
      rawBody: BODY,
    });
    expect(r).toEqual({ ok: true, mode: 'unverified' });
  });

  it('verifies a correct sha256-hex signature', () => {
    const r = verifyHmac({
      secret: SECRET,
      headerName: 'x-sig',
      headerValue: SIG,
      rawBody: BODY,
    });
    expect(r).toEqual({ ok: true, mode: 'verified' });
  });

  it('strips the optional sha256= prefix', () => {
    const r = verifyHmac({
      secret: SECRET,
      headerName: 'x-sig',
      headerValue: `sha256=${SIG}`,
      rawBody: BODY,
    });
    expect(r).toEqual({ ok: true, mode: 'verified' });
  });

  it('rejects missing header when a secret is set', () => {
    const r = verifyHmac({
      secret: SECRET,
      headerName: 'x-sig',
      headerValue: null,
      rawBody: BODY,
    });
    expect(r).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('rejects a body-tamper', () => {
    const r = verifyHmac({
      secret: SECRET,
      headerName: 'x-sig',
      headerValue: SIG,
      rawBody: `${BODY} `, // trailing space — Zernio would have signed the original
    });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a length-mismatched signature', () => {
    const r = verifyHmac({
      secret: SECRET,
      headerName: 'x-sig',
      headerValue: 'short',
      rawBody: BODY,
    });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });
});
