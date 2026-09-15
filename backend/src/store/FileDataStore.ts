/**
 * File-backed implementation of the {@link DataStore} interface (design:
 * "文件实现 FileDataStore" / "数据持久化与多设备").
 *
 * Storage model
 * -------------
 * All data lives in a single JSON file whose shape is {@link FileDataStoreState}:
 * `{ projects, chapters, characters, worldSettings, outlines, modelConfig }`.
 * The committed state is held in memory after load. Each queued mutation edits
 * a private copy, persists it atomically, then publishes it to readers before
 * returning (Requirement 7.1 — writes complete before returning).
 *
 * Durability / atomicity (Requirement 7.4)
 * ----------------------------------------
 * Persistence uses a "write temp file + rename" strategy: the serialized state
 * is written to a unique temporary file in the same directory and then renamed
 * over the target path. `rename` is atomic on a single filesystem, so a crash
 * mid-write can never leave a partially written `store.json`; the previous file
 * stays intact until the new one fully replaces it. Writes are serialized
 * through an internal queue so concurrent mutations cannot interleave their
 * renames or collide on the temp file.
 *
 * Startup recovery (Requirement 7.3)
 * ----------------------------------
 * {@link FileDataStore.create} loads the JSON file when present and otherwise
 * initializes an empty structure. Re-creating a store over the same file
 * restores all previously persisted data.
 *
 * Error handling
 * --------------
 * Any read/write/rename/parse failure is wrapped in a {@link StoreError}, which
 * the transport layer maps to the `STORE_ERROR` (HTTP 500) API response.
 *
 * Scope note: the storage engine plumbing (load + atomic persist), the project
 * methods (task 2.2), the chapter methods (task 2.3) and the setting /
 * model-config methods (task 2.4) are all implemented. The in-memory state
 * container and the {@link persist} helper are written generically so each
 * mutation supplies its own logic to the copy-on-write transaction helper.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type {
  Chapter,
  ChapterBlueprint,
  Character,
  Id,
  ModelConfig,
  Outline,
  PacingReport,
  Project,
  ProjectKind,
  SceneDraft,
  WordCountReport,
  WorldSetting,
} from '../types/index.js';
import type { DataStore } from './DataStore.js';
import { ChapterRevisionConflictError } from './ChapterRevisionConflictError.js';
import { StoreError } from './StoreError.js';
import { assertNovelWriteGuard, type NovelWriteGuard, type NovelWriteSnapshot } from './NovelWriteGuard.js';
import { hashWriteBriefValue } from '../services/writing/WriteBrief.js';
import type { NovelChapterAcceptanceInput } from './NovelWriteGuard.js';
import type { FrozenMemoryProjection, MemorySyncClaim, MemorySyncIntent, MemorySyncTarget } from '../types/SourceMemory.js';
import { isValidClientId } from '../services/client/clientScope.js';
import { createNovelAcceptance, refreshNovelMemoryIntent, retractNovelSourcesFrom } from '../services/chapter/NovelSourceMemory.js';
import { ServiceError } from '../services/ServiceError.js';
import type { StoryControlCollection, StoryControlInput } from '../types/StoryControl.js';
import { assertStoryControls, deleteStoryControlRecord, emptyStoryControls, upsertStoryControlRecord } from '../services/story/StoryControls.js';

/**
 * On-disk / in-memory shape of the entire store. Arrays are always present
 * (possibly empty); `modelConfig` is optional (single-instance config that may
 * be unset). Tasks 2.3/2.4 mutate these collections directly.
 */
export interface FileDataStoreState {
  projects: Project[];
  chapters: Chapter[];
  characters: Character[];
  worldSettings: WorldSetting[];
  outlines: Outline[];
  modelConfig?: ModelConfig;
  // —— 章节蓝图模块新增集合（任务 2.2 / 2.3）——
  /** 章节蓝图，以 `chapter_id` 唯一（每章至多一份，需求 5.3）。 */
  chapterBlueprints: ChapterBlueprint[];
  /** 场景正文，以 `(chapterId, sceneId)` 唯一（需求 6.5/11.5/12.3）。 */
  sceneDrafts: SceneDraft[];
  /** 字数检查报告，以 `chapterId` 唯一（每章至多一份，需求 9.4）。 */
  wordCountReports: WordCountReport[];
  /** 节奏检查报告，以 `chapterId` 唯一（每章至多一份，需求 10.5）。 */
  pacingReports: PacingReport[];
}

/** Default data file location, relative to the backend process cwd. */
export const DEFAULT_DATA_FILE = 'data/store.json';

/** Build a fresh, empty state structure. */
function emptyState(): FileDataStoreState {
  return {
    projects: [],
    chapters: [],
    characters: [],
    worldSettings: [],
    outlines: [],
    modelConfig: undefined,
    chapterBlueprints: [],
    sceneDrafts: [],
    wordCountReports: [],
    pacingReports: [],
  };
}

export class FileDataStore implements DataStore {
  private assertGeneratedWrite(chapterId: string, guard: NovelWriteGuard, state = this.state): void {
    const chapter = state.chapters.find((item) => item.id === chapterId);
    const projectId = chapter?.projectId;
    const snapshot: NovelWriteSnapshot = {
      chapter, project: state.projects.find((item) => item.id === projectId),
      chapters: state.chapters.filter((item) => item.projectId === projectId),
      characters: state.characters.filter((item) => item.projectId === projectId),
      worldSettings: state.worldSettings.filter((item) => item.projectId === projectId),
      outlines: state.outlines.filter((item) => item.projectId === projectId),
      blueprint: state.chapterBlueprints.find((item) => item.chapter_id === chapterId),
      sceneDrafts: state.sceneDrafts.filter((item) => item.chapterId === chapterId),
    };
    assertNovelWriteGuard(snapshot, guard);
  }
  /** Absolute path to the JSON data file. */
  private readonly filePath: string;

  /** Full in-memory state; the single source of truth after load. */
  private state: FileDataStoreState;

  /**
   * Serializes validation, mutation, persistence and publication as one boundary.
   * Projection ACKs share this queue; readers see the last committed snapshot.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  /** True when an older on-disk project needs its default workspace kind persisted. */
  private needsProjectKindMigration = false;

