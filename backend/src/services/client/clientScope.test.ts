import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { getCurrentClientId, registerClientScope, runWithStoredClientId } from './clientScope.js';

const ORIGINAL_REQUIRE_CLIENT_ID = process.env.REQUIRE_CLIENT_ID;

afterEach(() => {
  if (ORIGINAL_REQUIRE_CLIENT_ID === undefined) delete process.env.REQUIRE_CLIENT_ID;
  else process.env.REQUIRE_CLIENT_ID = ORIGINAL_REQUIRE_CLIENT_ID;
});

describe('clientScope', () => {
  it('restores local internally without allowing local or traversal ids in headers', async () => {
    expect(await runWithStoredClientId('local', async () => { await Promise.resolve(); return getCurrentClientId(); })).toBe('local');
    expect(() => runWithStoredClientId('../escape', () => undefined)).toThrow();
    const app = Fastify();
    registerClientScope(app);
    app.get('/api/client', async () => ({ clientId: getCurrentClientId() }));
    expect((await app.inject({ method: 'GET', url: '/api/client', headers: { 'x-agentxin-client-id': 'local' } })).statusCode).toBe(400);
    await app.close();
  });
  it('binds a valid browser library id to the request', async () => {
    const app = Fastify();
    registerClientScope(app);
    app.get('/api/client', async () => ({ clientId: getCurrentClientId() }));
    const clientId = 'e'.repeat(64);
    const response = await app.inject({
      method: 'GET',
      url: '/api/client',
      headers: { 'x-agentxin-client-id': clientId },
    });
    expect(response.json()).toEqual({ clientId });
    await app.close();
  });

  it('rejects an unscoped production API request', async () => {
    process.env.REQUIRE_CLIENT_ID = '1';
    const app = Fastify();
    registerClientScope(app);
    app.get('/api/client', async () => ({ clientId: getCurrentClientId() }));
    const response = await app.inject({ method: 'GET', url: '/api/client' });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('keeps the API health probe public in client-scoped production', async () => {
    process.env.REQUIRE_CLIENT_ID = '1';
    const app = Fastify();
    registerClientScope(app);
    app.get('/api/health', async () => ({ status: 'ok' }));
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
