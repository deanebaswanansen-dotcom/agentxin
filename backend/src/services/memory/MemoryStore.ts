/**
 * MemoryStore：Agent「长期故事记忆」的独立 JSON 持久化层。
 *
 * 设计取舍：
 * - 不复用 {@link FileDataStore}（其 schema 受大量 property 测试约束，且偏「编辑器
 *   领域数据」）。Agent 记忆是另一类数据——滚动摘要 / 故事事实(bible) / 风格学习
 *   沉淀，跨章节、跨会话累积。把它单独落到一个文件，既隔离风险，又便于独立测试。
 * - 与 {@link FileDataStore} 一致地采用「临时文件 + 原子 rename」写入，避免写中途崩溃
 *   损坏文件。
 * - 全部内容按 projectId 分桶，删除项目时可整桶清理。
 * - 写路径经全局 promise 链串行化，避免并发 read-modify-write 丢更新。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StoreError } from '../../store/StoreError.js';
import type { SourceMemoryMode } from '../../types/SourceMemory.js';
import { sourceMemoryConflict, validateSourceMemoryPartition } from './sourceMemoryPartition.js';
import type { SourceMemoryPartition } from './sourceMemoryPartition.js';

/** 单条章节摘要：写完一章后由「反思子 Agent」沉淀，供后续章节回灌前情。 */
export interface ChapterSummary {
  chapterId: string;
  title: string;
  summary: string;
  at: string; // ISO 8601
}

/** 故事事实（story bible 条目）：人物状态 / 世界规则 / 已发生的关键剧情。 */
export interface MemoryFact {
  id: string;
  kind: 'character' | 'world' | 'plot';
  text: string;
  at: string;
}

/** 只跟踪可能造成正文大 Bug 的章末状态，不记录普通服装、饮食或短暂情绪。 */
export type CriticalStateKind =
  | 'alive_status'
  | 'mobility_status'
  | 'location'
  | 'physical_state'
  | 'ability_state'
  | 'critical_knowledge'
  | 'key_item'
  | 'relationship_stage';

export interface CriticalStateEntry {
  id: string;
  kind: CriticalStateKind;
  /** 人物名；key_item 时为唯一物品名。 */
  entity: string;
  /** 同一人物下的具体能力、秘密、关系对象等；无细分时使用 current。 */
  key: string;
  /** 章末规范化状态，枚举约束由 MemoryService 负责。 */
  value: string;
  /** 正文中明确支持本次状态的短证据。 */
  evidence: string;
  chapterId: string;
  chapterTitle: string;
  updatedAt: string;
}

/** 风格学习沉淀：Agent 自我进化记录（如「该作者偏好短句、多对白、忌说教」）。 */
export interface Learning {
  id: string;
  text: string;
  at: string;
}

/** 工作流事件：记录 Agent 最近做过的任务，供后续任务理解当前创作阶段。 */
export interface WorkflowEvent {
  id: string;
  task: string;
  summary: string;
  at: string;
}

/**
 * 伏笔台账条目（StoryForge 风格）：
 * planted 已埋设 → echoed 再次点到 → resolved 已回收 / dropped 作废。
 */
export type ForeshadowStatus = 'planted' | 'echoed' | 'resolved' | 'dropped';
export type ForeshadowUrgency = 'low' | 'medium' | 'high';

export interface ForeshadowEntry {
  id: string;
  /** 短标题，便于匹配与展示。 */
  title: string;
  /** 埋设内容 / 暗示点。 */
  detail: string;
  status: ForeshadowStatus;
  urgency: ForeshadowUrgency;
  /** 建议回收窗口，如「第5-8章」「中后期」。 */
  suggestPayoffBy?: string;
  plantedChapterId?: string;
  plantedChapterTitle?: string;
  /** 最近一次呼应/回收所在章。 */
  lastTouchedChapterId?: string;
  lastTouchedChapterTitle?: string;
  resolvedNote?: string;
  at: string;
  updatedAt: string;
}

