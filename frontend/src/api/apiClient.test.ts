import { describe, it, expect, vi, afterEach } from 'vitest';
import fc from 'fast-check';
import {
  ApiClientError,
  createApiClient,
  isApiClientError,
  parseSseEvents,
  runAgentBackgroundJob,
  type SseEvent,
} from './apiClient.js';
import type {
  AgentRunRequest,
  AgentRunResult,
  ApiError,
  ModelConfig,
  WritingRequestBody,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// fetch mocking helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, init?: { status?: number; statusText?: string }): Response {
  const status = init?.status ?? 200;
  // 204/205/304 are "null body status" codes; a body (even '') is invalid.
  const nullBodyStatus = status === 204 || status === 205 || status === 304;
  const payload = nullBodyStatus || body === undefined ? null : JSON.stringify(body);
  return new Response(payload, {
    status,
    statusText: init?.statusText ?? '',
    headers: { 'Content-Type': 'application/json' },
  });
}

function htmlResponse(body = '<!doctype html><html></html>'): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}

/** Build a Response whose body is a ReadableStream emitting the given chunks. */
function sseResponse(chunks: string[], init?: { status?: number }): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function installFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init)),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  client().modelConfig.clear();
  try {
    window.localStorage.removeItem('nwa.modelConfig.v1');
  } catch {
    // ignore
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const client = () => createApiClient('/api');

// ---------------------------------------------------------------------------
// Request building + success parsing
// ---------------------------------------------------------------------------

describe('apiClient request building', () => {
  it('persists model config to localStorage, sends it as a request header, and clears it', async () => {
    const api = client();
    const config: ModelConfig = {
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-secret-key',
      modelName: 'novel-model',
      temperature: 0.75,
      topP: 0.85,
    };

    await expect(api.modelConfig.get()).resolves.toEqual({
      baseUrl: '',
      modelName: '',
      apiKeyMasked: '',
      temperature: 1,
      topP: 1,
    });
    const mock = installFetch((url) => {
      if (String(url).includes('/model-config')) {
        return jsonResponse({
          baseUrl: config.baseUrl,
          modelName: config.modelName,
          apiKeyMasked: '****-key',
          temperature: 0.75,
          topP: 0.85,
        });
      }
      return jsonResponse([]);
    });
    await expect(api.modelConfig.save(config)).resolves.toEqual({
      baseUrl: 'https://api.example.com',
      modelName: 'novel-model',
      apiKeyMasked: '****-key',
      temperature: 0.75,
      topP: 0.85,
    });
    expect(window.localStorage.getItem('nwa.modelConfig.v1')).toContain('sk-secret-key');

    await api.projects.list();
    const listCall = mock.mock.calls.find((call) => String(call[0]).includes('/projects'));
    const listHeaders = listCall?.[1]?.headers as Record<string, string>;
    expect(listHeaders['X-Agentxin-Model-Config']).toBeUndefined();
    expect(listHeaders['X-Agentxin-Client-Id']).toMatch(/^[a-f0-9]{64}$/);

    await api.agent.run({ task: 'novel', mode: 'draft', prompt: '测试模型任务' });
    const agentCall = mock.mock.calls.find((call) => String(call[0]).endsWith('/agent/run'));
    const agentHeaders = agentCall?.[1]?.headers as Record<string, string>;
    expect(JSON.parse(decodeURIComponent(agentHeaders['X-Agentxin-Model-Config']))).toEqual(config);

    // New client instance still hydrates from localStorage
    const api2 = createApiClient('/api');
    await expect(api2.modelConfig.get()).resolves.toEqual({
      baseUrl: 'https://api.example.com',
      modelName: 'novel-model',
      apiKeyMasked: '****-key',
      temperature: 0.75,
      topP: 0.85,
    });

    api.modelConfig.clear();
    await expect(api.modelConfig.get()).resolves.toEqual({
      baseUrl: '',
      modelName: '',
      apiKeyMasked: '',
      temperature: 1,
      topP: 1,
    });
    expect(window.localStorage.getItem('nwa.modelConfig.v1')).toBeNull();
  });

  it('issues a POST with JSON body for project creation and parses the result', async () => {
    const mock = installFetch(() => jsonResponse({ id: 'p1' }, { status: 201 }));
    const result = await client().projects.create('我的小说');

    expect(result).toEqual({ id: 'p1' });
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe('/api/projects');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ name: '我的小说' });
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init?.headers as Record<string, string>)['X-Agentxin-Client-Id']).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it('encodes id path segments', async () => {
    const mock = installFetch(() => jsonResponse(undefined, { status: 204 }));
    await client().chapters.remove('a/b c');
    expect(mock.mock.calls[0][0]).toBe('/api/chapters/a%2Fb%20c');
  });

  it('returns parsed chapter list on GET', async () => {
    const chapters = [
      { id: 'c1', projectId: 'p1', title: 'T', content: '', position: 0 },
    ];
    installFetch(() => jsonResponse(chapters));
    await expect(client().chapters.list('p1')).resolves.toEqual(chapters);
  });

  it('rejects HTML fallback responses from static hosting', async () => {
    installFetch(() => htmlResponse());
    const err: ApiClientError = await client().projects.list().catch((e) => e);

    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.code).toBe('STORE_ERROR');
    expect(err.message).toContain('非 JSON 响应');
  });
});

