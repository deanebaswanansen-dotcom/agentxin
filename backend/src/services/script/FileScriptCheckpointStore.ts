import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { StoreError } from '../../store/StoreError.js';
import { getCurrentClientId } from '../client/clientScope.js';
import type {
  ScriptCheckpointStore,
  ScriptPipelineCheckpoint,
} from './agents/ScriptDirector.js';

const SAFE_PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RUN_KEY_LENGTH = 256;
const RENAME_DELAYS_MS = [5, 15, 35, 75, 150, 300] as const;

interface CheckpointFile {
  schemaVersion: 1;
  projectId: string;
  runKey: string;
  checkpoints: ScriptPipelineCheckpoint[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
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

function validateScope(projectId: string, runKey: string): void {
  if (!SAFE_PROJECT_ID.test(projectId)) {
    throw new StoreError(`短剧检查点项目标识格式无效: ${projectId}`);
  }
  if (!runKey || runKey.length > MAX_RUN_KEY_LENGTH) {
    throw new StoreError('短剧检查点运行标识格式无效');
  }
}

function normalizeFile(value: unknown, projectId: string, runKey: string): CheckpointFile {
  if (typeof value !== 'object' || value === null) {
    throw new StoreError(`短剧检查点文件格式无效: ${projectId}/${runKey}`);
  }
  const input = value as Partial<CheckpointFile>;
  if (
    input.schemaVersion !== 1 ||
    input.projectId !== projectId ||
    input.runKey !== runKey ||
    !Array.isArray(input.checkpoints)
  ) {
    throw new StoreError(`短剧检查点文件与当前运行不匹配: ${projectId}/${runKey}`);
  }
  return clone(input as CheckpointFile);
}

/** A FileScriptCheckpointStore instance represents one client's checkpoint library. */
export class FileScriptCheckpointStore implements ScriptCheckpointStore {
  private readonly rootDirectory: string;
  private readonly mutationQueues = new Map<string, Promise<void>>();

  private constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory);
  }

  static async create(rootDirectory: string): Promise<FileScriptCheckpointStore> {
    await mkdir(resolve(rootDirectory), { recursive: true });
    return new FileScriptCheckpointStore(rootDirectory);
  }

  private filePath(projectId: string, runKey: string): string {
    validateScope(projectId, runKey);
    const encodedRunKey = Buffer.from(runKey, 'utf8').toString('base64url');
    return join(this.rootDirectory, projectId, `${encodedRunKey}.json`);
  }

  private async read(projectId: string, runKey: string): Promise<CheckpointFile> {
    const filePath = this.filePath(projectId, runKey);
    try {
      return normalizeFile(JSON.parse(await readFile(filePath, 'utf8')), projectId, runKey);
    } catch (error) {
      if (isErrno(error) && error.code === 'ENOENT') {
        return { schemaVersion: 1, projectId, runKey, checkpoints: [] };
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError(`读取短剧检查点失败: ${projectId}/${runKey}`, { cause: error });
    }
  }

  private async persist(value: CheckpointFile): Promise<void> {
    const filePath = this.filePath(value.projectId, value.runKey);
    const directory = join(this.rootDirectory, value.projectId);
    const tempPath = `${filePath}.tmp-${randomUUID()}`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
      await renameWithRetry(tempPath, filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw new StoreError(
        `写入短剧检查点失败: ${value.projectId}/${value.runKey}`,
        { cause: error },
      );
    }
  }

  async list(projectId: string, runKey: string): Promise<ScriptPipelineCheckpoint[]> {
    const queued = this.mutationQueues.get(`${projectId}\u0000${runKey}`);
    if (queued) await queued;
    return clone((await this.read(projectId, runKey)).checkpoints);
  }

  async save(checkpoint: ScriptPipelineCheckpoint): Promise<void> {
    const scopeKey = `${checkpoint.projectId}\u0000${checkpoint.runKey}`;
    const previous = this.mutationQueues.get(scopeKey) ?? Promise.resolve();
    const operation = previous.then(
      () => this.saveAfterPrevious(checkpoint),
      () => this.saveAfterPrevious(checkpoint),
    );
    this.mutationQueues.set(scopeKey, operation);
    try {
      await operation;
    } finally {
      if (this.mutationQueues.get(scopeKey) === operation) {
        this.mutationQueues.delete(scopeKey);
      }
    }
  }

  async deleteProject(projectId: string): Promise<void> {
    if (!SAFE_PROJECT_ID.test(projectId)) {
      throw new StoreError(`短剧检查点项目标识格式无效: ${projectId}`);
    }
    const directory = resolve(this.rootDirectory, projectId);
    const relativeDirectory = relative(this.rootDirectory, directory);
    if (
      !relativeDirectory ||
      relativeDirectory.startsWith('..') ||
      isAbsolute(relativeDirectory)
    ) {
      throw new StoreError(`短剧检查点删除路径越界: ${projectId}`);
    }
    const pending = [...this.mutationQueues.entries()]
      .filter(([scopeKey]) => scopeKey.startsWith(`${projectId}\u0000`))
      .map(([, operation]) => operation.catch(() => undefined));
    await Promise.all(pending);
    await rm(directory, { recursive: true, force: true });
  }

  private async saveAfterPrevious(checkpoint: ScriptPipelineCheckpoint): Promise<void> {
    const file = await this.read(checkpoint.projectId, checkpoint.runKey);
    const index = file.checkpoints.findIndex(
      (current) =>
        current.node === checkpoint.node &&
        current.episodeNumber === checkpoint.episodeNumber &&
        current.chunkStart === checkpoint.chunkStart,
    );
    if (index >= 0) file.checkpoints[index] = clone(checkpoint);
    else file.checkpoints.push(clone(checkpoint));
    await this.persist(file);
  }
}

/** Lazily supplies one durable checkpoint library per validated browser client id. */
export function createClientScopedScriptCheckpointStore(
  rootDirectory: string,
): ScriptCheckpointStore {
  const root = resolve(rootDirectory);
  const stores = new Map<string, Promise<FileScriptCheckpointStore>>();

  function currentStore(): Promise<FileScriptCheckpointStore> {
    const clientId = getCurrentClientId();
    let store = stores.get(clientId);
    if (!store) {
      store = FileScriptCheckpointStore.create(join(root, clientId));
      stores.set(clientId, store);
    }
    return store;
  }

  return new Proxy({} as ScriptCheckpointStore, {
    get(_target, property) {
      if (property === 'then' || typeof property !== 'string') return undefined;
      return async (...args: unknown[]) => {
        const store = await currentStore();
        const method = Reflect.get(store, property) as unknown;
        if (typeof method !== 'function') {
          throw new TypeError(`Unknown ScriptCheckpointStore method: ${property}`);
        }
        return Reflect.apply(method, store, args) as unknown;
      };
    },
  });
}
