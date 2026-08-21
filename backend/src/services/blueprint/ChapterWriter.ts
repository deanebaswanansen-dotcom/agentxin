/**
 * ChapterWriter — 整章生成编排（design.md「ChapterAssemblyService（整章生成编排 + 合并）」，需求 7）。
 *
 * 该服务编排「按场景顺序写完一章全部场景并合并为整章正文」的完整流式流程，复用既有
 * {@link SceneWriter}（单场景流式写作 + 持久化）与 {@link ChapterMerger}（按序合并写回
 * 章节正文），把多件事串联（顺序至关重要）：
 * 1. 模型配置存在性检查（需求 7.5）。该检查 **必须** 先于任何场景生成执行：未配置模型时
 *    直接抛出 `MODEL_NOT_CONFIGURED`，绝不发起任何场景生成（不触达 {@link ModelProxy}）。
 *    虽然 {@link SceneWriter.streamScene} 内部也会做同样检查，但整章入口先行检查可保证
 *    「未配置即不发起任何生成」的整体语义。
 * 2. 读取章节蓝图（需求 7.x）；缺失 → `NOT_FOUND`。
 * 3. 按 `blueprint.scenes` 数组顺序依次处理每个场景（需求 7.1）：先广播 `scene`
 *    事件标记场景边界，再透传该场景的文本
 *    增量（`delta` 事件），同时就地累加完整正文；该场景流 **正常结束** 后调用
 *    {@link SceneWriter.finalizeDraft} 持久化整段正文，再进入下一个场景（需求 7.2）。
 * 4. 某场景生成失败 → 直接向上抛出错误，停止后续场景生成；此前已持久化的场景正文保留
 *    （因为不做任何回滚 / 删除，需求 7.4）。
 * 5. 全部场景成功完成后调用 {@link ChapterMerger.merge}，按序合并为整章正文并写入对应
 *    章节的 `content` 字段（需求 7.3）。
 *
 * 设计要点：
 * - 以 async generator（`async *streamChapter`）暴露事件序列（`scene` / `delta`），供 SSE
 *   路由逐帧转发（场景边界 + 文本增量），与 design.md 的流式编排一致。
 * - 领域层仅依赖抽象（{@link DataStore}、{@link ModelConfigService}）与既有编排组件
 *   （{@link SceneWriter}、{@link ChapterMerger}），通过依赖注入传入，便于替换与测试。
 * - 持久化时机（需求 7.2 / 7.4）：每个场景在其流 **正常结束** 后立即持久化，再开始下一个；
 *   中途失败时已持久化的场景保留、后续场景不再生成。
 * - 安全（需求 15.3）：API Key 由 {@link ModelProxy} 在服务端注入，本服务从不接触或返回它。
 */
import type { DataStore } from '../../store/DataStore.js';
import type { Id } from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import type { ChapterMerger } from './ChapterMerger.js';
import type { SceneWriter } from './SceneWriter.js';
import { ReasoningArtifactFilter, stripReasoningArtifacts } from '../text/reasoningSanitizer.js';

const MAX_EMPTY_SCENE_ATTEMPTS = 3;

/**
 * 整章生成的流式事件（需求 7.1, 7.2）。
 *
 * - `scene`：标记后续 `delta` 事件归属的场景（前端据此分段展示）。每进入一个场景先发一帧。
 * - `delta`：当前场景的一段文本增量（按提供商产出顺序逐段产出，且不含 API Key）。
 */
export type ChapterWriteEvent =
  | { type: 'scene'; sceneId: string }
  | { type: 'delta'; sceneId: string; text: string };

export class ChapterWriter {
  /**
   * @param store 持久化抽象，用于加载章节蓝图（场景列表与顺序依据）。
   * @param modelConfigService 模型配置服务，提供内部完整配置（含 API Key），用于整章入口的
   *   「未配置即不发起任何生成」前置检查（需求 7.5）。
   * @param sceneWriter 单场景流式写作编排，复用其 `streamScene` 与 `finalizeDraft`。
   * @param chapterMerger 章节合并编排，复用其 `merge` 在全部场景完成后写回整章正文。
   */
  constructor(
    private readonly store: DataStore,
    private readonly modelConfigService: ModelConfigService,
    private readonly sceneWriter: SceneWriter,
    private readonly chapterMerger: ChapterMerger,
  ) {}