  /** True when legacy chapters need their initial content revision persisted. */
  private needsChapterRevisionMigration = false;

  /**
   * Prefer {@link FileDataStore.create} which also loads existing data. The
   * constructor only records the path and starts from an empty state so that
   * `create` can decide whether to load from disk or initialize fresh.
   */
  constructor(filePath: string = DEFAULT_DATA_FILE, readonly storageClientId = 'local') {
    if (storageClientId !== 'local' && !isValidClientId(storageClientId)) throw new StoreError('小说客户端标识无效');
    this.filePath = resolve(filePath);
    this.state = emptyState();
  }

  /**
   * Construct a store and load persisted data from `filePath`. If the file does
   * not exist, an empty structure is initialized (Requirement 7.3). The parent
   * directory is created if needed so the first persist succeeds.
   *
   * @throws {StoreError} when the file exists but cannot be read or parsed.
   */
  static async create(
    filePath: string = DEFAULT_DATA_FILE,
    clientId = 'local',
  ): Promise<FileDataStore> {
    const store = new FileDataStore(filePath, clientId);
    await store.load();
    const needsAgentMaterialMigration = store.migrateLegacyAgentMaterials();
    let needsMemoryRepair = false;
    for (const project of store.state.projects) if (project.kind === 'novel') {
      if (project.storyControls) assertStoryControls(project.storyControls, { clientId, projectId: project.id, mode: 'novel' });
      needsMemoryRepair = refreshNovelMemoryIntent(project, store.state.chapters, clientId) || needsMemoryRepair;
    }
    if (
      store.needsProjectKindMigration ||
      store.needsChapterRevisionMigration ||
      needsAgentMaterialMigration || needsMemoryRepair
    ) {
      await store.persist();
    }
    return store;
  }

  /** One-time repair for duplicate system documents created by legacy chapter batching. */
  private migrateLegacyAgentMaterials(): boolean {
    let changed = false;
    const removeWorldIds = new Set<Id>();
    const removeOutlineIds = new Set<Id>();
    for (const project of this.state.projects) {
      const rules = this.state.worldSettings.filter(
        (item) =>
          item.projectId === project.id && item.title === '创作规则（计划采纳）',
      );
      if (rules.length > 1) {
        rules[0]!.content = rules.at(-1)!.content;
        for (const duplicate of rules.slice(1)) removeWorldIds.add(duplicate.id);
        changed = true;
      }

      const outlineGroups = [
        this.state.outlines.filter(
          (item) => item.projectId === project.id && item.title === '长篇小说模式配置',
        ),
        this.state.outlines.filter(
          (item) => item.projectId === project.id && item.title === '分章人物服装表',
        ),
        this.state.outlines.filter(
          (item) =>
            item.projectId === project.id &&
            item.title.endsWith('：分章大纲（计划采纳）'),
        ),
      ];
      for (const group of outlineGroups) {
        if (group.length <= 1) continue;
        const latest = group.at(-1)!;
        group[0]!.title = latest.title;
        group[0]!.content = latest.content;
        for (const duplicate of group.slice(1)) removeOutlineIds.add(duplicate.id);
        changed = true;
      }
    }
    if (removeWorldIds.size > 0) {
      this.state.worldSettings = this.state.worldSettings.filter(
        (item) => !removeWorldIds.has(item.id),
      );
    }
    if (removeOutlineIds.size > 0) {
      this.state.outlines = this.state.outlines.filter(
        (item) => !removeOutlineIds.has(item.id),
      );
    }
    return changed;
  }

