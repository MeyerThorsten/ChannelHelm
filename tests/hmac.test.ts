import { createHmac } from 'node:crypto';
import { verifyHmac, webhookGate } from '@/lib/hmac';
import { describe, expect, it } from 'vitest';

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

describe('webhookGate (§8 fail-closed)', () => {
  it('accepts a verified signature', () => {
    expect(webhookGate({ ok: true, mode: 'verified' }, false)).toEqual({
      accept: true,
      mode: 'verified',
    });
  });

  it('REFUSES (503) when no secret is configured and unsigned is not allowed', () => {
    const g = webhookGate({ ok: true, mode: 'unverified' }, false);
    expect(g).toMatchObject({ accept: false, status: 503 });
  });

  it('accepts unsigned only when explicitly allowed (ALLOW_UNSIGNED_WEBHOOKS=1)', () => {
    expect(webhookGate({ ok: true, mode: 'unverified' }, true)).toEqual({
      accept: true,
      mode: 'unverified',
    });
  });

  it('rejects a bad signature with 401', () => {
    const g = webhookGate({ ok: false, reason: 'bad_signature' }, true);
    expect(g).toMatchObject({ accept: false, status: 401 });
  });

  it('rejects a missing signature with 401 even when unsigned is allowed', () => {
    const g = webhookGate({ ok: false, reason: 'missing_header' }, true);
    expect(g).toMatchObject({ accept: false, status: 401 });
  });
});
