import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { getCurrentClientId } from '../client/clientScope.js';
import { StoreError } from '../../store/StoreError.js';
import type {
  ScriptCharacter,
  ScriptContinuityState,
  ScriptEpisode,
  ScriptEpisodeOutline,
  ScriptPlan,
  ScriptProjectState,
  ScriptSeriesOutline,
  ScriptWorldBible,
} from './domain.js';
import {
  assertExpectedRevision,
  type ScriptStore,
} from './ScriptStore.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RENAME_DELAYS_MS = [5, 15, 35, 75, 150, 300] as const;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function emptyState(projectId: string): ScriptProjectState {
  return {
    schemaVersion: 1,
    projectId,
    characters: [],
    episodeOutlines: [],
    episodes: [],
    continuity: {
      currentState: [],
      openThreads: [],
      wardrobeLedger: [],
    },
    updatedAt: new Date().toISOString(),
  };
}

function normalizeState(value: unknown, projectId: string): ScriptProjectState {
  if (typeof value !== 'object' || value === null) {
    throw new StoreError(`短剧项目文件格式无效: ${projectId}`);
  }
  const input = value as Partial<ScriptProjectState>;
  if (input.schemaVersion !== 1) {
    throw new StoreError(`不支持的短剧存储版本: ${String(input.schemaVersion)}`);
  }
  if (input.projectId !== undefined && input.projectId !== projectId) {
    throw new StoreError(`短剧项目标识与文件名不一致: ${projectId}`);
  }
  const continuity = input.continuity;
  return {
    schemaVersion: 1,
    projectId,
    ...(input.plan ? { plan: clone(input.plan) } : {}),
    characters: Array.isArray(input.characters) ? clone(input.characters) : [],
    ...(input.worldBible ? { worldBible: clone(input.worldBible) } : {}),
    ...(input.seriesOutline ? { seriesOutline: clone(input.seriesOutline) } : {}),
    episodeOutlines: Array.isArray(input.episodeOutlines)
      ? clone(input.episodeOutlines)
      : [],
    episodes: Array.isArray(input.episodes) ? clone(input.episodes) : [],
    continuity: {
      currentState: Array.isArray(continuity?.currentState)
        ? clone(continuity.currentState)
        : [],
      openThreads: Array.isArray(continuity?.openThreads)
        ? clone(continuity.openThreads)
        : [],
      wardrobeLedger: Array.isArray(continuity?.wardrobeLedger)
        ? clone(continuity.wardrobeLedger)
        : [],
    },
    updatedAt:
      typeof input.updatedAt === 'string'
        ? input.updatedAt
        : new Date(0).toISOString(),
  };
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isTransientRenameError(error: unknown): boolean {
  return (
    isErrno(error) &&
    ['EPERM', 'EBUSY', 'EACCES', 'EEXIST', 'ENOTEMPTY'].includes(error.code ?? '')
  );
}

async function renameWithRetry(tempPath: string, targetPath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempPath, targetPath);
      return;
    } catch (error) {
      if (attempt >= RENAME_DELAYS_MS.length || !isTransientRenameError(error)) throw error;
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, RENAME_DELAYS_MS[attempt]);
      });
    }
  }
}

/** One file per project. A FileScriptStore instance represents one client library. */
export class FileScriptStore implements ScriptStore {
  private readonly rootDirectory: string;
  private readonly loaded = new Set<string>();
  private readonly states = new Map<string, ScriptProjectState | undefined>();
  private readonly mutationQueues = new Map<string, Promise<void>>();

