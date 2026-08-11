import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runWithClientId } from '../services/client/clientScope.js';
import { createClientScopedDataStore } from './ClientScopedDataStore.js';

const CLIENT_A = 'a'.repeat(64);
const CLIENT_B = 'b'.repeat(64);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('ClientScopedDataStore', () => {
  it('keeps browser libraries isolated in separate files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentxin-clients-'));
    directories.push(directory);
    const store = createClientScopedDataStore(directory);

    await runWithClientId(CLIENT_A, () => store.createProject('A library'));
    await runWithClientId(CLIENT_B, () => store.createProject('B library'));

    await expect(runWithClientId(CLIENT_A, () => store.listProjects())).resolves.toEqual([
      expect.objectContaining({ name: 'A library' }),
    ]);
    await expect(runWithClientId(CLIENT_B, () => store.listProjects())).resolves.toEqual([
      expect.objectContaining({ name: 'B library' }),
    ]);
  });
});
