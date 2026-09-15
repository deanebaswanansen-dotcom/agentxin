/**
 * Persistence abstraction for the Novel Writing Agent (design:
 * "Components and Interfaces > DataStore 接口").
 *
 * The domain/service layer depends only on this interface, never on a concrete
 * implementation. The file-backed implementation (`FileDataStore`, task 2.2)
 * persists to a single JSON file using an atomic write strategy and throws
 * {@link StoreError} on any read/write failure (Requirements 7.1, 7.4).
 *
 * All operations are async (returning `Promise`) so implementations may perform
 * disk or network I/O without changing the contract.
 */
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
import type { NovelWriteGuard } from './NovelWriteGuard.js';
import type { NovelChapterAcceptanceInput } from './NovelWriteGuard.js';
import type { FrozenMemoryProjection, MemorySyncClaim, MemorySyncIntent, MemorySyncTarget } from '../types/SourceMemory.js';
import type { StoryControlStorePort } from '../types/StoryControl.js';

export interface DataStore {
  // 项目（Projects）
  createProject(name: string, kind?: ProjectKind): Promise<Project>;
  listProjects(): Promise<Pick<Project, 'id' | 'name' | 'kind'>[]>;
  getProject(id: Id): Promise<Project | undefined>;
  renameProject(id: Id, name: string): Promise<Project>;
  deleteProject(id: Id): Promise<void>; // 级联删除关联实体

  // 章节（Chapters）
  createChapter(projectId: Id, title: string): Promise<Chapter>;
  listChapters(projectId: Id): Promise<Chapter[]>; // 按 position 升序
  getChapter(id: Id): Promise<Chapter | undefined>;
  updateChapterContent(id: Id, content: string, expectedRevision?: number, guard?: NovelWriteGuard): Promise<Chapter>;
  renameChapter(id: Id, title: string): Promise<Chapter>;
  reorderChapters(projectId: Id, orderedIds: Id[]): Promise<void>;
  deleteChapter(id: Id): Promise<void>;
  acceptChapter?(input: NovelChapterAcceptanceInput): Promise<Chapter>;
  listMemorySyncTargets?(): Promise<MemorySyncTarget[]>;
  getMemorySync?(projectId: string): Promise<MemorySyncIntent | undefined>;
  claimMemorySync?(projectId: string, options: { owner: string; now: string; leaseMs: number; retryFailed?: boolean }): Promise<MemorySyncClaim | undefined>;
  applyMemorySync?(projectId: string, claim: MemorySyncClaim, write: (projection: FrozenMemoryProjection) => Promise<void>): Promise<MemorySyncIntent | undefined>;
  getStoryControls?: StoryControlStorePort['getStoryControls'];
  upsertStoryControl?: StoryControlStorePort['upsertStoryControl'];
  deleteStoryControl?: StoryControlStorePort['deleteStoryControl'];

  // 结构化设定（Characters / WorldSettings / Outlines）
  createCharacter(projectId: Id, name: string, description: string): Promise<Character>;
  createWorldSetting(projectId: Id, title: string, content: string): Promise<WorldSetting>;
  createOutline(projectId: Id, title: string, content: string): Promise<Outline>;
  listCharacters(projectId: Id): Promise<Character[]>;
  listWorldSettings(projectId: Id): Promise<WorldSetting[]>;
  listOutlines(projectId: Id): Promise<Outline[]>;
  updateCharacter(
    id: Id,
    fields: Partial<Pick<Character, 'name' | 'description'>>,
  ): Promise<Character>;
  updateWorldSetting(
    id: Id,
    fields: Partial<Pick<WorldSetting, 'title' | 'content'>>,
  ): Promise<WorldSetting>;
  updateOutline(
    id: Id,
    fields: Partial<Pick<Outline, 'title' | 'content'>>,
  ): Promise<Outline>;
  deleteCharacter(id: Id): Promise<void>;
  deleteWorldSetting(id: Id): Promise<void>;
  deleteOutline(id: Id): Promise<void>;

  // 模型配置（单例配置）
  saveModelConfig(config: ModelConfig): Promise<void>;
  getModelConfig(): Promise<ModelConfig | undefined>;

  // 章节蓝图（Chapter Blueprints, 每章至多一份）
  // 按 chapter_id 替换：同一章节已存在蓝图则整体替换，确保只保留一份（需求 5.1、5.2、5.3）
  saveChapterBlueprint(blueprint: ChapterBlueprint, guard?: NovelWriteGuard): Promise<ChapterBlueprint>;
  getChapterBlueprintByChapter(chapterId: Id): Promise<ChapterBlueprint | undefined>;

  // 场景正文（Scene Drafts, 按 (chapterId, sceneId) upsert）
  // 写入仅替换目标场景正文，其余场景不受影响（需求 6.5、11.5、12.3）
  saveSceneDraft(draft: SceneDraft, guard?: NovelWriteGuard): Promise<SceneDraft>;
  getSceneDraft(chapterId: Id, sceneId: string): Promise<SceneDraft | undefined>;
  listSceneDrafts(chapterId: Id): Promise<SceneDraft[]>; // 按 scene_id 升序

  // 字数检查报告（WordCountReport, 每章至多一份）
  // 按 chapterId 替换最新一份（需求 9.4、13.1）
  saveWordCountReport(report: WordCountReport, guard?: NovelWriteGuard): Promise<WordCountReport>;
  getWordCountReportByChapter(chapterId: Id): Promise<WordCountReport | undefined>;

  // 节奏检查报告（PacingReport, 每章至多一份）
  // 按 chapterId 替换最新一份（需求 10.5、13.1）
  savePacingReport(report: PacingReport, guard?: NovelWriteGuard): Promise<PacingReport>;
  getPacingReportByChapter(chapterId: Id): Promise<PacingReport | undefined>;
}
