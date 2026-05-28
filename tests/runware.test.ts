import {
  RunwareImageProvider,
  isBillingError,
  roundTo64,
} from '@workers/integrations/image/runware';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CONFIG = {
  name: 'Runware',
  type: 'runware',
  baseUrl: 'https://api.runware.ai/v1',
  apiKey: 'rw-test-key',
  model: 'runware:z-image@turbo',
};

/** A fetch Response stub with a JSON body. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('roundTo64', () => {
  it('rounds to the nearest multiple of 64', () => {
    expect(roundTo64(1280)).toBe(1280); // exact
    expect(roundTo64(720)).toBe(704); // 11.25 → 11
    expect(roundTo64(768)).toBe(768);
    expect(roundTo64(100)).toBe(128); // 1.56 → 2
    expect(roundTo64(95)).toBe(64); // 1.48 → 1
  });
  it('never returns below 64', () => {
    expect(roundTo64(1)).toBe(64);
    expect(roundTo64(0)).toBe(64);
    expect(roundTo64(-50)).toBe(64);
  });
});

describe('isBillingError', () => {
  it.each([
    'insufficient balance',
    'your BALANCE is too low',
    'billing problem',
    'payment required',
    'quota exceeded',
    'out of credits',
  ])('flags billing message: %s', (msg) => {
    expect(isBillingError(msg)).toBe(true);
  });
  it.each(['Runware API error (500): internal', 'timeout', 'bad request', ''])(
    'does NOT flag non-billing message: %s',
    (msg) => {
      expect(isBillingError(msg)).toBe(false);
    },
  );
});

describe('RunwareImageProvider.testConnection', () => {
  it('ok when an API key is present', async () => {
    const p = new RunwareImageProvider(CONFIG);
    await expect(p.testConnection()).resolves.toEqual({ ok: true });
  });
  it('fails when no API key', async () => {
    const p = new RunwareImageProvider({ ...CONFIG, apiKey: '' });
    const r = await p.testConnection();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/api key/i);
  });
});

describe('RunwareImageProvider metadata', () => {
  it('exposes name/model/type', () => {
    const p = new RunwareImageProvider(CONFIG);
    expect(p.getName()).toBe('Runware');
    expect(p.getType()).toBe('runware');
    expect(p.getModel()).toBe('runware:z-image@turbo');
  });
  it('falls back to the default model when none configured', () => {
    const p = new RunwareImageProvider({ ...CONFIG, model: '' });
    expect(p.getModel()).toBe('runware:z-image@turbo');
  });
});

describe('RunwareImageProvider.generateImages', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('maps a successful response to ImageGenResult[]', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ imageURL: 'https://cdn/x.jpg', imageUUID: 'u1', cost: 0.0021 }] }),
    );
    const p = new RunwareImageProvider(CONFIG);
    const out = await p.generateImages({ prompt: 'a cat' });
    expect(out).toEqual([
      { imageUrl: 'https://cdn/x.jpg', cost: 0.0021, model: 'runware:z-image@turbo' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the right endpoint, auth header, and request body (dims rounded to /64)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ imageURL: 'https://cdn/x.jpg', imageUUID: 'u1' }] }),
    );
    const p = new RunwareImageProvider(CONFIG);
    await p.generateImages({ prompt: 'sunset', width: 1280, height: 720, numberResults: 2 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.runware.ai/v1');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer rw-test-key');
    const body = JSON.parse(init.body)[0];
    expect(body.taskType).toBe('imageInference');
    expect(body.positivePrompt).toBe('sunset');
    expect(body.width).toBe(1280);
    expect(body.height).toBe(704); // 720 rounded to /64
    expect(body.numberResults).toBe(2);
    expect(body.model).toBe('runware:z-image@turbo');
    expect(body.outputFormat).toBe('JPG');
    expect(typeof body.taskUUID).toBe('string');
  });

  it('includes negativePrompt only when provided', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ imageURL: 'https://cdn/x.jpg', imageUUID: 'u' }] }),
    );
    const p = new RunwareImageProvider(CONFIG);

    await p.generateImages({ prompt: 'a' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)[0].negativePrompt).toBeUndefined();

    await p.generateImages({ prompt: 'a', negativePrompt: 'blurry' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)[0].negativePrompt).toBe('blurry');
  });

  it('does NOT retry billing errors (HTTP body)', async () => {
    fetchMock.mockResolvedValue(jsonResponse('insufficient credits', false, 402));
    const p = new RunwareImageProvider(CONFIG);
    await expect(p.generateImages({ prompt: 'a' }, 2)).rejects.toThrow(/insufficient credits/i);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry despite maxRetries=2
  });

  it('does NOT retry billing errors (errors field)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errors: [{ message: 'out of credits' }] }));
    const p = new RunwareImageProvider(CONFIG);
    await expect(p.generateImages({ prompt: 'a' }, 2)).rejects.toThrow(/credits/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on a non-ok non-billing HTTP status (after exhausting retries=0)', async () => {
    fetchMock.mockResolvedValue(jsonResponse('server boom', false, 500));
    const p = new RunwareImageProvider(CONFIG);
    await expect(p.generateImages({ prompt: 'a' }, 0)).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the API returns zero images', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const p = new RunwareImageProvider(CONFIG);
    await expect(p.generateImages({ prompt: 'a' }, 0)).rejects.toThrow(/no images/i);
  });

  it('retries a transient failure then succeeds', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new Error('network reset'))
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ imageURL: 'https://cdn/ok.jpg', imageUUID: 'u' }] }),
      );
    const p = new RunwareImageProvider(CONFIG);
    const promise = p.generateImages({ prompt: 'a' }, 2);
    // First attempt rejects, then the backoff sleep (5s) must elapse.
    await vi.advanceTimersByTimeAsync(6000);
    const out = await promise;
    expect(out[0]?.imageUrl).toBe('https://cdn/ok.jpg');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting retries on persistent transient failures', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('network reset'));
    const p = new RunwareImageProvider(CONFIG);
    const promise = p.generateImages({ prompt: 'a' }, 2);
    const assertion = expect(promise).rejects.toThrow(/network reset/);
    await vi.advanceTimersByTimeAsync(40_000); // cover both backoff windows
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });
});
