import { join, resolve } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';

import { getCurrentClientId, isValidClientId } from '../services/client/clientScope.js';
import type { MemorySyncTarget } from '../types/SourceMemory.js';
import type { DataStore } from './DataStore.js';
import { FileDataStore } from './FileDataStore.js';

/**
 * Lazily selects one file-backed store for the browser library in the current
 * request. The 256-bit client id is validated before it reaches this module,
 * so it is safe to use as a filename and also acts as the library's bearer id.
 */
export function createClientScopedDataStore(rootDirectory: string): DataStore {
  const root = resolve(rootDirectory);
  const stores = new Map<string, Promise<FileDataStore>>();

  function storeFor(clientId: string): Promise<FileDataStore> {
    let store = stores.get(clientId);
    if (store === undefined) {
      store = FileDataStore.create(join(root, `${clientId}.json`), clientId);
      stores.set(clientId, store);
    }
    return store;
  }

  return new Proxy({} as DataStore, {
    get(_target, property) {
      if (property === 'then' || typeof property !== 'string') return undefined;
      if (property === 'listMemorySyncTargets') return async (): Promise<MemorySyncTarget[]> => {
        let files;
        try { files = await readdir(root, { withFileTypes: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
        const targets: MemorySyncTarget[] = [];
        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith('.json')) continue;
          const clientId = file.name.slice(0, -5);
          if (clientId !== 'local' && !isValidClientId(clientId)) continue;
          try {
            // Read only the identity list; a damaged client library cannot stop other clients.
            const parsed = JSON.parse(await readFile(join(root, file.name), 'utf8')) as { projects?: Array<{ id?: unknown; kind?: unknown }> };
            for (const project of parsed.projects ?? []) if (typeof project.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(project.id) && project.kind !== 'short_drama') targets.push({ clientId, projectId: project.id });
          } catch { /* The per-client store reports damage when explicitly opened; scanning remains isolated. */ }
        }
        return targets;
      };
      return async (...args: unknown[]) => {
        const store = await storeFor(getCurrentClientId());
        const method = Reflect.get(store, property) as unknown;
        if (typeof method !== 'function') {
          throw new TypeError(`Unknown DataStore method: ${property}`);
        }
        return Reflect.apply(method, store, args) as unknown;
      };
    },
  });
}