  /**
   * Load state from disk into memory. Missing file -> empty state. Any other
   * read error or malformed JSON is wrapped in a {@link StoreError}.
   */
  private async load(): Promise<void> {
    await this.ensureDirectory();

    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isNodeErrnoException(error) && error.code === 'ENOENT') {
        // No file yet: start from a clean, empty structure.
        this.state = emptyState();
        return;
      }
      throw new StoreError(
        `读取数据文件失败：${this.filePath}`,
        { cause: error },
      );
    }

    try {
      const parsed = JSON.parse(raw) as Partial<FileDataStoreState> | null;
      this.needsProjectKindMigration = Array.isArray(parsed?.projects) &&
        parsed.projects.some((project) => project.kind !== 'novel' && project.kind !== 'short_drama');
      this.needsChapterRevisionMigration = Array.isArray(parsed?.chapters) &&
        parsed.chapters.some((chapter) => (
          !Number.isInteger(chapter.revision) || (chapter.revision ?? -1) < 0
        ));
      this.state = normalizeState(parsed);
    } catch (error) {
      throw new StoreError(
        `解析数据文件失败（JSON 格式无效）：${this.filePath}`,
        { cause: error },
      );
    }
  }

  /** Ensure the data file's parent directory exists. */
  private async ensureDirectory(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
    } catch (error) {
      throw new StoreError(
        `创建数据目录失败：${dirname(this.filePath)}`,
        { cause: error },
      );
    }
  }

  /**
   * Atomically persist a candidate state before it is published to readers.
   *
   * Strategy: serialize state -> write to a unique temp file -> `rename` over
   * the target. Callers hold the transaction queue; startup migrations finish
   * before the store is exposed.
   *
   * @throws {StoreError} when writing or renaming fails.
   */
  protected persist(candidate = this.state): Promise<void> {
    const run = async (): Promise<void> => {
      // The caller owns this candidate and has validated it inside the queue.
      const json = JSON.stringify(candidate, null, 2);
      const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(tempPath, json, 'utf8');

        // Retry the rename on transient OS file-lock races. On Windows the
        // `rename` over an existing target can intermittently throw EPERM
        // (errno -4048) — and occasionally EBUSY/EACCES/EEXIST/ENOTEMPTY —
        // when antivirus or the search indexer briefly holds a handle on the
        // freshly written temp file or the target. These are not real
        // permission problems: the handle is released within milliseconds, so
        // a short backoff-and-retry reliably succeeds. The temp file's content
        // is already on disk, so we retry only the (cheap, atomic) rename and
        // keep the same temp file across attempts. Worst-case total delay stays
        // well under a second (see RENAME_RETRY_DELAYS_MS).
        await renameWithRetry(tempPath, this.filePath);
      } catch (error) {
        // Best-effort cleanup of the orphaned temp file.
        await unlink(tempPath).catch(() => undefined);
        throw new StoreError(
          `写入数据文件失败：${this.filePath}`,
          { cause: error },
        );
      }
    };

    return run();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private mutate<T>(operation: (state: FileDataStoreState) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const working = structuredClone(this.state);
      const value = await operation(working);
      for (const project of working.projects) if (project.kind === 'novel') refreshNovelMemoryIntent(project, working.chapters, this.storageClientId);
      await this.persist(working);
      this.state = working;
      return structuredClone(value);
    });
  }

  // -------------------------------------------------------------------------
  // 项目（Projects） — fully implemented in this task (2.2)
  // -------------------------------------------------------------------------

  /**
   * Create a project with a generated UUID and ISO-8601 timestamps, persist it,
   * and return a copy (Requirement 1.1). Name validation (non-empty) is a
   * domain concern handled by the service layer (task 3.1); the store stores
   * the name as given.
   */
  async createProject(name: string, kind: ProjectKind = 'novel'): Promise<Project> {
    return this.mutate(async (state) => {
      const now = new Date().toISOString();
      const project: Project = {
        id: randomUUID(),
        name,
        kind,
        createdAt: now,
        updatedAt: now,
      };
      state.projects.push(project);
      return project;
    });
  }

  /** Return the identity, display name and workspace kind for every project. */
  async listProjects(): Promise<Pick<Project, 'id' | 'name' | 'kind'>[]> {
    return this.state.projects.map(({ id, name, kind }) => ({ id, name, kind }));
  }

  /** Return a copy of the project, or `undefined` if it does not exist. */
  async getProject(id: Id): Promise<Project | undefined> {
    const project = this.state.projects.find((p) => p.id === id);
    return project ? structuredClone(project) : undefined;
  }

  /**
   * Rename a project and bump its `updatedAt` (Requirement 1.4).
   *
   * Not-found handling: `NOT_FOUND` is a domain concern resolved by the service
   * layer (task 3.1), which checks existence via {@link getProject} before
   * calling this method. As a defensive guard against a precondition violation
   * we throw a plain `Error` (not a {@link StoreError}) so this programming
   * error is never mistaken for a storage I/O failure (which is what
   * `StoreError`/`STORE_ERROR` is reserved for).
   */
  async renameProject(id: Id, name: string): Promise<Project> {
    return this.mutate(async (state) => {
      const project = state.projects.find((p) => p.id === id);
      if (!project) {
        throw new Error(
          `renameProject 调用了不存在的项目 id：${id}（应由服务层先校验存在性）`,
        );
      }
      project.name = name;
      project.updatedAt = new Date().toISOString();
      return project;
    });
  }

  /**
   * Delete a project and cascade-delete all of its associated chapters,
   * characters, world settings and outlines, plus all blueprint-module data
   * (chapter blueprints, scene drafts, word-count and pacing reports) tied to
   * any of the project's chapters (Requirements 1.3, 13.4). Idempotent: a
   * non-existent id simply removes nothing (the service layer is responsible
   * for returning `NOT_FOUND` when appropriate).
   */
  async deleteProject(id: Id): Promise<void> {
    return this.mutate(async (state) => {
      // Compute the set of chapter ids belonging to this project BEFORE removing
      // the chapters, so the blueprint-module collections (which carry only a
      // `chapterId` foreign key, no `projectId`) can be cascade-cleared via that
      // set (Requirement 13.4).
      const chapterIds = new Set(
        state.chapters
          .filter((c) => c.projectId === id)
          .map((c) => c.id),
      );

      state.projects = state.projects.filter((p) => p.id !== id);
      state.chapters = state.chapters.filter(
        (c) => c.projectId !== id,
      );
      state.characters = state.characters.filter(
        (c) => c.projectId !== id,
      );
      state.worldSettings = state.worldSettings.filter(
        (w) => w.projectId !== id,
      );
      state.outlines = state.outlines.filter(
        (o) => o.projectId !== id,
      );

      // Cascade-delete blueprint-module data tied to any of the project's
      // chapters. These types reference the chapter only, so filter by the
      // pre-computed chapterIds set (Requirement 13.4).
      state.chapterBlueprints = state.chapterBlueprints.filter(
        (b) => !chapterIds.has(b.chapter_id),
      );
      state.sceneDrafts = state.sceneDrafts.filter(
        (d) => !chapterIds.has(d.chapterId),
      );
      state.wordCountReports = state.wordCountReports.filter(
        (r) => !chapterIds.has(r.chapterId),
      );
      state.pacingReports = state.pacingReports.filter(
        (r) => !chapterIds.has(r.chapterId),
      );
    });
  }

  // -------------------------------------------------------------------------
  // 章节（Chapters） — implemented in this task (2.3)
  // -------------------------------------------------------------------------

  /**
   * Create a chapter under a project with a generated UUID, empty content and
   * the next available `position`, persist it, and return a copy
   * (Requirement 2.1). The new chapter is appended after all existing chapters
   * of the project: its position is `max(position) + 1` across the project's
   * chapters (or `0` for the first one), which keeps list order stable and
   * collision-free even after prior reorders or deletes. Title validation
   * (non-empty) is a domain concern handled by the service layer (task 4.1);
   * the store stores the title as given.
   */
  async createChapter(projectId: Id, title: string): Promise<Chapter> {
    return this.mutate(async (state) => {
      const nextPosition = state.chapters
        .filter((c) => c.projectId === projectId)
        .reduce((max, c) => Math.max(max, c.position + 1), 0);
      const chapter: Chapter = {
        id: randomUUID(),
        projectId,
        title,
        content: '',
        position: nextPosition,
        revision: 0,
      };
      state.chapters.push(chapter);
      return chapter;
    });
  }

  /**
   * Return copies of the project's chapters sorted by `position` ascending
   * (Requirement 2.2). The interface returns full {@link Chapter} objects; the
   * transport layer projects to the id+title subset it exposes. Sorting is done
   * on a copy so the in-memory array ordering is never mutated by a read.
   */
  async listChapters(projectId: Id): Promise<Chapter[]> {
    return this.state.chapters
      .filter((c) => c.projectId === projectId)
      .sort((a, b) => a.position - b.position)
      .map((c) => structuredClone(c));
  }

  /** Return a copy of the chapter, or `undefined` if it does not exist. */
  async getChapter(id: Id): Promise<Chapter | undefined> {
    const chapter = this.state.chapters.find((c) => c.id === id);
    return chapter ? structuredClone(chapter) : undefined;
  }

  /**
   * Replace a chapter's `content` with the provided value, persist, and return
   * a copy (Requirement 2.3).
   *
   * Not-found handling: `NOT_FOUND` is a domain concern resolved by the service
   * layer (task 4.1), which checks existence via {@link getChapter} before
   * calling this method. Mirroring {@link renameProject}, a missing id is a
   * precondition violation, so we throw a plain `Error` (not a
   * {@link StoreError}) to avoid masking a programming error as a storage I/O
   * failure.
   */
  async updateChapterContent(
    id: Id,
    content: string,
    expectedRevision?: number,
    guard?: NovelWriteGuard,
  ): Promise<Chapter> {
    return this.mutate(async (state) => {
      if (guard) this.assertGeneratedWrite(id, guard, state);
      const chapter = state.chapters.find((c) => c.id === id);
      if (!chapter) {
        throw new Error(
          `updateChapterContent 调用了不存在的章节 id：${id}（应由服务层先校验存在性）`,
        );
      }
      const actualRevision = chapter.revision ?? 0;
      if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
        throw new ChapterRevisionConflictError(expectedRevision, actualRevision);
      }
      chapter.content = content;
      chapter.revision = actualRevision + 1;
      if (guard) chapter.generatedCandidate = { brief: structuredClone(guard.brief), candidateHash: hashWriteBriefValue(content), ...(guard.sceneDrafts ? { sceneDependencies: structuredClone(guard.sceneDrafts) } : {}) };
      else delete chapter.generatedCandidate;
      return chapter;
    });
  }

  /**
   * Rename a chapter's title (new UI feature for chapter management).
   * Mirrors renameProject: store throws plain Error for missing id (service layer
   * is expected to have validated existence first).
   */
  async renameChapter(id: Id, title: string): Promise<Chapter> {
    return this.mutate(async (state) => {
      const chapter = state.chapters.find((c) => c.id === id);
      if (!chapter) {
        throw new Error(
          `renameChapter 调用了不存在的章节 id：${id}（应由服务层先校验存在性）`,
        );
      }
      chapter.title = title;
      return chapter;
    });
  }

  /**
   * Reassign chapter positions so that {@link listChapters} returns the
   * project's chapters in the order given by `orderedIds` (Requirement 2.5).
   *
   * Each listed id that belongs to the project is assigned its index in
   * `orderedIds` as its new `position`. Any of the project's chapters not
   * present in `orderedIds` are appended afterwards, preserving their previous
   * relative order, so positions stay unique and collision-free. Ids in
   * `orderedIds` that are unknown or belong to another project are ignored —
   * validating the id set is a domain concern for the service layer (task 4.1).
   * Idempotent with respect to ids it does not recognize.
   */
  async reorderChapters(projectId: Id, orderedIds: Id[]): Promise<void> {
    return this.mutate(async (state) => {
      const projectChapters = state.chapters.filter(
        (c) => c.projectId === projectId,
      );

      // Index lookup for ids explicitly listed in the requested order.
      const orderIndex = new Map<Id, number>();
      orderedIds.forEach((id, index) => {
        if (!orderIndex.has(id)) {
          orderIndex.set(id, index);
        }
      });

      // Chapters not mentioned in orderedIds keep their existing relative order,
      // placed after all explicitly ordered ones.
      const trailing = projectChapters
        .filter((c) => !orderIndex.has(c.id))
        .sort((a, b) => a.position - b.position);
      const trailingIndex = new Map<Id, number>();
      trailing.forEach((c, index) => trailingIndex.set(c.id, index));

      const base = orderIndex.size;
      for (const chapter of projectChapters) {
        const explicit = orderIndex.get(chapter.id);
        chapter.position =
          explicit !== undefined
            ? explicit
            : base + (trailingIndex.get(chapter.id) ?? 0);
      }
    });
  }

  /**
   * Delete a chapter and persist (Requirement 2.4). Also cascade-deletes all
   * blueprint-module data associated with the chapter: its chapter blueprint
   * (by `chapter_id`), all scene drafts, and the word-count / pacing reports
   * (all by `chapterId`) (Requirement 13.4). Idempotent: a non-existent id
   * removes nothing (the service layer is responsible for returning
   * `NOT_FOUND` when appropriate). Only the target chapter is affected; all
   * other chapters retain their positions.
   */
  async deleteChapter(id: Id): Promise<void> {
    return this.mutate(async (state) => {
      state.chapters = state.chapters.filter((c) => c.id !== id);
      state.chapterBlueprints = state.chapterBlueprints.filter(
        (b) => b.chapter_id !== id,
      );
      state.sceneDrafts = state.sceneDrafts.filter(
        (d) => d.chapterId !== id,
      );
      state.wordCountReports = state.wordCountReports.filter(
        (r) => r.chapterId !== id,
      );
      state.pacingReports = state.pacingReports.filter(
        (r) => r.chapterId !== id,
      );
    });
  }

  // -------------------------------------------------------------------------
  // 结构化设定（Characters / WorldSettings / Outlines） — implemented in this task (2.4)
  // -------------------------------------------------------------------------

  /**
   * Create a character under a project with a generated UUID, persist it, and
   * return a copy (Requirement 3.1). Field validation (e.g. non-empty name) is
   * a domain concern handled by the service layer (task 5.1); the store stores
   * the values as given.
   */
  async createCharacter(
    projectId: Id,
    name: string,
    description: string,
  ): Promise<Character> {
    return this.mutate(async (state) => {
      const character: Character = {
        id: randomUUID(),
        projectId,
        name,
        description,
      };
      state.characters.push(character);
      return { ...character };
    });
  }

  /**
   * Create a world setting under a project with a generated UUID, persist it,
   * and return a copy (Requirement 3.2). Field validation is a domain concern
   * handled by the service layer (task 5.1).
   */
  async createWorldSetting(
    projectId: Id,
    title: string,
    content: string,
  ): Promise<WorldSetting> {
    return this.mutate(async (state) => {
      const worldSetting: WorldSetting = {
        id: randomUUID(),
        projectId,
        title,
        content,
      };
      state.worldSettings.push(worldSetting);
      return { ...worldSetting };
    });
  }

  /**
   * Create an outline entry under a project with a generated UUID and the next
   * available `position`, persist it, and return a copy (Requirement 3.3).
   * Mirroring {@link createChapter}, the new outline is appended after all
   * existing outlines of the project: its position is `max(position) + 1`
   * across the project's outlines (or `0` for the first one), keeping list
   * order stable and collision-free. Field validation is a domain concern
   * handled by the service layer (task 5.1).
   */
  async createOutline(
    projectId: Id,
    title: string,
    content: string,
  ): Promise<Outline> {
    return this.mutate(async (state) => {
      const nextPosition = state.outlines
        .filter((o) => o.projectId === projectId)
        .reduce((max, o) => Math.max(max, o.position + 1), 0);
      const outline: Outline = {
        id: randomUUID(),
        projectId,
        title,
        content,
        position: nextPosition,
      };
      state.outlines.push(outline);
      return { ...outline };
    });
  }

  /**
   * Return copies of the project's characters (Requirement 3.4). Copies are
   * returned so callers cannot mutate the in-memory state.
   */
  async listCharacters(projectId: Id): Promise<Character[]> {
    return this.state.characters
      .filter((c) => c.projectId === projectId)
      .map((c) => ({ ...c }));
  }

  /**
   * Return copies of the project's world settings (Requirement 3.4). Copies are
   * returned so callers cannot mutate the in-memory state.
   */
  async listWorldSettings(projectId: Id): Promise<WorldSetting[]> {
    return this.state.worldSettings
      .filter((w) => w.projectId === projectId)
      .map((w) => ({ ...w }));
  }

  /**
   * Return copies of the project's outlines sorted by `position` ascending
   * (Requirement 3.4). Sorting is done on copies so the in-memory array
   * ordering is never mutated by a read.
   */
  async listOutlines(projectId: Id): Promise<Outline[]> {
    return this.state.outlines
      .filter((o) => o.projectId === projectId)
      .sort((a, b) => a.position - b.position)
      .map((o) => ({ ...o }));
  }

  /**
   * Apply a partial update to a character's mutable fields (`name`,
   * `description`), persist, and return a copy (Requirement 3.5). Only keys
   * present in `fields` are changed.
   *
   * Not-found handling: `NOT_FOUND` is a domain concern resolved by the service
   * layer (task 5.1), which checks existence before calling this method.
   * Mirroring {@link renameProject}, a missing id is a precondition violation,
   * so we throw a plain `Error` (not a {@link StoreError}) to avoid masking a
   * programming error as a storage I/O failure.
   */
  async updateCharacter(
    id: Id,
    fields: Partial<Pick<Character, 'name' | 'description'>>,
  ): Promise<Character> {
    return this.mutate(async (state) => {
      const character = state.characters.find((c) => c.id === id);
      if (!character) {
        throw new Error(
          `updateCharacter 调用了不存在的人物 id：${id}（应由服务层先校验存在性）`,
        );
      }
      if (fields.name !== undefined) {
        character.name = fields.name;
      }
      if (fields.description !== undefined) {
        character.description = fields.description;
      }
      return { ...character };
    });
  }

  /**
   * Apply a partial update to a world setting's mutable fields (`title`,
   * `content`), persist, and return a copy (Requirement 3.5). Only keys present
   * in `fields` are changed. See {@link updateCharacter} for not-found handling.
   */
  async updateWorldSetting(
    id: Id,
    fields: Partial<Pick<WorldSetting, 'title' | 'content'>>,
  ): Promise<WorldSetting> {
    return this.mutate(async (state) => {
      const worldSetting = state.worldSettings.find((w) => w.id === id);
      if (!worldSetting) {
        throw new Error(
          `updateWorldSetting 调用了不存在的世界观 id：${id}（应由服务层先校验存在性）`,
        );
      }
      if (fields.title !== undefined) {
        worldSetting.title = fields.title;
      }
      if (fields.content !== undefined) {
        worldSetting.content = fields.content;
      }
      return { ...worldSetting };
    });
  }

  /**
   * Apply a partial update to an outline's mutable fields (`title`, `content`),
   * persist, and return a copy (Requirement 3.5). Only keys present in `fields`
   * are changed; `position` is managed via creation order and is not updated
   * here. See {@link updateCharacter} for not-found handling.
   */
  async updateOutline(
    id: Id,
    fields: Partial<Pick<Outline, 'title' | 'content'>>,
  ): Promise<Outline> {
    return this.mutate(async (state) => {
      const outline = state.outlines.find((o) => o.id === id);
      if (!outline) {
        throw new Error(
          `updateOutline 调用了不存在的大纲 id：${id}（应由服务层先校验存在性）`,
        );
      }
      if (fields.title !== undefined) {
        outline.title = fields.title;
      }
      if (fields.content !== undefined) {
        outline.content = fields.content;
      }
      return { ...outline };
    });
  }

  /**
   * Delete a character and persist (Requirement 3.6). Idempotent: a
   * non-existent id removes nothing (the service layer is responsible for
   * returning `NOT_FOUND` when appropriate).
   */
  async deleteCharacter(id: Id): Promise<void> {
    return this.mutate(async (state) => {
      state.characters = state.characters.filter((c) => c.id !== id);
    });
  }

  /**
   * Delete a world setting and persist (Requirement 3.6). Idempotent: a
   * non-existent id removes nothing.
   */
  async deleteWorldSetting(id: Id): Promise<void> {
    return this.mutate(async (state) => {
      state.worldSettings = state.worldSettings.filter(
        (w) => w.id !== id,
      );
    });
  }

  /**
   * Delete an outline and persist (Requirement 3.6). Idempotent: a non-existent
   * id removes nothing. Only the target outline is affected; all other outlines
   * retain their positions.
   */
  async deleteOutline(id: Id): Promise<void> {
    return this.mutate(async (state) => {
      state.outlines = state.outlines.filter((o) => o.id !== id);
    });
  }

  // -------------------------------------------------------------------------
  // 模型配置（单例配置） — implemented in this task (2.4)
  // -------------------------------------------------------------------------

  /**
   * Persist the single-instance model configuration, overwriting any existing
   * one (Requirements 4.1, 4.3). A defensive copy is stored so later mutations
   * of the caller's object cannot alter persisted state. Field validation
   * (non-empty baseUrl/apiKey/modelName) is a domain concern handled by the
   * service layer (task 6.1); the store persists the values as given.
   */
  async saveModelConfig(config: ModelConfig): Promise<void> {
    return this.mutate(async (state) => {
      state.modelConfig = { ...config };
    });
  }

  /**
   * Return a copy of the stored model configuration, or `undefined` if none has
   * been saved (Requirement 4.3). A copy is returned so callers cannot mutate
   * the in-memory state.
   */
  async getModelConfig(): Promise<ModelConfig | undefined> {
    return this.state.modelConfig ? { ...this.state.modelConfig } : undefined;
  }

  // -------------------------------------------------------------------------
  // 章节蓝图 / 场景正文（Chapter Blueprints / Scene Drafts） — task 2.2
  // -------------------------------------------------------------------------

  /**
   * Persist a chapter blueprint, keeping at most one per chapter
   * (Requirements 5.1, 5.3). Any existing blueprint for the same
   * `chapter_id` is removed before the new one is appended, so a re-generation
   * replaces the prior blueprint entirely. Scene drafts for that chapter are
   * deleted in the same mutation — a replaced blueprint invalidates prior
   * scene text — then the store is persisted once. Drafts of other chapters
   * are left untouched. A deep copy is stored so later mutations of the
   * caller's object (including its nested `scenes` array) cannot alter
   * persisted state; a deep copy is also returned so callers cannot mutate
   * the in-memory state.
   */
  async saveChapterBlueprint(
    blueprint: ChapterBlueprint,
    guard?: NovelWriteGuard,
  ): Promise<ChapterBlueprint> {
    return this.mutate(async (state) => {
      if (guard) this.assertGeneratedWrite(blueprint.chapter_id, guard, state);
      state.chapterBlueprints = state.chapterBlueprints.filter(
        (b) => b.chapter_id !== blueprint.chapter_id,
      );
      const stored = structuredClone(blueprint);
      state.chapterBlueprints.push(stored);
      state.sceneDrafts = state.sceneDrafts.filter(
        (d) => d.chapterId !== blueprint.chapter_id,
      );
      return structuredClone(stored);
    });
  }

  /**
   * Return a deep copy of the chapter's blueprint, or `undefined` if none has
   * been persisted (Requirements 5.2, 5.6). A deep copy is returned so callers
   * cannot mutate the in-memory state via the nested `scenes` array.
   */
  async getChapterBlueprintByChapter(
    chapterId: Id,
  ): Promise<ChapterBlueprint | undefined> {
    const blueprint = this.state.chapterBlueprints.find(
      (b) => b.chapter_id === chapterId,
    );
    return blueprint ? structuredClone(blueprint) : undefined;
  }

  /**
   * Upsert a scene draft keyed by `(chapterId, sceneId)` (Requirements 6.5,
   * 11.5, 12.3). If a draft already exists for the pair it is replaced in
   * place; otherwise the new draft is appended. Writing one scene never
   * affects other scenes' drafts. A deep copy is stored and returned so
   * callers cannot mutate the in-memory state.
   */
  async saveSceneDraft(draft: SceneDraft, guard?: NovelWriteGuard): Promise<SceneDraft> {
    return this.mutate(async (state) => {
      if (guard) this.assertGeneratedWrite(draft.chapterId, guard, state);
      const stored = structuredClone(draft);
      const index = state.sceneDrafts.findIndex(
        (d) => d.chapterId === draft.chapterId && d.sceneId === draft.sceneId,
      );
      if (index >= 0) {
        state.sceneDrafts[index] = stored;
      } else {
        state.sceneDrafts.push(stored);
      }
      return structuredClone(stored);
    });
  }

  /**
   * Return a deep copy of the scene draft for `(chapterId, sceneId)`, or
   * `undefined` if none exists.
   */
  async getSceneDraft(
    chapterId: Id,
    sceneId: string,
  ): Promise<SceneDraft | undefined> {
    const draft = this.state.sceneDrafts.find(
      (d) => d.chapterId === chapterId && d.sceneId === sceneId,
    );
    return draft ? structuredClone(draft) : undefined;
  }

  /**
   * Return deep copies of all scene drafts for a chapter, sorted by `sceneId`
   * ascending using the same numeric-aware ordering as `mergeScenes`
   * (`localeCompare(b, 'en', { numeric: true })`), so e.g. `scene-2` precedes
   * `scene-10`. Sorting is done on copies so the in-memory array ordering is
   * never mutated by a read.
   */
  async listSceneDrafts(chapterId: Id): Promise<SceneDraft[]> {
    return this.state.sceneDrafts
      .filter((d) => d.chapterId === chapterId)
      .sort((a, b) =>
        a.sceneId.localeCompare(b.sceneId, 'en', { numeric: true }),
      )
      .map((d) => structuredClone(d));
  }

  // -------------------------------------------------------------------------
  // 检查报告（Word-count / Pacing reports） — task 2.3
  // -------------------------------------------------------------------------

  /**
   * Persist a word-count report, keeping at most one per chapter
   * (Requirements 9.4, 13.1). Any existing report for the same `chapterId` is
   * removed before the new one is appended, so a re-check replaces the prior
   * report. A deep copy is stored and returned so callers cannot mutate the
   * in-memory state via the nested `scenes` array.
   */
  async saveWordCountReport(
    report: WordCountReport,
    guard?: NovelWriteGuard,
  ): Promise<WordCountReport> {
    return this.mutate(async (state) => {
      if (guard) this.assertGeneratedWrite(report.chapterId, guard, state);
      state.wordCountReports = state.wordCountReports.filter(
        (r) => r.chapterId !== report.chapterId,
      );
      const stored = structuredClone(report);
      state.wordCountReports.push(stored);
      return structuredClone(stored);
    });
  }

  /**
   * Return a deep copy of the chapter's latest word-count report, or
   * `undefined` if none has been persisted (Requirements 13.3, 13.5).
   */
  async getWordCountReportByChapter(
    chapterId: Id,
  ): Promise<WordCountReport | undefined> {
    const report = this.state.wordCountReports.find(
      (r) => r.chapterId === chapterId,
    );
    return report ? structuredClone(report) : undefined;
  }

  /**
   * Persist a pacing report, keeping at most one per chapter (Requirements
   * 10.5, 13.1). Any existing report for the same `chapterId` is removed before
   * the new one is appended, so a re-check replaces the prior report. A deep
   * copy is stored and returned so callers cannot mutate the in-memory state
   * via the nested arrays.
   */
  async savePacingReport(report: PacingReport, guard?: NovelWriteGuard): Promise<PacingReport> {
    return this.mutate(async (state) => {
      if (guard) this.assertGeneratedWrite(report.chapterId, guard, state);
      state.pacingReports = state.pacingReports.filter(
        (r) => r.chapterId !== report.chapterId,
      );
      const stored = structuredClone(report);
      state.pacingReports.push(stored);
      return structuredClone(stored);
    });
  }

  /**
   * Return a deep copy of the chapter's latest pacing report, or `undefined`
   * if none has been persisted (Requirements 13.3, 13.5).
   */
  async getPacingReportByChapter(
    chapterId: Id,
  ): Promise<PacingReport | undefined> {
    const report = this.state.pacingReports.find(
      (r) => r.chapterId === chapterId,
    );
    return report ? structuredClone(report) : undefined;
  }

  async acceptChapter(input: NovelChapterAcceptanceInput): Promise<Chapter> {
    return this.mutate(async (state) => {
      const chapter = state.chapters.find((item) => item.id === input.chapterId);
      const project = state.projects.find((item) => item.id === chapter?.projectId);
      if (!chapter || !project) throw ServiceError.notFound('待接受章节或项目不存在。');
      if (project.kind !== 'novel') throw ServiceError.validation('该接受入口仅适用于小说正文。');
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw ServiceError.validation('缺少有效正文版本。');
      if (input.guard) this.assertGeneratedWrite(chapter.id, input.guard, state);
      if ((chapter.revision ?? 0) !== input.expectedRevision) throw new ChapterRevisionConflictError(input.expectedRevision, chapter.revision ?? 0);
      const content = input.content ?? chapter.content;
      if (!content.trim()) throw ServiceError.validation('空白正文不能接受为来源。');
      if (input.contentHash !== hashWriteBriefValue(content)) throw ServiceError.conflict('接受正文哈希已变化，请重新查看正文。');
      if (input.content !== undefined) {
        if (!input.guard) throw ServiceError.validation('生成正文采用缺少写作来源守卫。');
        chapter.content = content;
        chapter.revision = (chapter.revision ?? 0) + 1;
        chapter.generatedCandidate = { brief: structuredClone(input.guard.brief), candidateHash: input.contentHash,
          ...(input.guard.sceneDrafts ? { sceneDependencies: structuredClone(input.guard.sceneDrafts) } : {}) };
      } else if (chapter.acceptance?.status === 'current' && chapter.acceptance.revision === chapter.revision &&
          chapter.acceptance.contentHash === input.contentHash) return chapter;
      const records = project.novelAcceptances ??= [];
      for (const previous of records) if (previous.memoryInput.source.resourceId === chapter.id) previous.status = 'stale';
      const acceptance = createNovelAcceptance(this.storageClientId, chapter, state.chapters, input.entries);
      records.push(acceptance);
      chapter.acceptance = { id: acceptance.id, status: 'current', revision: chapter.revision ?? 0, contentHash: input.contentHash,
        acceptedAt: acceptance.memoryInput.acceptedAt, unitNumber: acceptance.memoryInput.source.unitNumber };
      return chapter;
    });
  }

  async listMemorySyncTargets(): Promise<MemorySyncTarget[]> {
    return this.state.projects.filter((project) => project.kind === 'novel').map((project) => ({ clientId: this.storageClientId, projectId: project.id }));
  }

  async getMemorySync(projectId: string): Promise<MemorySyncIntent | undefined> {
    const intent = this.state.projects.find((project) => project.id === projectId)?.memorySync;
    return intent ? structuredClone(intent) : undefined;
  }

  claimMemorySync(projectId: string, options: { owner: string; now: string; leaseMs: number; retryFailed?: boolean }): Promise<MemorySyncClaim | undefined> {
    const now = Date.parse(options.now);
    if (!options.owner.trim() || !Number.isFinite(now) || !Number.isFinite(options.leaseMs) || options.leaseMs <= 0 ||
        !Number.isFinite(new Date(now + options.leaseMs).getTime())) return Promise.reject(ServiceError.validation('记忆同步租约无效。'));
    return this.enqueue(async () => {
      const working = structuredClone(this.state);
      const intent = working.projects.find((project) => project.id === projectId)?.memorySync;
      if (!intent || !(intent.status === 'pending' || (intent.status === 'failed' && options.retryFailed) ||
          (intent.status === 'running' && (!intent.lease || !Number.isFinite(Date.parse(intent.lease.expiresAt)) || Date.parse(intent.lease.expiresAt) <= now)))) return undefined;
      intent.status = 'running'; intent.attempts += 1; intent.updatedAt = new Date(now).toISOString();
      intent.lease = { token: randomUUID(), owner: options.owner, expiresAt: new Date(now + options.leaseMs).toISOString() };
      delete intent.error;
      await this.persist(working); this.state = working;
      return { clientId: this.storageClientId, projectId, revision: intent.projection.revision,
        idempotencyKey: intent.projection.idempotencyKey, lease: structuredClone(intent.lease) };
    });
  }

  applyMemorySync(projectId: string, claim: MemorySyncClaim, write: (projection: FrozenMemoryProjection) => Promise<void>): Promise<MemorySyncIntent | undefined> {
    return this.enqueue(async () => {
      const working = structuredClone(this.state);
      const intent = working.projects.find((project) => project.id === projectId)?.memorySync;
      if (!intent || intent.status !== 'running' || !intent.lease || claim.clientId !== this.storageClientId || claim.projectId !== projectId ||
          claim.revision !== intent.projection.revision || claim.idempotencyKey !== intent.projection.idempotencyKey ||
          claim.lease.token !== intent.lease.token || claim.lease.owner !== intent.lease.owner || claim.lease.expiresAt !== intent.lease.expiresAt ||
          !Number.isFinite(Date.parse(intent.lease.expiresAt)) || Date.parse(intent.lease.expiresAt) <= Date.now()) return undefined;
      try { await write(structuredClone(intent.projection)); intent.status = 'succeeded'; delete intent.error; }
      catch { intent.status = 'failed'; intent.error = { code: 'SOURCE_MEMORY_SYNC_FAILED', message: '记忆同步失败，已接受正文保留，可重试同步。' }; }
      delete intent.lease; intent.updatedAt = new Date().toISOString();
      await this.persist(working); this.state = working;
      return structuredClone(intent);
    });
  }

  async getStoryControls(projectId: string): Promise<StoryControlCollection> {
    const project = this.state.projects.find((item) => item.id === projectId);
    if (!project) throw ServiceError.notFound('项目不存在。');
    return structuredClone(project.storyControls ?? emptyStoryControls());
  }

  upsertStoryControl(projectId: string, input: StoryControlInput, expectedRevision: number): Promise<StoryControlCollection> {
    return this.mutate(async (state) => {
      const project = state.projects.find((item) => item.id === projectId);
      if (!project || project.kind !== 'novel') throw ServiceError.notFound('小说项目不存在。');
      const result = upsertStoryControlRecord(project.storyControls ?? emptyStoryControls(), input, expectedRevision, {
        clientId: this.storageClientId, projectId, mode: 'novel', activeAcceptances: (project.novelAcceptances ?? []).filter((item) => item.status === 'current').map((item) => item.memoryInput),
      });
      project.storyControls = result.collection;
      if (result.retractFromUnit !== undefined) retractNovelSourcesFrom(project, result.retractFromUnit);
      return result.collection;
    });
  }

  deleteStoryControl(projectId: string, id: string, expectedRevision: number): Promise<StoryControlCollection> {
    return this.mutate(async (state) => {
      const project = state.projects.find((item) => item.id === projectId);
      if (!project || project.kind !== 'novel') throw ServiceError.notFound('小说项目不存在。');
      project.storyControls = deleteStoryControlRecord(project.storyControls ?? emptyStoryControls(), id, expectedRevision);
      return project.storyControls;
    });
  }
}

