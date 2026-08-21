/**
 * WritingService — 写作编排（design: "Services 领域层 > WritingService"）。
 *
 * 该服务编排一次对话式写作请求（续写/改写/润色）的完整流程，将三件事串联：
 * 1. 模型配置存在性检查（Requirement 5.4）。
 * 2. 写作上下文组装：加载章节正文、解析附加设定，调用纯函数
 *    {@link buildPromptMessages}（Requirements 6.1, 6.2, 6.5, 6.6）。
 * 3. 通过 {@link ModelProxy} 向提供商发起流式补全并逐段转发增量
 *    （Requirements 5.1, 5.3）。
 *
 * 设计要点：
 * - 领域层仅依赖抽象（{@link DataStore}、{@link ModelConfigService}、
 *   {@link ModelProxy}），通过依赖注入传入，便于替换与测试。
 * - 模型配置检查 **必须** 发生在任何提供商调用之前：未配置模型时直接抛出
 *   `MODEL_NOT_CONFIGURED`，绝不触达 {@link ModelProxy}（Requirement 5.4 /
 *   Property 18）。
 * - 安全（Requirement 5.6）：API Key 由 {@link ModelProxy} 在服务端注入出站请求头，
 *   本服务从不将其写入任何返回给前端的数据。
 */
import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type { StreamDelta } from '../../proxy/sseParser.js';
import type { DataStore } from '../../store/DataStore.js';
import type {
  Id,
  SettingSnippet,
  WritingContextInput,
  WritingRequestBody,
} from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import { buildPromptMessages } from './buildPromptMessages.js';

export class WritingService {
  /**
   * @param store 持久化抽象，用于加载章节正文与解析附加设定条目。
   * @param modelConfigService 模型配置服务，提供内部完整配置（含 API Key）。
   * @param modelProxy 模型代理，向 OpenAI 兼容提供商发起流式补全。
   */
  constructor(
    private readonly store: DataStore,
    private readonly modelConfigService: ModelConfigService,
    private readonly modelProxy: ModelProxy,
  ) {}

  /**
   * 编排一次写作请求并返回提供商增量文本的异步可迭代序列。
   *
   * 步骤（顺序至关重要）：
   * 1. 读取内部模型配置；缺失 → 抛出 `MODEL_NOT_CONFIGURED`（Requirement 5.4）。
   *    该检查先于任何章节/设定加载与提供商调用执行。
   * 2. 加载目标章节；缺失 → `NOT_FOUND`。其正文作为续写上下文（Requirement 6.1）。
   * 3. 将 `attachedSettingIds` 解析为 {@link SettingSnippet} 列表（Requirement 6.5）。
   * 4. 组装 {@link WritingContextInput} 并调用 {@link buildPromptMessages}
   *    （Requirements 6.1, 6.2, 6.6）。
   * 5. 调用 {@link ModelProxy.streamCompletion} 并返回其增量序列
   *    （Requirements 5.1, 5.3）。
   *
   * @returns 文本增量的异步可迭代序列，按提供商产出顺序逐段产出，且不含 API Key。
   * @throws {ServiceError} `MODEL_NOT_CONFIGURED`（未配置模型）或 `NOT_FOUND`（章节不存在）。
   */
  async streamWriting(
    projectId: Id,
    chapterId: Id,
    body: WritingRequestBody,
    signal: AbortSignal,
  ): Promise<AsyncIterable<StreamDelta>> {
    // 1) 模型配置存在性检查 —— 必须先于任何提供商调用（Requirement 5.4）。
    const config = await this.modelConfigService.getInternalConfig();
    if (config === undefined) {
      throw ServiceError.modelNotConfigured(
        '尚未配置模型，请先在设置中填写 base URL、API Key 与模型名称。',
      );
    }

    // 2) 加载章节正文（续写上下文，Requirement 6.1）。
    const chapter = await this.store.getChapter(chapterId);
    if (!chapter || chapter.projectId !== projectId) {
      throw ServiceError.notFound(`章节不存在：${chapterId}`);
    }

    // 3) 解析附加设定为上下文片段（Requirement 6.5）。
    const attachedSettings = await this.resolveAttachedSettings(
      projectId,
      body.attachedSettingIds,
    );

    // 4) 组装写作上下文消息（Requirements 6.1, 6.2, 6.6）。
    const context: WritingContextInput = {
      operation: body.operation,
      instruction: body.instruction,
      chapterContent: chapter.content,
      selectedText: body.selectedText,
      attachedSettings,
      sessionHistory: body.sessionHistory ?? [],
    };
    const messages = buildPromptMessages(context);

    // 5) 发起流式补全并透传增量（Requirements 5.1, 5.3）。
    return this.modelProxy.streamCompletion(config, messages, signal);
  }

  /**
   * 将 `attachedSettingIds` 解析为有序的 {@link SettingSnippet} 列表
   * （Requirement 6.5）。
   *
   * 实现：分别加载该项目的人物、世界观与大纲列表，按各类型请求的 id 顺序选出
   * 匹配条目并映射为片段。未知或不属于该项目的 id 被静默忽略，保证编排的健壮性。
   * 片段整体顺序为：人物 → 世界观 → 大纲，类型内保留请求的 id 顺序。
   */
  private async resolveAttachedSettings(
    projectId: Id,
    attached: WritingRequestBody['attachedSettingIds'],
  ): Promise<SettingSnippet[]> {
    if (!attached) {
      return [];
    }

    const snippets: SettingSnippet[] = [];

    const characterIds = attached.characterIds ?? [];
    if (characterIds.length > 0) {
      const characters = await this.store.listCharacters(projectId);
      const byId = new Map(characters.map((c) => [c.id, c]));
      for (const id of characterIds) {
        const entity = byId.get(id);
        if (entity) {
          snippets.push({
            kind: 'character',
            title: entity.name,
            body: entity.description,
          });
        }
      }
    }

    const worldSettingIds = attached.worldSettingIds ?? [];
    if (worldSettingIds.length > 0) {
      const worldSettings = await this.store.listWorldSettings(projectId);
      const byId = new Map(worldSettings.map((w) => [w.id, w]));
      for (const id of worldSettingIds) {
        const entity = byId.get(id);
        if (entity) {
          snippets.push({
            kind: 'world',
            title: entity.title,
            body: entity.content,
          });
        }
      }
    }

    const outlineIds = attached.outlineIds ?? [];
    if (outlineIds.length > 0) {
      const outlines = await this.store.listOutlines(projectId);
      const byId = new Map(outlines.map((o) => [o.id, o]));
      for (const id of outlineIds) {
        const entity = byId.get(id);
        if (entity) {
          snippets.push({
            kind: 'outline',
            title: entity.title,
            body: entity.content,
          });
        }
      }
    }

    return snippets;
  }
}
