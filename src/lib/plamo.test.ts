import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationError, translateText } from './plamo';
import { DEFAULT_SETTINGS } from './settings';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('translateText', () => {
  it('uses PFML3 completions in plamo mode', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ text: 'こんにちは。<|plamo:tag|>', finish_reason: 'stop' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await translateText(
      { ...DEFAULT_SETTINGS, endpoint: 'http://127.0.0.1:45871/v1' },
      { text: 'Hello.', targetLang: 'ja' },
    );
    expect(result).toBe('こんにちは。');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:45871/v1/completions');
    const body = JSON.parse(String(init?.body));
    expect(body.prompt).toContain('<|plamo:tag|>dataset');
    expect(body.stop).toEqual(['<|plamo:tag|>', '<|plamo:bos|>']);
  });

  it('uses chat completions and no PLaMo fields in openai-chat mode', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: 'こんにちは。' } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await translateText(
      {
        ...DEFAULT_SETTINGS,
        protocol: 'openai-chat',
        endpoint: 'http://127.0.0.1:9999/v1',
        apiKey: 'secret',
      },
      { text: 'Hello.', targetLang: 'ja' },
    );
    expect(result).toBe('こんにちは。');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:9999/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    expect(body).not.toHaveProperty('prompt');
    expect(body).not.toHaveProperty('stop');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret');
  });

  it('classifies HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(translateText(DEFAULT_SETTINGS, { text: 'Hello.', targetLang: 'ja' }))
      .rejects.toBeInstanceOf(TranslationError);
  });
});
