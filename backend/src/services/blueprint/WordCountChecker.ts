/**
 * WordCountChecker — 字数检查编排（design: "Services 领域层 > WordCountService（字数检查，无模型调用）"）。
 *
 * 该服务编排一次章节字数检查的完整流程，将三件事串联：
 * 1. 加载目标章节蓝图；缺失 → 抛出 `NOT_FOUND`。
 * 2. 加载该章节全部场景正文，构建 `scene_id → 正文` 映射，调用纯函数
 *    {@link buildWordCountReport} 计算场景级与整章级统计（需求 9.1–9.3）。
 * 3. 注入元数据（`chapterId` / `generatedAt`）拼成完整 {@link WordCountReport}，
 *    经 {@link DataStore.saveWordCountReport} upsert 持久化后返回（需求 9.4）。
 *
 * 设计要点：
 * - 领域层仅依赖抽象（{@link DataStore}），通过依赖注入传入，便于替换与测试。
 * - 纯统计、不调用模型：字数检查全程在本地完成，无需 `MODEL_NOT_CONFIGURED` 检查，
 *   也绝不触达任何模型提供商。
 * - 字数计算逻辑全部委托给纯函数 {@link buildWordCountReport}（可属性测试），本服务
 *   只负责 IO 编排与元数据注入。
 */
import type { DataStore } from '../../store/DataStore.js';
import type { Id, WordCountReport } from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';
import { buildWordCountReport } from './wordCount.js';

export class WordCountChecker {
  /**
   * @param store 持久化抽象，用于加载章节蓝图、场景正文并持久化字数检查报告。
   */
  constructor(private readonly store: DataStore) {}

  /**
   * 执行一次字数检查并返回（同时持久化）报告（需求 9, 9.4）。
   *
   * 步骤：
   * 1. 读取该章节蓝图；缺失 → 抛出 `NOT_FOUND`（需求 9 前置条件）。
   * 2. 读取该章节全部场景正文，构建 `sceneId → content` 映射。
   * 3. 调用纯函数 {@link buildWordCountReport} 计算报告主体（场景级 + 整章级，
   *    需求 9.1–9.3）。
   * 4. 注入元数据（`chapterId`、`generatedAt`）拼成完整 {@link WordCountReport}。
   * 5. upsert 持久化报告（每章至多一份，需求 9.4），并返回该报告。
   *
   * 不调用模型：纯本地统计。
   *
   * @param chapterId 目标章节标识符。
   * @returns 完整的字数检查报告。
   * @throws {ServiceError} `NOT_FOUND`（章节蓝图不存在）。
   */
  async check(chapterId: Id): Promise<WordCountReport> {
    // 1) 加载章节蓝图（统计依据：场景列表与目标字数）；缺失 → NOT_FOUND。
    const blueprint = await this.store.getChapterBlueprintByChapter(chapterId);
    if (!blueprint) {
      throw ServiceError.notFound(`章节蓝图不存在：${chapterId}`);
    }

    // 2) 读取全部场景正文并构建 sceneId → content 映射。
    const drafts = await this.store.listSceneDrafts(chapterId);
    const draftsBySceneId = new Map<string, string>(
      drafts.map((draft) => [draft.sceneId, draft.content]),
    );

    // 3) 纯函数计算报告主体（需求 9.1–9.3）。
    const body = buildWordCountReport(blueprint, draftsBySceneId);

    // 4) 注入元数据，拼成完整报告。
    const report: WordCountReport = {
      ...body,
      chapterId,
      generatedAt: new Date().toISOString(),
    };

    // 5) upsert 持久化（需求 9.4）并返回。
    return this.store.saveWordCountReport(report);
  }
}
