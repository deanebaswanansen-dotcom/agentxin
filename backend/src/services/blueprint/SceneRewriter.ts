/**
 * SceneRewriter — 局部场景重写编排（design: "Services 领域层 > SceneService
 * （分场景写作 / 扩写 / 重写，流式）"，需求 12）。
 *
 * 该服务编排「依据用户修改要求重写章节蓝图中某单个场景」的完整流式流程，将多件事
 * 串联（顺序至关重要）：
 * 1. 校验修改要求 `instruction` 非空（trim 后长度 > 0）；为空 → `VALIDATION_ERROR`
 *    （需求 12.5）。该校验先于任何加载与提供商调用执行。
 * 2. 模型配置存在性检查（需求 12.7）。该检查 **必须** 先于任何提供商调用：未配置
 *    模型时直接抛出 `MODEL_NOT_CONFIGURED`，绝不触达 {@link ModelProxy}。
 * 3. 读取章节蓝图并定位目标场景（需求 12.4）；蓝图或场景缺失 → `NOT_FOUND`。
 * 4. 读取目标场景当前已持久化正文（需求 12.6）；尚无正文 → `VALIDATION_ERROR`
 *    并提示该场景尚未写作。
 * 5. 调用纯函数 {@link buildRewritePrompt} 组装消息（注入当前正文 + 蓝图约束 +
 *    用户修改要求，要求保留 purpose 与 must_include 承担的剧情功能、维持相邻场景
 *    衔接，需求 12.1, 12.2）。
 * 6. 经 {@link ModelProxy.streamCompletion} 以流式方式生成重写后正文（需求 12.1），
 *    返回 `{ scene, stream }` 供路由编排转发与持久化。
 *
 * 持久化时机（需求 12.3）：本服务只产出增量流，**不** 在流进行中写盘。由调用方
 * （SSE 路由）在流 **正常结束且未被中止** 时累加完整正文，再调用
 * {@link SceneRewriter.finalizeDraft} 持久化；该写入按 `(chapterId, sceneId)`
 * upsert，仅覆盖目标场景正文，其余场景不受影响（需求 12.3）。模型错误 / 超时或
 * 客户端中止时不调用该方法，从而不持久化部分生成的场景正文。
 *
 * 设计要点：
 * - 领域层仅依赖抽象（{@link DataStore}、{@link ModelConfigService}、
 *   {@link ModelProxy}），通过依赖注入传入，与既有 {@link SceneWriter} 一致。
 * - 安全（需求 15.3）：API Key 由 {@link ModelProxy} 在服务端注入出站请求头，
 *   本服务从不将其写入任何返回值。
 */
import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type { StreamDelta } from '../../proxy/sseParser.js';
import type { DataStore } from '../../store/DataStore.js';
import type { Id, RewriteSceneBody, Scene } from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import { buildRewritePrompt } from './buildBlueprintPrompts.js';
import { stripReasoningArtifacts } from '../text/reasoningSanitizer.js';

export class SceneRewriter {
  /**
   * @param store 持久化抽象，用于加载章节蓝图、目标场景当前正文并持久化重写后正文。
   * @param modelConfigService 模型配置服务，提供内部完整配置（含 API Key）。
   * @param modelProxy 模型代理，向 OpenAI 兼容提供商发起流式补全。
   */
  constructor(
    private readonly store: DataStore,
    private readonly modelConfigService: ModelConfigService,
    private readonly modelProxy: ModelProxy,
  ) {}

