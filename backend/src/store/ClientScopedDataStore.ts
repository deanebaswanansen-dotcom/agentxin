import { join, resolve } from 'node:path';

import { getCurrentClientId } from '../services/client/clientScope.js';
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

  function currentStore(): Promise<FileDataStore> {
    const clientId = getCurrentClientId();
    let store = stores.get(clientId);
    if (store === undefined) {
      store = FileDataStore.create(join(root, `${clientId}.json`));
      stores.set(clientId, store);
    }
    return store;
  }

  return new Proxy({} as DataStore, {
    get(_target, property) {
      if (property === 'then' || typeof property !== 'string') return undefined;
      return async (...args: unknown[]) => {
        const store = await currentStore();
        const method = Reflect.get(store, property) as unknown;
        if (typeof method !== 'function') {
          throw new TypeError(`Unknown DataStore method: ${property}`);
        }
        return Reflect.apply(method, store, args) as unknown;
      };
    },
  });
}