/** Narrow an unknown caught value to a Node `errno` exception. */
function isNodeErrnoException(
  value: unknown,
): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

/**
 * Transient filesystem error codes that warrant a retry rather than a hard
 * failure. On Windows a `rename` over an existing file can briefly fail while
 * another process (antivirus, the search indexer, a backup agent) holds a
 * transient handle on the source or destination — the handle is released
 * within milliseconds, so retrying succeeds. None of these indicate a genuine,
 * persistent storage problem in our single-writer, same-directory rename.
 */
const TRANSIENT_FS_ERROR_CODES: ReadonlySet<string> = new Set([
  'EPERM',
  'EACCES',
  'EBUSY',
  'EEXIST',
  'ENOTEMPTY',
]);

/**
 * Backoff schedule (in ms) applied between rename attempts. The first entry is
 * the wait after the initial attempt fails, and so on. Length implies the retry
 * count (here: 6 retries after the first try = 7 total attempts). The values
 * ramp gently and sum to ~315ms worst case — comfortably under a second.
 */
const RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 60, 85, 100];

/** Decide whether a caught error is a transient FS lock race worth retrying. */
function isTransientFsError(error: unknown): boolean {
  return (
    isNodeErrnoException(error) &&
    typeof error.code === 'string' &&
    TRANSIENT_FS_ERROR_CODES.has(error.code)
  );
}