// ---------------------------------------------------------------------------
// Unified error handling
// ---------------------------------------------------------------------------

describe('apiClient unified error handling', () => {
  it('throws ApiClientError carrying a valid backend ApiError verbatim', async () => {
    const apiError: ApiError = { error: { code: 'NOT_FOUND', message: '项目不存在' } };
    installFetch(() => jsonResponse(apiError, { status: 404 }));

    const err = await client()
      .projects.rename('missing', 'x')
      .catch((e) => e);
    expect(isApiClientError(err)).toBe(true);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('项目不存在');
    expect(err.status).toBe(404);
    expect(err.apiError).toEqual(apiError);
  });

  it('synthesizes an ApiError when the body is not in ApiError shape', async () => {
    installFetch(() => jsonResponse({ oops: true }, { status: 400 }));
    const err: ApiClientError = await client().projects.create('x').catch((e) => e);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('synthesizes a STORE_ERROR for unmapped 5xx statuses', async () => {
    installFetch(() => jsonResponse(undefined, { status: 500, statusText: 'Internal Error' }));
    const err: ApiClientError = await client().projects.list().catch((e) => e);
    expect(err.code).toBe('STORE_ERROR');
    expect(err.status).toBe(500);
  });

  it('maps known statuses to codes when body lacks a code', async () => {
    const cases: Array<[number, string]> = [
      [400, 'VALIDATION_ERROR'],
      [404, 'NOT_FOUND'],
      [409, 'MODEL_NOT_CONFIGURED'],
      [502, 'PROVIDER_ERROR'],
    ];
    for (const [status, code] of cases) {
      installFetch(() => jsonResponse('', { status }));
      const err: ApiClientError = await client().projects.list().catch((e) => e);
      expect(err.code).toBe(code);
      vi.unstubAllGlobals();
    }
  });
});

describe('Netlify background Agent jobs', () => {
  it('submits credentials once, polls by client id, and returns progress plus result', async () => {
    const config: ModelConfig = {
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-browser-only',
      modelName: 'novel-model',
    };
    await client().modelConfig.save(config);
    const result: AgentRunResult = {
      task: 'novel',
      mode: 'draft',
      projectId: 'p1',
      summary: '完成',
      steps: ['完成'],
      artifacts: [],
    };
    const progress = vi.fn();
    const mock = installFetch((url, init) => {
      if (url.endsWith('/agent-job-background')) {
        return new Response(null, { status: 202 });
      }
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({
        state: 'completed',
        events: [{ phase: 'setup', message: '后台已启动' }],
        result,
      });
    });
    const request: AgentRunRequest = {
      task: 'novel',
      mode: 'draft',
      prompt: '测试',
    };

    await expect(runAgentBackgroundJob('/api', request, { onProgress: progress })).resolves.toEqual(
      result,
    );
    expect(progress).toHaveBeenCalledWith({ phase: 'setup', message: '后台已启动' });

    const start = mock.mock.calls.find((call) => String(call[0]).endsWith('/agent-job-background'));
    const poll = mock.mock.calls.find(
      (call) => String(call[0]).includes('/agent-job?jobId=') && call[1]?.method !== 'DELETE',
    );
    expect((start?.[1]?.headers as Record<string, string>)['X-Agentxin-Model-Config']).toBeDefined();
    expect((poll?.[1]?.headers as Record<string, string>)['X-Agentxin-Model-Config']).toBeUndefined();
    expect((poll?.[1]?.headers as Record<string, string>)['X-Agentxin-Client-Id']).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
});

// ---------------------------------------------------------------------------
// SSE parsing (pure function)
// ---------------------------------------------------------------------------

describe('parseSseEvents', () => {
  it('parses complete events and retains a trailing partial block', () => {
    const { events, rest } = parseSseEvents(
      'event: delta\ndata: "hi"\n\nevent: delta\ndata: "the',
    );
    expect(events).toEqual<SseEvent[]>([{ event: 'delta', data: '"hi"' }]);
    expect(rest).toBe('event: delta\ndata: "the');
  });

  it('handles CRLF line endings and multi-line data', () => {
    const { events } = parseSseEvents('event: x\r\ndata: a\r\ndata: b\r\n\r\n');
    expect(events).toEqual<SseEvent[]>([{ event: 'x', data: 'a\nb' }]);
  });

  it('defaults the event name to message and ignores comments', () => {
    const { events } = parseSseEvents(': keep-alive\ndata: hello\n\n');
    expect(events).toEqual<SseEvent[]>([{ event: 'message', data: 'hello' }]);
  });
});

// ---------------------------------------------------------------------------
// write() SSE streaming
// ---------------------------------------------------------------------------

const writeBody: WritingRequestBody = { operation: 'continue', instruction: '续写' };

describe('apiClient.write SSE streaming', () => {
  it('forwards deltas in order and resolves with the concatenated text', async () => {
    installFetch(() =>
      sseResponse([
        'event: delta\ndata: "Hello "\n\n',
        'event: delta\ndata: "world"\n\n',
        'event: done\ndata:\n\n',
      ]),
    );

    const deltas: string[] = [];
    const full = await client().write('p1', 'c1', writeBody, {
      onDelta: (d) => deltas.push(d),
    });

    expect(deltas).toEqual(['Hello ', 'world']);
    expect(full).toBe('Hello world');
  });

  it('strips leaked think blocks from streamed writing deltas', async () => {
    installFetch(() =>
      sseResponse([
        'event: delta\ndata: "第一段<th"\n\n',
        'event: delta\ndata: "ink>内部推理"\n\n',
        'event: delta\ndata: "</think>第二段"\n\n',
        'event: done\ndata:\n\n',
      ]),
    );

    const deltas: string[] = [];
    const full = await client().write('p1', 'c1', writeBody, {
      onDelta: (d) => deltas.push(d),
    });

    expect(deltas).toEqual(['第一段', '第二段']);
    expect(full).toBe('第一段第二段');
  });

  it('reassembles deltas split across network chunks', async () => {
    installFetch(() =>
      sseResponse(['event: delta\nda', 'ta: "ab"\n\nevent: del', 'ta\ndata: "cd"\n\n']),
    );
    const full = await client().write('p1', 'c1', writeBody);
    expect(full).toBe('abcd');
  });

  it('rejects with ApiClientError on an event: error frame', async () => {
    const apiError: ApiError = {
      error: { code: 'PROVIDER_ERROR', message: '提供商超时' },
    };
    installFetch(() =>
      sseResponse([
        'event: delta\ndata: "partial"\n\n',
        `event: error\ndata: ${JSON.stringify(apiError)}\n\n`,
      ]),
    );

    const err: ApiClientError = await client()
      .write('p1', 'c1', writeBody)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.message).toBe('提供商超时');
  });

  it('converts a non-success HTTP write response into ApiClientError', async () => {
    const apiError: ApiError = {
      error: { code: 'MODEL_NOT_CONFIGURED', message: '请先配置模型' },
    };
    installFetch(() => jsonResponse(apiError, { status: 409 }));
    const err: ApiClientError = await client()
      .write('p1', 'c1', writeBody)
      .catch((e) => e);
    expect(err.code).toBe('MODEL_NOT_CONFIGURED');
    expect(err.message).toBe('请先配置模型');
  });

  it('posts the writing body with SSE Accept header', async () => {
    const mock = installFetch(() => sseResponse(['event: done\ndata:\n\n']));
    await client().write('p 1', 'c/1', writeBody);
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe('/api/projects/p%201/chapters/c%2F1/write');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Accept).toBe('text/event-stream');
    expect(JSON.parse(String(init?.body))).toEqual(writeBody);
  });
});

describe('apiClient imports', () => {
  it('posts dropped novel files to the import endpoint', async () => {
    const mock = installFetch(() =>
      jsonResponse({
        projectId: 'p1',
        sourceName: 'book',
        filesImported: 1,
        chaptersCreated: 1,
        charactersCreated: 1,
        worldSettingsCreated: 1,
        outlinesCreated: 1,
        firstChapterId: 'c1',
        summary: 'ok',
        artifacts: [],
      }),
    );

    await client().imports.organizeNovel('p/1', {
      sourceName: 'book',
      files: [{ path: 'book.md', content: '# 第一章\n正文' }],
    });

    const [url, init] = mock.mock.calls[0];
    expect(url).toBe('/api/projects/p%2F1/import/novel');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      sourceName: 'book',
      files: [{ path: 'book.md', content: '# 第一章\n正文' }],
    });
  });
});