  private constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory);
  }

  static async create(rootDirectory: string): Promise<FileScriptStore> {
    await mkdir(resolve(rootDirectory), { recursive: true });
    return new FileScriptStore(rootDirectory);
  }

  private filePath(projectId: string): string {
    if (!SAFE_ID.test(projectId)) {
      throw new StoreError(`短剧项目标识格式无效: ${projectId}`);
    }
    return join(this.rootDirectory, `${projectId}.json`);
  }

  private async load(projectId: string): Promise<ScriptProjectState | undefined> {
    if (this.loaded.has(projectId)) return this.states.get(projectId);
    const filePath = this.filePath(projectId);
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
      const state = normalizeState(parsed, projectId);
      this.states.set(projectId, state);
      this.loaded.add(projectId);
      return state;
    } catch (error) {
      if (isErrno(error) && error.code === 'ENOENT') {
        this.states.set(projectId, undefined);
        this.loaded.add(projectId);
        return undefined;
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError(`读取短剧项目失败: ${projectId}`, { cause: error });
    }
  }

  private async persist(state: ScriptProjectState): Promise<void> {
    const filePath = this.filePath(state.projectId);
    const tempPath = `${filePath}.tmp-${randomUUID()}`;
    try {
      await mkdir(this.rootDirectory, { recursive: true });
      await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8');
      await renameWithRetry(tempPath, filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw new StoreError(`写入短剧项目失败: ${state.projectId}`, { cause: error });
    }
  }

  private mutate<T>(
    projectId: string,
    operation: (state: ScriptProjectState) => Promise<T> | T,
  ): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise;
      rejectResult = rejectPromise;
    });
    const previous = this.mutationQueues.get(projectId) ?? Promise.resolve();
    const run = async (): Promise<void> => {
      try {
        const current = (await this.load(projectId)) ?? emptyState(projectId);
        const working = clone(current);
        const value = await operation(working);
        working.updatedAt = new Date().toISOString();
        await this.persist(working);
        this.states.set(projectId, working);
        this.loaded.add(projectId);
        resolveResult(clone(value));
      } catch (error) {
        rejectResult(error);
      }
    };
    const queued = previous.then(run, run);
    this.mutationQueues.set(projectId, queued);
    void queued.finally(() => {
      if (this.mutationQueues.get(projectId) === queued) this.mutationQueues.delete(projectId);
    });
    return result;
  }

  async getProjectState(projectId: string): Promise<ScriptProjectState | undefined> {
    const queued = this.mutationQueues.get(projectId);
    if (queued) await queued;
    const state = await this.load(projectId);
    return state ? clone(state) : undefined;
  }

  savePlan(plan: ScriptPlan, expectedRevision?: number): Promise<ScriptPlan> {
    return this.mutate(plan.projectId, (state) => {
      const currentRevision = state.plan?.revision ?? 0;
      assertExpectedRevision(expectedRevision, currentRevision);
      const saved: ScriptPlan = {
        ...clone(plan),
        revision: currentRevision + 1,
        createdAt: state.plan?.createdAt ?? plan.createdAt,
        updatedAt: new Date().toISOString(),
      };
      state.plan = saved;
      return saved;
    });
  }

  saveCharacters(
    projectId: string,
    items: ScriptCharacter[],
    expectedRevision?: number,
  ): Promise<ScriptCharacter[]> {
    return this.mutate(projectId, (state) => {
      const currentRevision = Math.max(0, ...state.characters.map((item) => item.revision));
      assertExpectedRevision(expectedRevision, currentRevision);
      const updatedAt = new Date().toISOString();
      const saved = clone(items).map((item) => ({
        ...item,
        projectId,
        revision: currentRevision + 1,
        updatedAt,
      }));
      state.characters = saved;
      return saved;
    });
  }

  saveWorldBible(
    value: ScriptWorldBible,
    expectedRevision?: number,
  ): Promise<ScriptWorldBible> {
    return this.mutate(value.projectId, (state) => {
      const currentRevision = state.worldBible?.revision ?? 0;
      assertExpectedRevision(expectedRevision, currentRevision);
      const saved = {
        ...clone(value),
        revision: currentRevision + 1,
        updatedAt: new Date().toISOString(),
      };
      state.worldBible = saved;
      return saved;
    });
  }

  saveSeriesOutline(
    value: ScriptSeriesOutline,
    expectedRevision?: number,
  ): Promise<ScriptSeriesOutline> {
    return this.mutate(value.projectId, (state) => {
      const currentRevision = state.seriesOutline?.revision ?? 0;
      assertExpectedRevision(expectedRevision, currentRevision);
      const saved = { ...clone(value), revision: currentRevision + 1 };
      state.seriesOutline = saved;
      return saved;
    });
  }

  saveEpisodeOutline(
    value: ScriptEpisodeOutline,
    expectedRevision?: number,
  ): Promise<ScriptEpisodeOutline> {
    return this.mutate(value.projectId, (state) => {
      const index = state.episodeOutlines.findIndex(
        (item) => item.episodeNumber === value.episodeNumber,
      );
      const currentRevision = index >= 0 ? state.episodeOutlines[index]!.revision : 0;
      assertExpectedRevision(expectedRevision, currentRevision);
      const saved = { ...clone(value), revision: currentRevision + 1 };
      if (index >= 0) state.episodeOutlines[index] = saved;
      else state.episodeOutlines.push(saved);
      state.episodeOutlines.sort((a, b) => a.episodeNumber - b.episodeNumber);
      return saved;
    });
  }

  saveEpisode(
    value: ScriptEpisode,
    expectedRevision?: number,
  ): Promise<ScriptEpisode> {
    return this.mutate(value.projectId, (state) => {
      const index = state.episodes.findIndex(
        (item) => item.episodeNumber === value.episodeNumber,
      );
      const current = index >= 0 ? state.episodes[index] : undefined;
      const currentRevision = current?.revision ?? 0;
      assertExpectedRevision(expectedRevision, currentRevision);
      const saved: ScriptEpisode = {
        ...clone(value),
        revision: currentRevision + 1,
        createdAt: current?.createdAt ?? value.createdAt,
        updatedAt: new Date().toISOString(),
      };
      if (index >= 0) state.episodes[index] = saved;
      else state.episodes.push(saved);
      state.episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
      return saved;
    });
  }

  saveContinuity(
    projectId: string,
    value: ScriptContinuityState,
  ): Promise<ScriptContinuityState> {
    return this.mutate(projectId, (state) => {
      const saved = clone(value);
      state.continuity = saved;
      return saved;
    });
  }

  async deleteProject(projectId: string): Promise<void> {
    const previous = this.mutationQueues.get(projectId) ?? Promise.resolve();
    const run = async (): Promise<void> => {
      try {
        await unlink(this.filePath(projectId));
      } catch (error) {
        if (!(isErrno(error) && error.code === 'ENOENT')) {
          throw new StoreError(`删除短剧项目失败: ${projectId}`, { cause: error });
        }
      }
      this.states.set(projectId, undefined);
      this.loaded.add(projectId);
    };
    const queued = previous.then(run, run);
    this.mutationQueues.set(projectId, queued);
    try {
      await queued;
    } finally {
      if (this.mutationQueues.get(projectId) === queued) this.mutationQueues.delete(projectId);
    }
  }
}

/** Lazily supplies one FileScriptStore per validated browser client id. */
export function createClientScopedScriptStore(rootDirectory: string): ScriptStore {
  const root = resolve(rootDirectory);
  const stores = new Map<string, Promise<FileScriptStore>>();

  function currentStore(): Promise<FileScriptStore> {
    const clientId = getCurrentClientId();
    let store = stores.get(clientId);
    if (!store) {
      store = FileScriptStore.create(join(root, clientId));
      stores.set(clientId, store);
    }
    return store;
  }

  return new Proxy({} as ScriptStore, {
    get(_target, property) {
      if (property === 'then' || typeof property !== 'string') return undefined;
      return async (...args: unknown[]) => {
        const store = await currentStore();
        const method = Reflect.get(store, property) as unknown;
        if (typeof method !== 'function') {
          throw new TypeError(`Unknown ScriptStore method: ${property}`);
        }
        return Reflect.apply(method, store, args) as unknown;
      };
    },
  });
}
