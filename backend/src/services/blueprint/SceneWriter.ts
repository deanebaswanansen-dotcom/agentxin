/**
 * SceneWriter — 分场景写作编排（design: "Services 领域层 > SceneService（分场景写作 / 扩写 / 重写，流式）"）。
 *
 * 该服务编排「针对章节蓝图中某单个场景的流式写作」的完整流程，将多件事串联：
 * 1. 模型配置存在性检查（需求 6.7）。该检查 **必须** 先于任何提供商调用执行：
 *    未配置模型时直接抛出 `MODEL_NOT_CONFIGURED`，绝不触达 {@link ModelProxy}。
 * 2. 读取章节蓝图并定位目标场景（需求 6.6）；蓝图或场景缺失 → `NOT_FOUND`。
 * 3. 组装写作上下文：解析该场景出场角色的人物设定（需求 6.2）；若蓝图顺序中存在
 *    上一场景且其已有已持久化正文，则纳入上一场景正文以便衔接（需求 6.3）。
 * 4. 调用纯函数 {@link buildScenePrompt} 组装消息（注入 target_words/purpose/
 *    must_include/ending_state 等约束，需求 6.1）。
 * 5. 经 {@link ModelProxy.streamCompletion} 以流式方式生成场景正文（需求 6.4），
 *    返回 `{ blueprint, scene, stream }` 供路由 / ChapterWriter 编排转发与持久化。
 *
 * 持久化时机（需求 6.5 / 6.8）：本服务只产出增量流，**不** 在流进行中写盘。由调用方
 * （SSE 路由 / 整章生成编排）在流 **正常结束且未被中止** 时累加完整正文，再调用
 * {@link SceneWriter.finalizeDraft} 持久化；模型错误 / 超时或客户端中止时不调用该方法，
 * 从而保证不持久化部分生成的场景正文（需求 6.8）。
 *
 * 设计要点：
 * - 领域层仅依赖抽象（{@link DataStore}、{@link ModelConfigService}、
 *   {@link ModelProxy}），通过依赖注入传入，与既有 `WritingService` 一致，便于替换与测试。
 * - 安全（需求 15.3）：API Key 由 {@link ModelProxy} 在服务端注入出站请求头，
 *   本服务从不将其写入任何返回值。
 */
import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type { StreamDelta } from '../../proxy/sseParser.js';
import type { DataStore } from '../../store/DataStore.js';
import type { ChapterBlueprint, Id, Scene } from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import {
  buildScenePrompt,
  type CharacterContext,
} from './buildBlueprintPrompts.js';
import { compareSceneId } from './mergeScenes.js';
import { stripReasoningArtifacts } from '../text/reasoningSanitizer.js';

export class SceneWriter {
  /**
   * @param store 持久化抽象，用于加载章节蓝图、人物设定、上一场景正文并持久化场景正文。
   * @param modelConfigService 模型配置服务，提供内部完整配置（含 API Key）。
   * @param modelProxy 模型代理，向 OpenAI 兼容提供商发起流式补全。
   */
  constructor(
    private readonly store: DataStore,
    private readonly modelConfigService: ModelConfigService,
    private readonly modelProxy: ModelProxy,
  ) {}

