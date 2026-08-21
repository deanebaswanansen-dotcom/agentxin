/**
 * ChapterService — 章节领域逻辑（design: "Services 领域层 > ChapterService"）。
 *
 * 该服务承载章节相关的业务规则，并将持久化委托给注入的 {@link DataStore}：
 * - 创建章节时校验标题非空（仅空白视为空）→ 否则抛出 `VALIDATION_ERROR`
 *   （Requirement 2.1）。
 * - 列出章节（已由存储层按 `position` 升序返回）（Requirement 2.2）。
 * - 更新正文（Requirement 2.3）、删除章节（Requirement 2.4）、章节排序
 *   （Requirement 2.5）。
 * - 对不存在的章节标识符执行更新/删除时返回 `NOT_FOUND`（Requirement 2.6）。
 *
 * 设计要点：领域层仅依赖 {@link DataStore} 接口（依赖注入），不感知具体存储实现，
 * 便于替换与测试。所有 not-found 与校验失败统一以 {@link ServiceError} 抛出，
 * 由传输层映射为统一 {@link import('../../types/index.js').ApiError} 响应。
 *
 * 注意：存储层的变更方法（updateChapterContent / reorderChapters 等）将
 * "标识符不存在" 视为服务层应先行校验的前置条件违例；因此本服务在调用这些方法
 * 前会通过 {@link DataStore.getChapter} / {@link DataStore.getProject} 校验存在性，
 * 并在缺失时抛出 `NOT_FOUND`，避免触达存储层的前置条件守卫。
 */
import type { DataStore } from '../../store/DataStore.js';
import { ChapterRevisionConflictError } from '../../store/ChapterRevisionConflictError.js';
import type { Chapter, Id } from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';

export interface ChapterServiceOptions {
  afterRemove?: (chapter: Chapter) => Promise<void>;
}

export class ChapterService {
  /**
   * @param store 持久化抽象。通过依赖注入传入，使领域逻辑与具体存储实现解耦。
   */
  constructor(
    private readonly store: DataStore,
    private readonly options: ChapterServiceOptions = {},
  ) {}

  /**
   * 在某项目下创建章节（Requirement 2.1）。
   *
   * 校验顺序：
   * 1. 标题非空（trim 后为空或纯空白视为空）→ 否则 `VALIDATION_ERROR`。
   * 2. 目标项目存在 → 否则 `NOT_FOUND`（Requirement 2.6，避免在不存在的项目下创建孤立章节）。
   *
   * 返回新建章节（含其唯一标识符）。标题按原样（未 trim）存储，仅以是否纯空白做校验。
   */
  async create(projectId: Id, title: string): Promise<Chapter> {
    if (title.trim().length === 0) {
      throw ServiceError.validation('章节标题不能为空。');
    }

    const project = await this.store.getProject(projectId);
    if (!project) {
      throw ServiceError.notFound(`项目不存在：${projectId}`);
    }

    return this.store.createChapter(projectId, title);
  }

  /**
   * 返回某项目的章节列表，按 `position` 升序（Requirement 2.2）。
   * 排序由存储层保证；此处直接透传。
   */
  async list(projectId: Id): Promise<Chapter[]> {
    return this.store.listChapters(projectId);
  }

  /**
   * 更新某章节的正文内容并持久化（Requirement 2.3）。
   * 章节不存在时返回 `NOT_FOUND`（Requirement 2.6）。
   */
  async updateContent(id: Id, content: string, expectedRevision?: number): Promise<Chapter> {
    await this.ensureChapterExists(id);
    try {
      return await this.store.updateChapterContent(id, content, expectedRevision);
    } catch (error) {
      if (error instanceof ChapterRevisionConflictError) {
        throw ServiceError.conflict(
          '章节已在别处更新，请重新打开章节后再保存；当前未保存正文仍保留在编辑器中。',
        );
      }
      throw error;
    }
  }

  /**
   * 重命名章节标题（UI 章节管理新增）。
   * 先校验存在，再调用 store。
   */
  async rename(id: Id, title: string): Promise<Chapter> {
    if (title.trim().length === 0) {
      throw ServiceError.validation('章节标题不能为空。');
    }
    await this.ensureChapterExists(id);
    return this.store.renameChapter(id, title);
  }

  /**
   * 删除某章节（Requirement 2.4）。
   * 章节不存在时返回 `NOT_FOUND`（Requirement 2.6）。
   */
  async remove(id: Id): Promise<void> {
    const chapter = await this.store.getChapter(id);
    if (!chapter) {
      throw ServiceError.notFound(`章节不存在：${id}`);
    }
    await this.store.deleteChapter(id);
    await this.options.afterRemove?.(chapter);
  }

  /**
   * 按提供的标识符顺序更新某项目章节的排序位置（Requirement 2.5）。
   * 目标项目不存在时返回 `NOT_FOUND`（Requirement 2.6）。
   *
   * 对 `orderedIds` 中未知或属于其他项目的标识符的处理由存储层负责（忽略），
   * 本服务仅校验项目自身存在性。
   */
  async reorder(projectId: Id, orderedIds: Id[]): Promise<void> {
    const project = await this.store.getProject(projectId);
    if (!project) {
      throw ServiceError.notFound(`项目不存在：${projectId}`);
    }
    await this.store.reorderChapters(projectId, orderedIds);
  }

  /**
   * 校验章节存在，缺失则抛出 `NOT_FOUND`。集中处理 not-found，确保在调用存储层
   * 变更方法（其将缺失视为前置条件违例）之前完成存在性校验。
   */
  private async ensureChapterExists(id: Id): Promise<void> {
    const chapter = await this.store.getChapter(id);
    if (!chapter) {
      throw ServiceError.notFound(`章节不存在：${id}`);
    }
  }
}
