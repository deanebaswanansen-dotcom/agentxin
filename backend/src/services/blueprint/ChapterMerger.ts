/**
 * ChapterMerger — 章节正文合并编排（design.md「ChapterMerger（场景合并为章节正文）」）。
 *
 * 该服务编排「将一章的全部场景正文合并为整章正文」的完整流程，把四件事串联：
 * 1. 加载目标章节蓝图；缺失 → 抛出 `NOT_FOUND`（需求 8.5）。
 * 2. 加载该章节全部已持久化的场景正文（需求 8.1）。
 * 3. 校验蓝图声明的每个场景都已写作（存在对应 draft）；存在缺失 →
 *    抛出 `VALIDATION_ERROR` 且不修改章节正文（需求 8.4）。
 * 4. 调用纯函数 {@link mergeScenes} 按 scene_id 升序拼接为整章正文（需求 8.2），
 *    经 {@link DataStore.updateChapterContent} 写入章节正文（需求 8.3）后返回。
 *
 * 设计要点：
 * - 领域层仅依赖抽象（{@link DataStore}），通过依赖注入传入，便于替换与测试。
 * - 纯合并逻辑（排序 + 拼接）全部委托给纯函数 {@link mergeScenes}（可属性测试），
 *   本服务只负责 IO 编排、缺失校验与「全有才写入」的事务性语义。
 * - 不调用模型：合并全程在本地完成。
 */
import type { DataStore } from '../../store/DataStore.js';
import type { Id } from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';
import { mergeScenes } from './mergeScenes.js';
import { stripReasoningArtifacts } from '../text/reasoningSanitizer.js';

export class ChapterMerger {
  /**
   * @param store 持久化抽象，用于加载章节蓝图、场景正文并写入合并后的章节正文。
   */
  constructor(private readonly store: DataStore) {}

  /**
   * 合并一章的全部场景正文为整章正文并写入章节（需求 8）。
   *
   * 步骤：
   * 1. 读取该章节蓝图；缺失 → 抛出 `NOT_FOUND`（需求 8.5）。
   * 2. 读取该章节全部已持久化的场景正文（需求 8.1）。
   * 3. 校验蓝图声明的每个 `scene_id` 都有对应 draft；存在缺失 → 抛出
   *    `VALIDATION_ERROR`，并且不修改章节正文（需求 8.4）。
   * 4. 调用纯函数 {@link mergeScenes} 按 scene_id 升序拼接（需求 8.2）。
   * 5. 写入章节正文（需求 8.3）并返回合并结果。
   *
   * 不调用模型：纯本地合并。
   *
   * @param chapterId 目标章节标识符。
   * @returns 合并后的整章正文。
   * @throws {ServiceError} `NOT_FOUND`（章节蓝图不存在，需求 8.5）。
   * @throws {ServiceError} `VALIDATION_ERROR`（存在未写作场景，需求 8.4）。
   */
  async merge(chapterId: Id): Promise<string> {
    // 1) 加载章节蓝图（合并依据：声明的场景列表）；缺失 → NOT_FOUND（需求 8.5）。
    const blueprint = await this.store.getChapterBlueprintByChapter(chapterId);
    if (!blueprint) {
      throw ServiceError.notFound(`章节蓝图不存在：${chapterId}`);
    }

    // 2) 读取该章节全部已持久化的场景正文（需求 8.1）。
    const drafts = await this.store.listSceneDrafts(chapterId);

    // 判定口径：以 sceneId 的 draft 是否存在为「已写作」标准（存在即已写作），
    // 与 content 是否为空无关。
    const draftsBySceneId = new Map<string, string>(
      drafts.map((draft) => [draft.sceneId, stripReasoningArtifacts(draft.content)]),
    );

    // 3) 校验蓝图声明的每个场景都已写作；存在缺失 → VALIDATION_ERROR，
    //    且不写入章节正文（需求 8.4）。
    const missing = blueprint.scenes
      .map((scene) => scene.scene_id)
      .filter((sceneId) => !draftsBySceneId.has(sceneId));
    if (missing.length > 0) {
      throw ServiceError.validation(
        `存在未写作场景，无法合并：${missing.join('、')}`,
      );
    }

    // 4) 按 scene_id 升序拼接为整章正文（需求 8.2）。
    const merged = mergeScenes(
      blueprint.scenes.map((scene) => ({
        scene_id: scene.scene_id,
        content: draftsBySceneId.get(scene.scene_id) ?? '',
      })),
    );

    // 5) 写入章节正文（需求 8.3）并返回合并结果。
    const cleanMerged = stripReasoningArtifacts(merged);
    await this.store.updateChapterContent(chapterId, cleanMerged);
    return cleanMerged;
  }
}