  /**
   * 编排单个场景的流式写作，返回目标蓝图、目标场景与提供商增量文本序列（需求 6）。
   *
   * 步骤（顺序至关重要）：
   * 1. 读取内部模型配置；缺失 → 抛出 `MODEL_NOT_CONFIGURED`（需求 6.7）。该检查
   *    先于任何蓝图 / 人物加载与提供商调用执行。
   * 2. 读取章节蓝图；缺失 → `NOT_FOUND`。在 `blueprint.scenes` 中按 `scene_id`
   *    定位目标场景；不存在 → `NOT_FOUND`（需求 6.6）。
   * 3. 解析出场角色设定：取该章节所属项目的人物列表，筛选 `scene.characters` 中列出的
   *    角色（按 name 匹配）并映射为 `{ name, description }[]`（需求 6.2）。
   * 4. 读取上一场景已持久化正文（若存在）：按 `scene_id` 升序定位目标场景的前一个场景，
   *    若其有已持久化正文则作为衔接上下文（需求 6.3）。
   * 5. 调用 {@link buildScenePrompt} 组装消息（注入场景约束，需求 6.1）。
   * 6. 调用 {@link ModelProxy.streamCompletion} 并返回其增量序列（需求 6.4）。
   *
   * @returns `{ blueprint, scene, stream }`：目标章节蓝图、目标场景与文本增量的
   *   异步可迭代序列（按提供商产出顺序逐段产出，且不含 API Key）。
   * @throws {ServiceError} `MODEL_NOT_CONFIGURED`（未配置模型）或 `NOT_FOUND`
   *   （章节蓝图或场景不存在）。
   */
  async streamScene(
    chapterId: Id,
    sceneId: string,
    signal: AbortSignal,
  ): Promise<{
    blueprint: ChapterBlueprint;
    scene: Scene;
    stream: AsyncIterable<StreamDelta>;
  }> {
    // 1) 模型配置存在性检查 —— 必须先于任何提供商调用（需求 6.7）。
    const config = await this.modelConfigService.getInternalConfig();
    if (config === undefined) {
      throw ServiceError.modelNotConfigured(
        '尚未配置模型，请先在设置中填写 base URL、API Key 与模型名称。',
      );
    }

    // 2) 读取章节蓝图并定位目标场景（需求 6.6）。
    const blueprint = await this.store.getChapterBlueprintByChapter(chapterId);
    if (!blueprint) {
      throw ServiceError.notFound(`章节蓝图不存在：${chapterId}`);
    }
    const scene = blueprint.scenes.find((s) => s.scene_id === sceneId);
    if (!scene) {
      throw ServiceError.notFound(`场景不存在：${sceneId}`);
    }

    // 3) 解析该场景出场角色的人物设定（需求 6.2）。
    const characters = await this.resolveSceneCharacters(chapterId, scene);

    // 4) 读取上一场景已持久化正文（若存在，需求 6.3）。
    const previousSceneContent = await this.loadPreviousSceneContent(
      chapterId,
      blueprint,
      sceneId,
    );

    // 5) 组装写作消息（注入场景约束，需求 6.1）。
    const messages = buildScenePrompt({
      blueprint,
      scene,
      characters,
      previousSceneContent,
    });

    // 6) 发起流式补全并透传增量（需求 6.4）。
    const stream = this.modelProxy.streamCompletion(config, messages, signal, {
      disableThinking: true,
      maxTokens: Math.min(4096, Math.max(256, scene.target_words + 128)),
    });
    return { blueprint, scene, stream };
  }

  /**
   * 持久化整段场景正文（需求 6.5）。
   *
   * 供路由 / ChapterWriter 在场景流 **正常结束且未被中止** 时调用，写入完整场景正文。
   * 按 `(chapterId, sceneId)` upsert（替换目标场景正文，其余场景不受影响）。中途失败时
   * 调用方不调用本方法即可保证不持久化部分正文（需求 6.8）。
   *
   * @param chapterId 目标章节标识符（数据存储主键）。
   * @param sceneId 目标场景在蓝图内的 `scene_id`。
   * @param content 完整场景正文。
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

  /**
   * 解析目标场景的出场角色设定（需求 6.2）。
   *
   * 实现：先通过 `getChapter(chapterId)` 取得 `projectId`，再读取该项目人物列表，
   * 按 `scene.characters` 列出的名称（name）筛选匹配角色并映射为
   * `{ name, description }`。`scene.characters` 中未匹配到任何项目人物的名称被静默
   * 忽略，保证编排健壮。结果顺序遵循 `scene.characters` 的声明顺序。
   */
  private async resolveSceneCharacters(
    chapterId: Id,
    scene: Scene,
  ): Promise<CharacterContext[]> {
    if (scene.characters.length === 0) {
      return [];
    }

    const chapter = await this.store.getChapter(chapterId);
    if (!chapter) {
      // 无法确定所属项目时，以空角色设定继续（写作仍可进行）。
      return [];
    }

    const projectCharacters = await this.store.listCharacters(
      chapter.projectId,
    );
    const byName = new Map(projectCharacters.map((c) => [c.name, c]));

    const resolved: CharacterContext[] = [];
    for (const name of scene.characters) {
      const entity = byName.get(name);
      if (entity) {
        resolved.push({ name: entity.name, description: entity.description });
      }
    }
    return resolved;
  }

  /**
   * 读取目标场景在蓝图顺序中的上一场景已持久化正文（需求 6.3）。
   *
   * 实现：以 {@link compareSceneId}（与 {@link mergeScenes} 一致的全序口径）对蓝图
   * 场景按 `scene_id` 升序排序，定位目标场景的前一个场景；若存在且其已有已持久化正文，
   * 则返回该正文作为衔接上下文，否则返回 `undefined`。
   */
  private async loadPreviousSceneContent(
    chapterId: Id,
    blueprint: ChapterBlueprint,
    sceneId: string,
  ): Promise<string | undefined> {
    const orderedSceneIds = blueprint.scenes
      .map((s) => s.scene_id)
      .sort(compareSceneId);

    const index = orderedSceneIds.indexOf(sceneId);
    if (index <= 0) {
      // 目标为首个场景（或未找到）：无上一场景。
      return undefined;
    }

    const previousSceneId = orderedSceneIds[index - 1];
    const previousDraft = await this.store.getSceneDraft(
      chapterId,
      previousSceneId,
    );
    return previousDraft?.content;
  }
}
