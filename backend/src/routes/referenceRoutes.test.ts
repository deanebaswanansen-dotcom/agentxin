import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReferenceAnalysisService } from '../services/reference/ReferenceAnalysisService.js';
import { ServiceError } from '../services/ServiceError.js';
import { registerReferenceRoutes } from './referenceRoutes.js';

describe('referenceRoutes analyze-stream', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  async function build(analyze: ReferenceAnalysisService['analyze']): Promise<void> {
    app = Fastify({ logger: false });
    registerReferenceRoutes(
      app,
      {
        analyze,
        list: vi.fn(),
        get: vi.fn(),
        importText: vi.fn(),
        purgeRawText: vi.fn(),
        remove: vi.fn(),
        transferToProject: vi.fn(),
        buildActiveTransferPrompt: vi.fn(),
        checkSimilarity: vi.fn(),
      } as unknown as ReferenceAnalysisService,
    );
    await app.ready();
  }

  it('keeps the response active and returns result plus done', async () => {
    const result = {
      reference: { id: 'ref-1', title: '样例', depth: 'standard', status: 'ready' },
      profile: {},
      analysisProjectId: 'project-1',
      analysisProjectName: '小说拆解 · 样例',
      artifacts: [],
      chaptersAnalyzed: 1,
      chaptersSelected: 1,
      message: '完成',
    };
    await build(vi.fn().mockResolvedValue(result) as unknown as ReferenceAnalysisService['analyze']);

    const response = await app.inject({
      method: 'POST',
      url: '/api/references/ref-1/analyze-stream',
      payload: { chapterIds: ['chapter-1'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain(': heartbeat\n\n');
    expect(response.body).toContain('event: progress');
    expect(response.body).toContain(`event: result\ndata: ${JSON.stringify(result)}\n\n`);
    expect(response.body).toContain('event: done\n\n');
  });

  it('returns service failures as SSE error frames', async () => {
    await build(
      vi.fn().mockRejectedValue(ServiceError.validation('请至少勾选一章。')) as unknown as ReferenceAnalysisService['analyze'],
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/references/ref-1/analyze-stream',
      payload: { chapterIds: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: error');
    expect(response.body).toContain('VALIDATION_ERROR');
    expect(response.body).not.toContain('event: done');
  });
});