/** Promise-based sleep helper (no external dependencies). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Rename `tempPath` over `targetPath`, retrying transient OS file-lock races
 * (see {@link TRANSIENT_FS_ERROR_CODES}) with a short backoff
 * ({@link RENAME_RETRY_DELAYS_MS}). Non-transient errors are thrown
 * immediately. If every retry is exhausted, the last error is rethrown so the
 * caller can clean up the temp file and surface a {@link StoreError}.
 */
async function renameWithRetry(
  tempPath: string,
  targetPath: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempPath, targetPath);
      return;
    } catch (error) {
      const canRetry =
        attempt < RENAME_RETRY_DELAYS_MS.length && isTransientFsError(error);
      if (!canRetry) {
        // Either a non-transient error or retries exhausted: give up and let
        // the caller wrap it in a StoreError after cleaning up the temp file.
        throw error;
      }
      await sleep(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Coerce a parsed JSON value into a well-formed {@link FileDataStoreState},
 * defaulting any missing collection to an empty array. This keeps load robust
 * to partially written or older files while preserving present data.
 */
function normalizeState(
  parsed: Partial<FileDataStoreState> | null,
): FileDataStoreState {
  const base = emptyState();
  if (!parsed || typeof parsed !== 'object') {
    return base;
  }
  return {
    projects: Array.isArray(parsed.projects)
      ? parsed.projects.map((project) => ({
          ...project,
          kind: project.kind === 'short_drama' ? 'short_drama' : 'novel',
        }))
      : base.projects,
    chapters: Array.isArray(parsed.chapters)
      ? parsed.chapters.map((chapter) => ({
          ...chapter,
          revision: Number.isInteger(chapter.revision) && (chapter.revision ?? -1) >= 0
            ? chapter.revision
            : 0,
        }))
      : base.chapters,
    characters: Array.isArray(parsed.characters)
      ? parsed.characters
      : base.characters,
    worldSettings: Array.isArray(parsed.worldSettings)
      ? parsed.worldSettings
      : base.worldSettings,
    outlines: Array.isArray(parsed.outlines) ? parsed.outlines : base.outlines,
    modelConfig: parsed.modelConfig,
    chapterBlueprints: Array.isArray(parsed.chapterBlueprints)
      ? parsed.chapterBlueprints
      : base.chapterBlueprints,
    sceneDrafts: Array.isArray(parsed.sceneDrafts)
      ? parsed.sceneDrafts
      : base.sceneDrafts,
    wordCountReports: Array.isArray(parsed.wordCountReports)
      ? parsed.wordCountReports
      : base.wordCountReports,
    pacingReports: Array.isArray(parsed.pacingReports)
      ? parsed.pacingReports
      : base.pacingReports,
  };
}
