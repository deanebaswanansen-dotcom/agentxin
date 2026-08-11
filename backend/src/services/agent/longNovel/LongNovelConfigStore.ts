/**
 * 长篇小说模式配置持久化（与项目 DataStore 分离，便于模式开关）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Id, LongNovelModeConfig } from '../../../types/index.js';
import { defaultLongNovelConfig } from './qualityGates.js';

interface FileShape {
  version: 1;
  byProject: Record<string, LongNovelModeConfig & { updatedAt: string }>;
}

export const DEFAULT_LONG_NOVEL_CONFIG_FILE = 'data/long-novel-configs.json';

export interface LongNovelConfigStorePort {
  get(projectId: Id): LongNovelModeConfig;
  save(projectId: Id, config: LongNovelModeConfig): Promise<LongNovelModeConfig>;
}

export class LongNovelConfigStore implements LongNovelConfigStorePort {
  private readonly filePath: string;
  private readonly persistent: boolean;
  private data: FileShape = { version: 1, byProject: {} };

  constructor(filePath: string = DEFAULT_LONG_NOVEL_CONFIG_FILE, options: { persistent?: boolean } = {}) {
    this.filePath = resolve(filePath);
    this.persistent = options.persistent ?? true;
  }

  static async create(filePath: string = DEFAULT_LONG_NOVEL_CONFIG_FILE): Promise<LongNovelConfigStore> {
    const store = new LongNovelConfigStore(filePath);
    await store.load();
    return store;
  }

  static ephemeral(): LongNovelConfigStore {
    return new LongNovelConfigStore(DEFAULT_LONG_NOVEL_CONFIG_FILE, { persistent: false });
  }

  private async load(): Promise<void> {
    if (!this.persistent) {
      this.data = { version: 1, byProject: {} };
      return;
    }
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<FileShape>;
      this.data = { version: 1, byProject: parsed.byProject ?? {} };
    } catch {
      this.data = { version: 1, byProject: {} };
    }
  }

  private async persist(): Promise<void> {
    if (!this.persistent) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  get(projectId: Id): LongNovelModeConfig {
    const existing = this.data.byProject[projectId];
    if (!existing) return defaultLongNovelConfig();
    const { updatedAt: _u, ...cfg } = existing;
    return { ...defaultLongNovelConfig(), ...cfg, enabled: true };
  }

  async save(projectId: Id, config: LongNovelModeConfig): Promise<LongNovelModeConfig> {
    const next = { ...defaultLongNovelConfig(), ...config, enabled: true, updatedAt: new Date().toISOString() };
    this.data.byProject[projectId] = next;
    await this.persist();
    const { updatedAt: _u, ...cfg } = next;
    return cfg;
  }
}
