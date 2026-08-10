/**
 * 参考小说独立持久化（与原创项目 DataStore 分离）。
 * 原文只存此处，默认不进入正文生成上下文。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  Id,
  ReferenceAnalysisDepth,
  ReferenceAnalysisStatus,
  ReferenceChapterRecord,
  ReferenceCreativeProfile,
  ReferenceTransferDimension,
} from '../../types/index.js';

export interface StoredReferenceNovel {
  id: Id;
  title: string;
  author?: string;
  depth: ReferenceAnalysisDepth;
  status: ReferenceAnalysisStatus;
  isCompleteWork?: boolean;
  chapters: ReferenceChapterRecord[];
  profile?: ReferenceCreativeProfile;
  /** 分析结果写入的左侧资料项目；再次分析时复用。 */
  analysisProjectId?: Id;
  /** 参考章节 id → 拆解项目章节 id；用于重复分析时原位更新而不重复创建。 */
  analysisChapterMap?: Record<Id, Id>;
  /** 为省空间可清空章节 content，只保留档案。 */
  rawPurged?: boolean;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectReferenceConfig {
  projectId: Id;
  referenceId: Id;
  dimensions: ReferenceTransferDimension[];
  planMarkdown: string;
  appliedAt: string;
}

interface ReferenceFile {
  version: 1;
  novels: Record<string, StoredReferenceNovel>;
  projectConfigs: Record<string, ProjectReferenceConfig>;
}

export const DEFAULT_REFERENCE_FILE = 'data/reference-novels.json';

function emptyFile(): ReferenceFile {
  return { version: 1, novels: {}, projectConfigs: {} };
}

export class ReferenceStore {
  private readonly filePath: string;
  private readonly persistent: boolean;
  private data: ReferenceFile = emptyFile();

  constructor(filePath: string = DEFAULT_REFERENCE_FILE, options: { persistent?: boolean } = {}) {
    this.filePath = resolve(filePath);
    this.persistent = options.persistent ?? true;
  }

  static async create(filePath: string = DEFAULT_REFERENCE_FILE): Promise<ReferenceStore> {
    const store = new ReferenceStore(filePath);
    await store.load();
    return store;
  }

  static ephemeral(): ReferenceStore {
    return new ReferenceStore(DEFAULT_REFERENCE_FILE, { persistent: false });
  }

  private async load(): Promise<void> {
    if (!this.persistent) {
      this.data = emptyFile();
      return;
    }
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ReferenceFile>;
      this.data = {
        version: 1,
        novels: parsed.novels ?? {},
        projectConfigs: parsed.projectConfigs ?? {},
      };
    } catch {
      this.data = emptyFile();
    }
  }

  private async persist(): Promise<void> {
    if (!this.persistent) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(tempPath, this.filePath);
  }

  listNovels(): StoredReferenceNovel[] {
    return Object.values(this.data.novels).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getNovel(id: Id): StoredReferenceNovel | undefined {
    const n = this.data.novels[id];
    return n ? (JSON.parse(JSON.stringify(n)) as StoredReferenceNovel) : undefined;
  }

  async saveNovel(novel: StoredReferenceNovel): Promise<void> {
    this.data.novels[novel.id] = {
      ...novel,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
  }

  async deleteNovel(id: Id): Promise<boolean> {
    if (!this.data.novels[id]) return false;
    delete this.data.novels[id];
    for (const [pid, cfg] of Object.entries(this.data.projectConfigs)) {
      if (cfg.referenceId === id) delete this.data.projectConfigs[pid];
    }
    await this.persist();
    return true;
  }

  getProjectConfig(projectId: Id): ProjectReferenceConfig | undefined {
    const c = this.data.projectConfigs[projectId];
    return c ? (JSON.parse(JSON.stringify(c)) as ProjectReferenceConfig) : undefined;
  }

  async saveProjectConfig(config: ProjectReferenceConfig): Promise<void> {
    this.data.projectConfigs[config.projectId] = config;
    await this.persist();
  }

  async clearProjectConfig(projectId: Id): Promise<void> {
    if (!this.data.projectConfigs[projectId]) return;
    delete this.data.projectConfigs[projectId];
    await this.persist();
  }
}