/** 单个项目的全部记忆。 */
export interface ProjectMemory {
  summaries: ChapterSummary[];
  facts: MemoryFact[];
  criticalStates: CriticalStateEntry[];
  /** 被 P0 Gate 拦截、正文仍保留供人工查看但不得计入已提交章节的 ID。 */
  rejectedChapterIds: string[];
  learnings: Learning[];
  workflow: WorkflowEvent[];
  /** 伏笔台账（埋设 / 呼应 / 回收）。 */
  foreshadows: ForeshadowEntry[];
  updatedAt: string;
  /** Accepted-source projections are separate from the legacy novel memory API. */
  sourceMemory?: Partial<Record<SourceMemoryMode, SourceMemoryPartition>>;
  /** Existing unsourced items remain references in the legacy API, not accepted facts. */
  legacyUntracked?: true;
  /** Read-only tombstone marker; a deleted project cannot be recreated by a late writer. */
  deleted?: true;
}

interface MemoryFile {
  version: 2;
  projects: Record<string, ProjectMemory>;
  deletedProjects?: Record<string, string>;
}

export interface MemoryStorePort {
  read(projectId: string): ProjectMemory;
  write(projectId: string, memory: ProjectMemory): Promise<void>;
  update(
    projectId: string,
    mutator: (memory: ProjectMemory) => ProjectMemory | void,
  ): Promise<ProjectMemory>;
  clearProject(projectId: string): Promise<void>;
}

/** 默认记忆文件位置（相对后端进程 cwd），与 store.json 同目录。 */
export const DEFAULT_MEMORY_FILE = 'data/agent-memory.json';

function emptyProjectMemory(): ProjectMemory {
  return {
    summaries: [],
    facts: [],
    criticalStates: [],
    rejectedChapterIds: [],
    learnings: [],
    workflow: [],
    foreshadows: [],
    updatedAt: new Date().toISOString(),
  };
}

function emptyFile(): MemoryFile {
  return { version: 2, projects: {} };
}