// ---------------------------------------------------------------------------
// Property: SSE deltas are forwarded losslessly and in order
// ---------------------------------------------------------------------------

describe('apiClient.write delta integrity (property)', () => {
  it('concatenated forwarded deltas equal the source regardless of chunk boundaries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.string().filter((value) => !/<\s*\/?\s*(think|thinking|reasoning)/i.test(value)),
          { minLength: 0, maxLength: 20 },
        ),
        fc.integer({ min: 1, max: 64 }),
        async (sourceDeltas, chunkSize) => {
          // Build the full SSE wire text, then re-slice into arbitrary chunks.
          const frames =
            sourceDeltas.map((d) => `event: delta\ndata: ${JSON.stringify(d)}\n\n`).join('') +
            'event: done\ndata:\n\n';
          const chunks: string[] = [];
          for (let i = 0; i < frames.length; i += chunkSize) {
            chunks.push(frames.slice(i, i + chunkSize));
          }

          installFetch(() => sseResponse(chunks));
          const received: string[] = [];
          const full = await client().write('p', 'c', writeBody, {
            onDelta: (d) => received.push(d),
          });
          vi.unstubAllGlobals();

          // Empty-string deltas are dropped (no-op), so compare non-empty source.
          const nonEmpty = sourceDeltas.filter((d) => d.length > 0);
          expect(received.join('')).toBe(nonEmpty.join(''));
          expect(full).toBe(nonEmpty.join(''));
        },
      ),
      { numRuns: 100 },
    );
  });
});
