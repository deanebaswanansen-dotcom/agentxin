import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runWithClientId } from '../services/client/clientScope.js';
import { defaultLongNovelConfig } from '../services/agent/longNovel/qualityGates.js';
import {
  createClientScopedLongNovelConfigStore,
  createClientScopedMemoryStore,
  createClientScopedReferenceStore,
} from './ClientScopedAuxiliaryStores.js';

const CLIENT_A = 'c'.repeat(64);
const CLIENT_B = 'd'.repeat(64);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('client-scoped auxiliary stores', () => {
  it('isolates memory, references, and long-novel settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-aux-'));
    directories.push(directory);
    const memory = await createClientScopedMemoryStore(join(directory, 'memory'));
    const references = await createClientScopedReferenceStore(join(directory, 'references'));
    const longNovel = await createClientScopedLongNovelConfigStore(join(directory, 'long-novel'));

    await runWithClientId(CLIENT_A, () =>
      memory.update('project', (value) => {
        value.facts.push({ id: 'fact', kind: 'plot', text: 'A only', at: '2026-01-01' });
      }),
    );
    await runWithClientId(CLIENT_A, () =>
      references.saveNovel({
        id: 'reference',
        title: 'A only',
        depth: 'quick',
        status: 'ready',
        chapters: [],
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      }),
    );
    await runWithClientId(CLIENT_A, () =>
      longNovel.save('project', { ...defaultLongNovelConfig(), targetWords: 999 }),
    );

    expect(runWithClientId(CLIENT_B, () => memory.read('project').facts)).toEqual([]);
    expect(runWithClientId(CLIENT_B, () => references.listNovels())).toEqual([]);
    expect(runWithClientId(CLIENT_B, () => longNovel.get('project').targetWords)).toBe(200_000);
  });
});