export class MemoryStore implements MemoryStorePort {
  private readonly filePath: string;
  private readonly persistent: boolean;
  private data: MemoryFile = emptyFile();
  /** 全局写队列：单文件多 project，串行化 write / update / clearProject，避免落盘竞态。 */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string = DEFAULT_MEMORY_FILE, options: { persistent?: boolean } = {}) {
    this.filePath = resolve(filePath);
    this.persistent = options.persistent ?? true;
  }

  /** 构造并从磁盘加载（文件不存在视为空记忆，不抛错）。 */
  static async create(filePath: string = DEFAULT_MEMORY_FILE): Promise<MemoryStore> {
    const store = new MemoryStore(filePath);
    await store.load();
    return store;
  }

  /** 构造一个纯内存、不落盘的记忆存储（用于测试 / 无持久化注入场景）。 */
  static ephemeral(): MemoryStore {
    return new MemoryStore(DEFAULT_MEMORY_FILE, { persistent: false });
  }

  /**
   * 将写操作接到全局 promise 链尾部；前序失败不阻塞后续。
   * 所有会改 `this.data` 并可能 persist 的路径必须经此串行。
   */
  private enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(op, op);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<void> {
    if (!this.persistent) {
      this.data = emptyFile();
      return;
    }
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.data = emptyFile();
        return;
      }
      throw new StoreError('记忆文件无法读取。', { cause: error });
    }
    try {
      const parsed = JSON.parse(raw) as Omit<MemoryFile, 'version'> & { version: number };
      const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
      if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2) || !isRecord(parsed.projects) ||
          (parsed.deletedProjects !== undefined && !isRecord(parsed.deletedProjects))) throw new Error('Unsupported memory file');
      for (const [projectId, project] of Object.entries(parsed.projects)) {
        if (!isRecord(project)) throw new Error('Invalid project memory');
        for (const key of ['summaries', 'facts', 'criticalStates', 'rejectedChapterIds', 'learnings', 'workflow', 'foreshadows'] as const) {
          if (project[key] !== undefined && !Array.isArray(project[key])) throw new Error('Invalid legacy memory collection');
          if (project[key]?.length) project.legacyUntracked = true;
        }
        if (project.sourceMemory !== undefined) {
          if (!isRecord(project.sourceMemory)) throw new Error('Invalid memory partitions');
          for (const [mode, partition] of Object.entries(project.sourceMemory)) {
            if (mode !== 'short_drama' && mode !== 'novel') throw new Error('Unsupported source memory mode');
            validateSourceMemoryPartition(partition, projectId, mode);
          }
        }
      }
      for (const [projectId, at] of Object.entries(parsed.deletedProjects ?? {})) {
        if (typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || Object.hasOwn(parsed.projects, projectId)) throw new Error('Invalid project tombstone');
      }
      this.data = { ...parsed, version: 2 };
    } catch (error) {
      throw new StoreError('记忆文件损坏或版本不受支持，未重置现有数据。', { cause: error });
    }
  }

  private async persist(candidate: MemoryFile): Promise<void> {
    if (!this.persistent) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(candidate, null, 2), 'utf8');
      await rename(tempPath, this.filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  /** 读取某项目记忆的深拷贝（缺省返回空记忆，不写盘）。旧文件缺 foreshadows 时自动补空数组。 */
  read(projectId: string): ProjectMemory {
    if (Object.hasOwn(this.data.deletedProjects ?? {}, projectId)) return { ...emptyProjectMemory(), deleted: true };
    const mem = Object.hasOwn(this.data.projects, projectId) ? this.data.projects[projectId] : undefined;
    if (mem === undefined) return emptyProjectMemory();
    const copy = JSON.parse(JSON.stringify(mem)) as Partial<ProjectMemory>;
    return {
      summaries: Array.isArray(copy.summaries) ? copy.summaries : [],
      facts: Array.isArray(copy.facts) ? copy.facts : [],
      criticalStates: Array.isArray(copy.criticalStates) ? copy.criticalStates : [],
      rejectedChapterIds: Array.isArray(copy.rejectedChapterIds) ? copy.rejectedChapterIds : [],
      learnings: Array.isArray(copy.learnings) ? copy.learnings : [],
      workflow: Array.isArray(copy.workflow) ? copy.workflow : [],
      foreshadows: Array.isArray(copy.foreshadows) ? copy.foreshadows : [],
      updatedAt: typeof copy.updatedAt === 'string' ? copy.updatedAt : new Date().toISOString(),
      ...(copy.sourceMemory ? { sourceMemory: copy.sourceMemory } : {}),
      ...(copy.legacyUntracked ? { legacyUntracked: true as const } : {}),
    };
  }

  /** 覆盖写入某项目记忆并落盘（与其它写路径串行）。 */
  async write(projectId: string, memory: ProjectMemory): Promise<void> {
    const frozen = structuredClone(memory);
    return this.enqueueWrite(async () => {
      this.assertWritable(projectId);
      const candidate = { ...this.data, projects: { ...this.data.projects,
        [projectId]: { ...frozen, updatedAt: new Date().toISOString() } } };
      await this.persist(candidate);
      this.data = candidate;
    });
  }

  /**
   * Atomic read-modify-write for one project, serialized with other writes.
   * Mutator receives a deep-copy style working memory (same as read()); return the next state or mutate in place and return void.
   */
  async update(
    projectId: string,
    mutator: (memory: ProjectMemory) => ProjectMemory | void,
  ): Promise<ProjectMemory> {
    return this.enqueueWrite(async () => {
      this.assertWritable(projectId);
      const memory = this.read(projectId);
      const before = JSON.stringify(memory);
      const result = mutator(memory);
      const next = result === undefined ? memory : result;
      if (before === JSON.stringify(next)) return this.read(projectId);
      const candidate = { ...this.data, projects: { ...this.data.projects,
        [projectId]: { ...structuredClone(next), updatedAt: new Date().toISOString() } } };
      await this.persist(candidate);
      this.data = candidate;
      return this.read(projectId);
    });
  }

  /** 删除某项目的全部记忆（项目删除时调用；与其它写路径串行）。 */
  async clearProject(projectId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      if (Object.hasOwn(this.data.deletedProjects ?? {}, projectId)) return;
      const candidate = { ...this.data, projects: { ...this.data.projects },
        deletedProjects: { ...this.data.deletedProjects, [projectId]: new Date().toISOString() } };
      delete candidate.projects[projectId];
      await this.persist(candidate);
      this.data = candidate;
    });
  }

  private assertWritable(projectId: string): void {
    if (Object.hasOwn(this.data.deletedProjects ?? {}, projectId)) throw sourceMemoryConflict('SOURCE_MEMORY_DELETED');
  }
}
