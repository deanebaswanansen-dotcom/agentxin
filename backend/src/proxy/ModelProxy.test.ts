/**
 * Unit tests for {@link OpenAiCompatibleModelProxy} — proxy call shape and
 * error handling (task 8.3; Requirements 5.1, 5.2, 5.5, 5.6).
 *
 * The provider is mocked via `vi.stubGlobal('fetch', ...)` so no real network
 * call is made (design.md Testing Strategy). Covered here:
 *
 * - Request shape: POST to `${baseUrl}/chat/completions` (with trailing-slash
 *   tolerance), `Authorization: Bearer ${apiKey}`, `Content-Type:
 *   application/json`, and a JSON body carrying `model`, `messages`, `stream:
 *   true` (Requirements 5.1, 5.2).
 * - Successful streaming yields the expected concatenated deltas (5.1, 5.2).
 * - A non-2xx provider response throws a {@link ProxyError} carrying `status`
 *   (5.5).
 * - An aborted {@link AbortSignal} throws a {@link ProxyError} (5.5).
 * - SECURITY (5.6): the API key never appears in any yielded delta, nor in a
 *   thrown `ProxyError`'s `message`/`stack`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { OpenAiCompatibleModelProxy, assertPublicModelBaseUrl } from './ModelProxy.js';
import { ProxyError, isProxyError } from './ProxyError.js';
import type { StreamDelta } from './sseParser.js';
import type { ChatMessage, ModelConfig } from '../types/index.js';

const API_KEY = 'sk-secret-LEAK-CANARY';

const CONFIG: ModelConfig = {
  baseUrl: 'https://provider.example.com/v1',
  apiKey: API_KEY,
  modelName: 'gpt-test-4o',
};

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'you are a novelist' },
  { role: 'user', content: '续写这一段' },
];

/** Build OpenAI-compatible SSE wire text for the given content deltas. */
function buildSseWire(deltas: string[]): string {
  let wire = '';
  for (const delta of deltas) {
    wire += `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
  }
  wire += 'data: [DONE]\n\n';
  return wire;
}

/** A `Response`-like stub that streams `wire` as a single UTF-8 chunk. */
function streamingResponse(wire: string): Response {
  const bytes = new TextEncoder().encode(wire);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

/** A non-2xx `Response`-like stub. */
function errorResponse(status: number): Response {
  return { ok: false, status, body: null } as unknown as Response;
}

async function collect(iterable: AsyncIterable<StreamDelta>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of iterable) {
    if (d.kind === 'content') out.push(d.text);
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assertPublicModelBaseUrl', () => {
  it('rejects loopback and link-local model endpoints', () => {
    expect(() => assertPublicModelBaseUrl('http://127.0.0.1:11434')).toThrow(/本机|内网/);
    expect(() => assertPublicModelBaseUrl('http://169.254.169.254/latest')).toThrow(/本机|内网/);
    expect(() => assertPublicModelBaseUrl('http://localhost:3000')).toThrow(/本机|内网/);
  });

  it('allows public https providers', () => {
    expect(() => assertPublicModelBaseUrl('https://api.deepseek.com')).not.toThrow();
  });
});

describe('OpenAiCompatibleModelProxy request shape', () => {
  it('POSTs to ${baseUrl}/chat/completions with auth, content-type and stream body (5.1, 5.2)', async () => {
    const fetchMock = vi.fn(async () => streamingResponse(buildSseWire(['hi'])));
    vi.stubGlobal('fetch', fetchMock);

    const proxy = new OpenAiCompatibleModelProxy();
    await collect(proxy.streamCompletion(CONFIG, MESSAGES, new AbortController().signal));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

    expect(url).toBe('https://provider.example.com/v1/chat/completions');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(CONFIG.modelName);
    expect(body.messages).toEqual(MESSAGES);
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(1);
    expect(body.top_p).toBe(1);
  });

  it('uses configured temperature and Top-P in the provider request body', async () => {
    const fetchMock = vi.fn(async () => streamingResponse(buildSseWire(['hi'])));
    vi.stubGlobal('fetch', fetchMock);

    const proxy = new OpenAiCompatibleModelProxy();
    await collect(
      proxy.streamCompletion(
        { ...CONFIG, temperature: 0.65, topP: 0.8 },
        MESSAGES,
        new AbortController().signal,
      ),
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0.65);
    expect(body.top_p).toBe(0.8);
  });

  it('allows a structured task to override temperature for one request', async () => {
    const fetchMock = vi.fn(async () => streamingResponse(buildSseWire(['{}'])));
    vi.stubGlobal('fetch', fetchMock);

    const proxy = new OpenAiCompatibleModelProxy();
    await collect(proxy.streamCompletion(
      { ...CONFIG, temperature: 0.9 },
      MESSAGES,
      new AbortController().signal,
      { jsonMode: true, temperature: 0.2 },
    ));

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0.2);
  });

  it('tolerates a baseUrl with a trailing slash (no double slash)', async () => {
    const fetchMock = vi.fn(async () => streamingResponse(buildSseWire(['x'])));
    vi.stubGlobal('fetch', fetchMock);

    const proxy = new OpenAiCompatibleModelProxy();
    await collect(
      proxy.streamCompletion(
        { ...CONFIG, baseUrl: 'https://provider.example.com/v1/' },
        MESSAGES,
        new AbortController().signal,
      ),
    );

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://provider.example.com/v1/chat/completions');
  });

  it('does NOT force thinking/reasoning_effort on DeepSeek V4 (would starve content)', async () => {
    const fetchMock = vi.fn(async () => streamingResponse(buildSseWire(['x'])));
    vi.stubGlobal('fetch', fetchMock);

    const proxy = new OpenAiCompatibleModelProxy();
    await collect(
      proxy.streamCompletion(
        {
          ...CONFIG,
          baseUrl: 'https://api.deepseek.com',
          modelName: 'deepseek-v4-pro',
        },
        MESSAGES,
        new AbortController().signal,
      ),
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // Forcing reasoning_effort 'max'/'high' made hidden reasoning consume the
    // whole max_tokens budget → empty content. These must NOT be sent.
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    // We still request usage chunks (for cache stats) and use the configured sampling defaults.
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.temperature).toBe(1);
    expect(body.top_p).toBe(1);
  });

  it('requests usage chunks for every official DeepSeek streaming model', async () => {
    const fetchMock = vi.fn(async () => streamingResponse(buildSseWire(['x'])));
    vi.stubGlobal('fetch', fetchMock);

    const proxy = new OpenAiCompatibleModelProxy();
    await collect(
      proxy.streamCompletion(
        {
          ...CONFIG,
          baseUrl: 'https://api.deepseek.com',
          modelName: 'deepseek-chat',
        },
        MESSAGES,
        new AbortController().signal,
      ),
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('can disable DeepSeek thinking for bounded structured output', async () => {
    const fetchMock = vi.fn(async () => streamingResponse(buildSseWire(['{}'])));
    vi.stubGlobal('fetch', fetchMock);

    const proxy = new OpenAiCompatibleModelProxy();
    await collect(
      proxy.streamCompletion(
        {
          ...CONFIG,
          baseUrl: 'https://api.deepseek.com',
          modelName: 'deepseek-v4-flash',
        },
        MESSAGES,
        new AbortController().signal,
        { jsonMode: true, disableThinking: true },
      ),
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('keeps custom OpenAI-compatible endpoints free of DeepSeek-only fields', async () => {
    const fetchMock = vi.fn(async () => streamingResponse(buildSseWire(['x'])));
    vi.stubGlobal('fetch', fetchMock);

    const proxy = new OpenAiCompatibleModelProxy();
    await collect(
      proxy.streamCompletion(
        {
          ...CONFIG,
          baseUrl: 'https://provider.example.com/v1',
          modelName: 'deepseek-v4-pro',
        },
        MESSAGES,
        new AbortController().signal,
        { disableThinking: true },
      ),
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
  });
});

describe('OpenAiCompatibleModelProxy successful streaming', () => {
  it('yields provider deltas in order and concatenates to the full text (5.1, 5.2)', async () => {
    const deltas = ['从', '前', '有', '座', '山'];
    const fetchMock = vi.fn(async () => streamingResponse(buildSseWire(deltas)));
    vi.stubGlobal('fetch', fetchMock);

    const proxy = new OpenAiCompatibleModelProxy();
    const collected = await collect(
      proxy.streamCompletion(CONFIG, MESSAGES, new AbortController().signal),
    );

    expect(collected).toEqual(deltas);
    expect(collected.join('')).toBe('从前有座山');
  });
});

describe('OpenAiCompatibleModelProxy error handling', () => {
  it('throws ProxyError carrying the upstream status on a non-2xx response (5.5)', async () => {
    const fetchMock = vi.fn(async () => errorResponse(429));
    vi.stubGlobal('fetch', fetchMock);

    const proxy = new OpenAiCompatibleModelProxy();

    let thrown: unknown;
    try {
      await collect(proxy.streamCompletion(CONFIG, MESSAGES, new AbortController().signal));
    } catch (error) {
      thrown = error;
    }

    expect(isProxyError(thrown)).toBe(true);
    const err = thrown as ProxyError;
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.status).toBe(429);
  }, 20000);

  it('throws ProxyError when the request is aborted (5.5)', async () => {
    // Realistic mock: fetch rejects with an AbortError when the signal is set.
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      return streamingResponse(buildSseWire(['unused']));
    });
    vi.stubGlobal('fetch', fetchMock);

    const proxy = new OpenAiCompatibleModelProxy();
    const controller = new AbortController();
    controller.abort();

    let thrown: unknown;
    try {
      await collect(proxy.streamCompletion(CONFIG, MESSAGES, controller.signal));
    } catch (error) {
      thrown = error;
    }

    expect(isProxyError(thrown)).toBe(true);
    expect((thrown as ProxyError).code).toBe('PROVIDER_ERROR');
  });
});

describe('OpenAiCompatibleModelProxy API key safety (5.6)', () => {
  it('never leaks the API key in yielded deltas', async () => {
    const fetchMock = vi.fn(async () =>
      streamingResponse(buildSseWire(['safe', 'output', 'text'])),
    );
    vi.stubGlobal('fetch', fetchMock);

    const proxy = new OpenAiCompatibleModelProxy();
    const collected = await collect(
      proxy.streamCompletion(CONFIG, MESSAGES, new AbortController().signal),
    );

    for (const delta of collected) {
      expect(delta.includes(API_KEY)).toBe(false);
    }
    expect(collected.join('').includes(API_KEY)).toBe(false);
  });

  it('never leaks the API key in a ProxyError message or stack (non-2xx)', async () => {
    const fetchMock = vi.fn(async () => errorResponse(500));
    vi.stubGlobal('fetch', fetchMock);

    const proxy = new OpenAiCompatibleModelProxy();

    let thrown: unknown;
    try {
      await collect(proxy.streamCompletion(CONFIG, MESSAGES, new AbortController().signal));
    } catch (error) {
      thrown = error;
    }

    const err = thrown as ProxyError;
    expect(err.message.includes(API_KEY)).toBe(false);
    expect((err.stack ?? '').includes(API_KEY)).toBe(false);
  });

  it('never leaks the API key in a ProxyError message or stack (network failure)', async () => {
    // Simulate a low-level transport failure whose own message embeds the URL
    // (but never the key, since the key lives only in the request header).
    const fetchMock = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED provider.example.com:443');
    });
    vi.stubGlobal('fetch', fetchMock);

    const proxy = new OpenAiCompatibleModelProxy();

    let thrown: unknown;
    try {
      await collect(proxy.streamCompletion(CONFIG, MESSAGES, new AbortController().signal));
    } catch (error) {
      thrown = error;
    }

    expect(isProxyError(thrown)).toBe(true);
    const err = thrown as ProxyError;
    expect(err.message.includes(API_KEY)).toBe(false);
    expect((err.stack ?? '').includes(API_KEY)).toBe(false);
  }, 20000);
});
