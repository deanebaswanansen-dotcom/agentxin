import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { getCurrentClientId, registerClientScope } from '../services/client/clientScope.js';
import type { MemorySyncRunner } from '../services/memory/MemorySyncRunner.js';
import { ServiceError } from '../services/ServiceError.js';
import { registerMemorySyncRoutes } from './memorySyncRoutes.js';

describe('memory sync routes', () => {
  it('uses the request client for read and retry without accepting body scope or BYOK', async () => {
    const clientId = 'd'.repeat(64);
    const retry = vi.fn(async (projectId: string) => ({ projectId, clientId: getCurrentClientId(), status: 'succeeded' }));
    const query = vi.fn(async (projectId: string, beforeUnit: number) => {
      if (!Number.isSafeInteger(beforeUnit) || beforeUnit < 1) throw ServiceError.validation('beforeUnit必须为正整数');
      return { projectId, beforeUnit, clientId: getCurrentClientId(), entries: [], memorySync: { status: 'pending' } };
    });
    const app = Fastify();
    registerClientScope(app);
    registerMemorySyncRoutes(app, { getStatus: retry, retry, query } as unknown as MemorySyncRunner);
    const headers = { 'x-agentxin-client-id': clientId };
    const res = await app.inject({ method: 'POST', url: '/api/projects/p/memory-sync/retry', headers, payload: { clientId: 'e'.repeat(64), projectId: 'another' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ projectId: 'p', clientId });
    expect(retry).toHaveBeenCalledWith('p');
    const read = await app.inject({ method: 'GET', url: '/api/projects/p/source-memory?beforeUnit=3', headers });
    expect(read.json()).toMatchObject({ beforeUnit: 3, clientId, memorySync: { status: 'pending' } });
    const bad = await app.inject({ method: 'GET', url: '/api/projects/p/source-memory?beforeUnit=1.5', headers });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: 'GET', url: '/api/projects/p/source-memory', headers });
    expect(missing.statusCode).toBe(400);
    await app.close();
  });

  it('preserves project isolation failures instead of returning empty successful status', async () => {
    const app = Fastify();
    registerClientScope(app);
    registerMemorySyncRoutes(app, { getStatus: async () => { throw ServiceError.notFound('项目不存在。'); } } as unknown as MemorySyncRunner);
    const response = await app.inject({ method: 'GET', url: '/api/projects/deleted/memory-sync' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe('项目不存在。');
    await app.close();
  });
});