  /**
   * 编排单个场景的流式重写，返回目标场景与提供商增量文本序列（需求 12）。
   *
   * 步骤（顺序至关重要）：
   * 1. 校验 `body.instruction` 非空（trim 后长度 > 0）；为空 → `VALIDATION_ERROR`
   *    （需求 12.5）。
   * 2. 读取内部模型配置；缺失 → `MODEL_NOT_CONFIGURED`（需求 12.7）。该检查先于
   *    任何蓝图加载与提供商调用执行。
   * 3. 读取章节蓝图；缺失 → `NOT_FOUND`。在 `blueprint.scenes` 中按 `scene_id`
   *    定位目标场景；不存在 → `NOT_FOUND`（需求 12.4）。
   * 4. 读取目标场景当前已持久化正文；尚无正文 → `VALIDATION_ERROR` 并提示该场景
   *    尚未写作（需求 12.6）。
   * 5. 调用 {@link buildRewritePrompt} 组装消息（注入当前正文 + 蓝图约束 + 修改
   *    要求，需求 12.1, 12.2）。
   * 6. 调用 {@link ModelProxy.streamCompletion} 并返回其增量序列（需求 12.1）。
   *
   * @returns `{ scene, stream }`：目标场景与文本增量的异步可迭代序列（按提供商
   *   产出顺序逐段产出，且不含 API Key）。
   * @throws {ServiceError} `VALIDATION_ERROR`（修改要求为空 / 目标场景尚未写作）、
   *   `MODEL_NOT_CONFIGURED`（未配置模型）或 `NOT_FOUND`（章节蓝图或场景不存在）。
   */
  async streamRewrite(
    chapterId: Id,
    sceneId: string,
    body: RewriteSceneBody,
    signal: AbortSignal,
  ): Promise<{ scene: Scene; stream: AsyncIterable<StreamDelta> }> {
    // 1) 校验修改要求非空（需求 12.5）。
    const instruction = body.instruction;
    if (instruction.trim().length === 0) {
      throw ServiceError.validation('重写的修改要求不能为空');
    }

    // 2) 模型配置存在性检查 —— 必须先于任何提供商调用（需求 12.7）。
    const config = await this.modelConfigService.getInternalConfig();
    if (config === undefined) {
      throw ServiceError.modelNotConfigured(
        '尚未配置模型，请先在设置中填写 base URL、API Key 与模型名称。',
      );
    }

    // 3) 读取章节蓝图并定位目标场景（需求 12.4）。
    const blueprint = await this.store.getChapterBlueprintByChapter(chapterId);
    if (!blueprint) {
      throw ServiceError.notFound(`章节蓝图不存在：${chapterId}`);
    }
    const scene = blueprint.scenes.find((s) => s.scene_id === sceneId);
    if (!scene) {
      throw ServiceError.notFound(`场景不存在：${sceneId}`);
    }

    // 4) 读取目标场景当前已持久化正文（需求 12.6）。
    const draft = await this.store.getSceneDraft(chapterId, sceneId);
    if (!draft) {
      throw ServiceError.validation(`该场景尚未写作，无法重写：${sceneId}`);
    }

    // 5) 组装重写消息（注入当前正文 + 蓝图约束 + 修改要求，需求 12.1, 12.2）。
    const messages = buildRewritePrompt({
      blueprint,
      scene,
      currentContent: draft.content,
      instruction,
    });

    // 6) 发起流式补全并透传增量（需求 12.1）。
    const stream = this.modelProxy.streamCompletion(config, messages, signal);
    return { scene, stream };
  }

  /**
   * 持久化整段重写后的场景正文（需求 12.3）。
   *
   * 供路由在场景流 **正常结束且未被中止** 时调用，写入完整场景正文。按
   * `(chapterId, sceneId)` upsert（替换目标场景正文，其余场景不受影响）。中途失败时
   * 调用方不调用本方法即可保证不持久化部分正文。
   *
   * @param chapterId 目标章节标识符（数据存储主键）。
   * @param sceneId 目标场景在蓝图内的 `scene_id`。
   * @param content 完整重写后场景正文。
   */
  async finalizeDraft(
    chapterId: Id,
    sceneId: string,
    content: string,
  ): Promise<void> {
    await this.store.saveSceneDraft({
      chapterId,
      sceneId,
      content: stripReasoningArtifacts(content),
      updatedAt: new Date().toISOString(),
    });
  }
}
