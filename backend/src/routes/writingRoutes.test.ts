/**
 * Basic route integration tests for {@link registerWritingRoutes} (task 11.5).
 *
 * These `app.inject` tests use a MOCK {@link WritingService} so the route's SSE
 * framing and unified error mapping can be exercised in isolation from the
 * model proxy / store. With `app.inject`, the (hijacked) streaming response
 * resolves once the stream ends, so assertions run against the fully
 * accumulated SSE body.
 *
 * Wire contract under test (must match `frontend/src/api/apiClient.ts`):
 *   - delta:  `event: delta\ndata: <JSON string>\n\n`
 *   - done:   `event: done\n\n`
 *   - error:  `event: error\ndata: <JSON ApiError>\n\n`
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { ProxyError } from '../proxy/ProxyError.js';
import type { StreamDelta } from '../proxy/sseParser.js';
import { ServiceError } from '../services/ServiceError.js';
import type { WritingService } from '../services/writing/WritingService.js';
import type { WritingRequestBody } from '../types/index.js';
import { registerWritingRoutes } from './writingRoutes.js';

/** Build a mock WritingService whose `streamWriting` runs the supplied impl. */
function mockWritingService(
  impl: (signal: AbortSignal) => Promise<AsyncIterable<StreamDelta>>,
): WritingService {
  return {
    streamWriting: (
      _projectId: string,
      _chapterId: string,
      _body: WritingRequestBody,
      signal: AbortSignal,
    ) => impl(signal),
  } as unknown as WritingService;
}

/** Turn an array of chunks into an async iterable (simulates provider deltas). */
async function* fromChunks(chunks: string[]): AsyncIterable<StreamDelta> {
  for (const chunk of chunks) {
    yield { kind: 'content' as const, text: chunk };
  }
}

const VALID_BODY: WritingRequestBody = { operation: 'continue', instruction: '继续写' };

describe('writingRoutes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  async function buildApp(service: WritingService): Promise<void> {
    app = Fastify({ logger: false });
    registerWritingRoutes(app, service);
    await app.ready();
  }

  it('streams provider deltas then a done sentinel (Req 5.3)', async () => {
    const deltas = ['你好', '，', '世界'];
    await buildApp(mockWritingService(() => Promise.resolve(fromChunks(deltas))));

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/p1/chapters/c1/write',
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const body = res.body;

    // Each delta is JSON-encoded inside a `data:` line of a `delta` event.
    for (const delta of deltas) {
      expect(body).toContain(`event: delta\ndata: ${JSON.stringify(delta)}\n\n`);
    }
    // Concatenated decoded deltas equal the provider output (no loss/reorder).
    const decoded = [...body.matchAll(/event: delta\ndata: (.*)\n\n/g)].map((m) =>
      JSON.parse(m[1]) as string,
    );
    expect(decoded.join('')).toBe(deltas.join(''));
    // Stream terminates with the done sentinel.
    expect(body).toContain('event: done\n\n');
    expect(body).not.toContain('event: error');
  });

  it('emits an error event when streamWriting rejects before streaming (Req 5.4)', async () => {
    await buildApp(
      mockWritingService(() =>
        Promise.reject(ServiceError.modelNotConfigured('尚未配置模型。')),
      ),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/p1/chapters/c1/write',
      payload: VALID_BODY,
    });

    // The response is committed as an event stream even on a pre-stream failure.
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const match = res.body.match(/event: error\ndata: (.*)\n\n/);
    expect(match).not.toBeNull();
    const apiError = JSON.parse(match![1]) as { error: { code: string; message: string } };
    expect(apiError.error.code).toBe('MODEL_NOT_CONFIGURED');
    expect(apiError.error.message).toBe('尚未配置模型。');
    expect(res.body).not.toContain('event: done');
  });

  it('forwards earlier deltas then an error event on a mid-stream ProxyError (Req 5.5)', async () => {
    async function* failingMidStream(): AsyncIterable<StreamDelta> {
      yield { kind: 'content', text: '开头' };
      throw new ProxyError('提供商返回错误状态。', { status: 502 });
    }
    await buildApp(mockWritingService(() => Promise.resolve(failingMidStream())));

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/p1/chapters/c1/write',
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(200);
    // The delta received before the failure is forwarded...
    expect(res.body).toContain(`event: delta\ndata: ${JSON.stringify('开头')}\n\n`);
    // ...followed by a PROVIDER_ERROR error event, and no done sentinel.
    const match = res.body.match(/event: error\ndata: (.*)\n\n/);
    expect(match).not.toBeNull();
    const apiError = JSON.parse(match![1]) as { error: { code: string } };
    expect(apiError.error.code).toBe('PROVIDER_ERROR');
    expect(res.body).not.toContain('event: done');
  });

  it('rejects a malformed body with a VALIDATION_ERROR error event', async () => {
    await buildApp(mockWritingService(() => Promise.resolve(fromChunks([]))));

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/p1/chapters/c1/write',
      payload: { operation: 'invalid', instruction: '继续写' },
    });

    expect(res.statusCode).toBe(200);
    const match = res.body.match(/event: error\ndata: (.*)\n\n/);
    expect(match).not.toBeNull();
    const apiError = JSON.parse(match![1]) as { error: { code: string } };
    expect(apiError.error.code).toBe('VALIDATION_ERROR');
  });
});
