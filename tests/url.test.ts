import { registrableDomain, sameDomain, slugify } from '@/lib/url';
import { describe, expect, it } from 'vitest';

describe('registrableDomain', () => {
  it('strips protocol, www, path, and lowercases', () => {
    expect(registrableDomain('https://www.ThorstenMeyerAI.com/about')).toBe('thorstenmeyerai.com');
    expect(registrableDomain('http://Example.COM')).toBe('example.com');
  });
  it('adds a scheme when missing', () => {
    expect(registrableDomain('thorstenmeyerai.com')).toBe('thorstenmeyerai.com');
    expect(registrableDomain('www.foo.io/x')).toBe('foo.io');
  });
  it('returns null for junk', () => {
    expect(registrableDomain('')).toBeNull();
    expect(registrableDomain(null)).toBeNull();
    expect(registrableDomain('   ')).toBeNull();
  });
});

describe('sameDomain', () => {
  it('matches across protocol/www/path differences', () => {
    expect(sameDomain('https://www.a.com/x', 'http://a.com')).toBe(true);
    expect(sameDomain('a.com', 'b.com')).toBe(false);
    expect(sameDomain(null, 'a.com')).toBe(false);
  });
});

describe('slugify', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(slugify('Thorsten Meyer AI')).toBe('thorsten-meyer-ai');
    expect(slugify('The Explainer!!')).toBe('the-explainer');
  });
  it('handles unicode and trims dashes', () => {
    expect(slugify('  —Jawed—  ')).toBe('jawed');
  });
  it('falls back to "brand" for empty results', () => {
    expect(slugify('!!!')).toBe('brand');
  });
});
