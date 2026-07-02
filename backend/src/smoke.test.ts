import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { buildServer } from './index.js';
import { FileDataStore } from './store/FileDataStore.js';

describe('backend toolchain smoke test', () => {
  it('responds to the health check route', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nwa-smoke-'));
    const store = await FileDataStore.create(join(dir, 'store.json'));
    const app = buildServer(store);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('fast-check is wired up (string concat length property)', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        return (a + b).length === a.length + b.length;
      }),
    );
  });
});