  /**
   * 编排整章生成：按 `blueprint.scenes` 数组顺序逐场景流式生成、逐场景持久化，最后合并为整章正文（需求 7）。
   *
   * 步骤（顺序至关重要）：
   * 1. 读取内部模型配置；缺失 → 抛出 `MODEL_NOT_CONFIGURED`，且不发起任何场景生成（需求 7.5）。
   * 2. 读取章节蓝图；缺失 → `NOT_FOUND`。
   * 3. 按 `blueprint.scenes` 数组顺序依次处理每个场景（需求 7.1）：
   *    - `yield { type: 'scene', sceneId }` 标记场景边界。
   *    - 调用 {@link SceneWriter.streamScene} 取得增量流，`for await` 透传增量
   *      （`yield { type: 'delta', sceneId, text }`）并累加完整正文。
   *    - 该场景流正常结束后调用 {@link SceneWriter.finalizeDraft} 持久化整段正文，
   *      再进入下一个场景（需求 7.2）。
   * 4. 某场景生成失败 → 错误向上抛出（不捕获），停止后续场景生成；此前已持久化的场景正文保留
   *    （需求 7.4）。
   * 5. 全部场景成功完成后调用 {@link ChapterMerger.merge}，合并为整章正文并写入章节 `content`
   *    （需求 7.3）。
   *
   * @param chapterId 目标章节标识符（数据存储主键）。
   * @param signal 取消信号，透传给每个场景的流式补全；中止时由底层流抛错，停止后续生成。
   * @returns 异步事件序列（`scene` / `delta`），供 SSE 路由逐帧转发。
   * @throws {ServiceError} `MODEL_NOT_CONFIGURED`（未配置模型，需求 7.5）或 `NOT_FOUND`
   *   （章节蓝图不存在）。
   */
  async *streamChapter(
    chapterId: Id,
    signal: AbortSignal,
  ): AsyncGenerator<ChapterWriteEvent> {
    // 1) 模型配置存在性检查 —— 必须先于任何场景生成（需求 7.5）。
    //    未配置时绝不发起任何生成，整章入口先行检查以保证「未配置即不发起任何生成」。
    const config = await this.modelConfigService.getInternalConfig();
    if (config === undefined) {
      throw ServiceError.modelNotConfigured(
        '尚未配置模型，请先在设置中填写 base URL、API Key 与模型名称。',
      );
    }

    // 2) 读取章节蓝图（场景列表与顺序依据）；缺失 → NOT_FOUND。
    const blueprint = await this.store.getChapterBlueprintByChapter(chapterId);
    if (!blueprint) {
      throw ServiceError.notFound(`章节蓝图不存在：${chapterId}`);
    }

    // 3) 按 blueprint.scenes 数组顺序依次处理每个场景（需求 7.1）。
    //    已有非空草稿则跳过（崩溃续写）；替换蓝图会清掉该章草稿，故跳过不会沿用旧蓝图正文。
    for (const scene of blueprint.scenes) {
      const sceneId = scene.scene_id;

      // A chapter is a resumable unit.  A previous successful scene draft is
      // already a durable checkpoint, so do not spend another model call or
      // overwrite it when a later scene is retried.
      const existingDraft = await this.store.getSceneDraft(chapterId, sceneId);
      if (stripReasoningArtifacts(existingDraft?.content ?? '').trim().length > 0) {
        yield { type: 'scene', sceneId };
        continue;
      }

      // 标记场景边界，后续 delta 均归属该场景。
      yield { type: 'scene', sceneId };

      let saved = false;
      for (let attempt = 1; attempt <= MAX_EMPTY_SCENE_ATTEMPTS; attempt += 1) {
        // 取得该场景增量流；streamScene 内部亦会做配置 / 蓝图 / 场景校验。
        const { stream } = await this.sceneWriter.streamScene(
          chapterId,
          sceneId,
          signal,
        );

        // 透传增量并累加完整正文。任一增量产出阶段抛错（提供商错误 / 超时 / 中止）将
        // 直接向上传播，停止后续场景生成；此前已持久化的场景正文保留（需求 7.4）。
        let fullText = '';
        const filter = new ReasoningArtifactFilter();
        for await (const delta of stream) {
          if (delta.kind === 'content') {
            const cleaned = filter.push(delta.text);
            if (cleaned.length > 0) {
              fullText += cleaned;
              yield { type: 'delta', sceneId, text: cleaned };
            }
          }
        }
        const tail = filter.flush();
        if (tail.length > 0) {
          fullText += tail;
          yield { type: 'delta', sceneId, text: tail };
        }

        const cleanText = stripReasoningArtifacts(fullText).trim();
        if (cleanText.length > 0) {
          // 该场景流正常结束后持久化整段正文，再进入下一个场景（需求 7.2）。
          await this.sceneWriter.finalizeDraft(chapterId, sceneId, cleanText);
          saved = true;
          break;
        }
        // Empty provider content is transient (thinking budget / gateway
        // truncation).  Retry only this scene; prior scenes remain intact.
      }
      if (!saved) {
        throw ServiceError.validation(
          `场景「${scene.name}」连续 ${MAX_EMPTY_SCENE_ATTEMPTS} 次未返回正文，已保留已完成场景，请重试。`,
        );
      }
    }

    // 4) 全部场景完成后合并为整章正文并写入章节 content（需求 7.3）。
    await this.chapterMerger.merge(chapterId);
  }
}
