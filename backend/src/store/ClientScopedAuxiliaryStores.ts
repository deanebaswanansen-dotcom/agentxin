import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { getCurrentClientId, isValidClientId } from '../services/client/clientScope.js';
import {
  LongNovelConfigStore,
  type LongNovelConfigStorePort,
} from '../services/agent/longNovel/LongNovelConfigStore.js';
import { MemoryStore, type MemoryStorePort } from '../services/memory/MemoryStore.js';
import { ReferenceStore, type ReferenceStorePort } from '../services/reference/ReferenceStore.js';
import {
  PlanSessionStore,
  type PlanSessionStorePort,
} from '../services/agent/plan/PlanSessionStore.js';

async function loadExisting<T>(
  rootDirectory: string,
  load: (path: string) => Promise<T>,
): Promise<{ root: string; stores: Map<string, T> }> {
  const root = resolve(rootDirectory);
  await mkdir(root, { recursive: true });
  const stores = new Map<string, T>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const clientId = entry.name.slice(0, -'.json'.length);
    if (clientId !== 'local' && !isValidClientId(clientId)) continue;
    stores.set(clientId, await load(join(root, entry.name)));
  }
  return { root, stores };
}

export async function createClientScopedMemoryStore(
  rootDirectory: string,
): Promise<MemoryStorePort> {
  const { root, stores } = await loadExisting(rootDirectory, MemoryStore.create);
  const current = (): MemoryStore => {
    const clientId = getCurrentClientId();
    let store = stores.get(clientId);
    if (store === undefined) {
      store = new MemoryStore(join(root, `${clientId}.json`));
      stores.set(clientId, store);
    }
    return store;
  };
  return {
    read: (projectId) => current().read(projectId),
    write: (projectId, memory) => current().write(projectId, memory),
    update: (projectId, mutator) => current().update(projectId, mutator),
    clearProject: (projectId) => current().clearProject(projectId),
  };
}

export async function createClientScopedReferenceStore(
  rootDirectory: string,
): Promise<ReferenceStorePort> {
  const { root, stores } = await loadExisting(rootDirectory, ReferenceStore.create);
  const current = (): ReferenceStore => {
    const clientId = getCurrentClientId();
    let store = stores.get(clientId);
    if (store === undefined) {
      store = new ReferenceStore(join(root, `${clientId}.json`));
      stores.set(clientId, store);
    }
    return store;
  };
  return {
    listNovels: () => current().listNovels(),
    getNovel: (id) => current().getNovel(id),
    saveNovel: (novel) => current().saveNovel(novel),
    deleteNovel: (id) => current().deleteNovel(id),
    getProjectConfig: (projectId) => current().getProjectConfig(projectId),
    saveProjectConfig: (config) => current().saveProjectConfig(config),
    clearProjectConfig: (projectId) => current().clearProjectConfig(projectId),
  };
}

export async function createClientScopedLongNovelConfigStore(
  rootDirectory: string,
): Promise<LongNovelConfigStorePort> {
  const { root, stores } = await loadExisting(rootDirectory, LongNovelConfigStore.create);
  const current = (): LongNovelConfigStore => {
    const clientId = getCurrentClientId();
    let store = stores.get(clientId);
    if (store === undefined) {
      store = new LongNovelConfigStore(join(root, `${clientId}.json`));
      stores.set(clientId, store);
    }
    return store;
  };
  return {
    get: (projectId) => current().get(projectId),
    save: (projectId, config) => current().save(projectId, config),
  };
}

export async function createClientScopedPlanSessionStore(
  rootDirectory: string,
): Promise<PlanSessionStorePort> {
  const { root, stores } = await loadExisting(rootDirectory, PlanSessionStore.create);
  const current = (): PlanSessionStore => {
    const clientId = getCurrentClientId();
    let store = stores.get(clientId);
    if (store === undefined) {
      store = new PlanSessionStore(join(root, `${clientId}.json`));
      stores.set(clientId, store);
    }
    return store;
  };
  return {
    get: (projectId) => current().get(projectId),
    save: (session) => current().save(session),
    clear: (projectId) => current().clear(projectId),
  };
}
