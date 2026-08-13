/**
 * BlueprintService — 章节蓝图生成编排（design: "Services 领域层 > BlueprintService（生成 / 读取 / 替换蓝图）"）。
 *
 * 该服务编排「根据章节需求生成结构化章节蓝图」的完整流程，将多件事串联：
 * 1. 请求体校验：目标字数为 100–100000 的正整数（需求 1.3）；章节需求文本非空且
 *    长度不超过 5000 字符（需求 1.4）；字段缺失同样按校验失败处理（需求 1.5）。
 * 2. 模型配置存在性检查（需求 2.5）。该检查 **必须** 先于任何提供商调用执行：未配置
 *    模型时直接抛出 `MODEL_NOT_CONFIGURED`，绝不触达 {@link ModelProxy}。
 * 3. 目标章节存在性检查（需求 5.4）；缺失 → `NOT_FOUND`。并从章节取得所属 `projectId`。
 * 4. 读取该项目的大纲 / 人物 / 世界观作为生成上下文；某类不存在时以空集合处理（需求 2.1）。
 * 5. 调用纯函数 {@link buildBlueprintPrompt} 组装消息（需求 2.2）。
 * 6. 经 {@link ModelProxy.streamCompletion} 以流式方式生成，并在服务端聚合为完整文本
 *    （需求 2.2）。模型错误 / 超时由 {@link ModelProxy} 抛出 `ProxyError`，本服务直接
 *    向上透传，由路由层映射为 `PROVIDER_ERROR`（需求 2.6）。
 * 7. 调用纯函数 {@link parseBlueprintFromText} 解析（失败抛 `VALIDATION_ERROR`，需求
 *    3.1 / 3.4 / 3.5）。
 * 8. 调用纯函数 {@link validateBlueprint} 做结构校验（失败抛 `VALIDATION_ERROR`，需求 4.x）。
 * 9. 将解析得到的 {@link BlueprintCore} 的 `chapter_id` 覆盖为目标 `chapterId`，确保蓝图
 *    与目标章节一致，构成 {@link ChapterBlueprint}。
 * 10. 调用 {@link DataStore.saveChapterBlueprint} 持久化（按章节替换既有，仅保留一份，
 *    需求 5.1 / 5.3），返回持久化后的蓝图。
 *
 * 设计要点：
 * - 领域层仅依赖抽象（{@link DataStore}、{@link ModelConfigService}、{@link ModelProxy}），
 *   通过依赖注入传入，与既有 `WritingService` / `SceneWriter` 一致，便于替换与测试。
 * - 安全（需求 15.3）：API Key 由 {@link ModelProxy} 在服务端注入出站请求头，本服务从不
 *   将其写入任何返回值。
 */
import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type { StreamDelta } from '../../proxy/sseParser.js';
import { pythonBridge } from '../../proxy/PythonBridge.js';
import type { DataStore } from '../../store/DataStore.js';
import type {
  ChapterBlueprint,
  GenerateBlueprintBody,
  Id,
} from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import {
  buildBlueprintPrompt,
  type CharacterContext,
  type OutlineContext,
  type WorldSettingContext,
} from './buildBlueprintPrompts.js';
import { parseBlueprintFromText } from './blueprintParser.js';
import { validateBlueprint } from './blueprintValidator.js';

/** 章节目标字数下界（含），需求 1.3。 */
const MIN_TARGET_WORDS = 100;

/** 章节目标字数上界（含），需求 1.3。 */
const MAX_TARGET_WORDS = 100000;

/** 章节需求文本长度上界（含），需求 1.4。 */
const MAX_REQUIREMENT_LENGTH = 5000;

/** 是否为正整数（严格大于 0 且为整数；非有限值一律视为非法）。 */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export class BlueprintService {
  /**
   * @param store 持久化抽象，用于读取目标章节、项目设定并持久化章节蓝图。
   * @param modelConfigService 模型配置服务，提供内部完整配置（含 API Key）。
   * @param modelProxy 模型代理，向 OpenAI 兼容提供商发起流式补全。
   */
  constructor(
    private readonly store: DataStore,
    private readonly modelConfigService: ModelConfigService,
    private readonly modelProxy: ModelProxy,
  ) {}

  /**
   * 生成并持久化某章节的结构化蓝图（需求 1, 2, 3, 4, 5）。
   *
   * 步骤顺序至关重要（见类级文档）：请求体校验 → 模型配置检查 → 章节存在性 →
   * 读取项目设定上下文 → 组装 prompt → 聚合流式输出 → 解析 → 结构校验 →
   * 绑定 chapter_id → 持久化。
   *
   * @param chapterId 目标章节标识符（数据存储主键）。蓝图归属于该章节。
   * @param body 生成请求体（目标字数 + 章节需求文本）。
   * @param signal 调用方用于取消 / 超时的 AbortSignal，透传给模型代理。
   * @returns 持久化后的章节蓝图（其 `chapter_id` 等于传入的 `chapterId`）。
   * @throws {ServiceError} `VALIDATION_ERROR`（请求体非法 / 解析失败 / 结构校验失败）、
   *   `MODEL_NOT_CONFIGURED`（未配置模型）或 `NOT_FOUND`（目标章节不存在）。
   * @throws {import('../../proxy/ProxyError.js').ProxyError} 模型提供商错误 / 超时
   *   （向上透传，由路由层映射为 `PROVIDER_ERROR`，需求 2.6）。
   */
  async generate(
    chapterId: Id,
    body: GenerateBlueprintBody,
    signal: AbortSignal,
  ): Promise<ChapterBlueprint> {
    // 1) 请求体校验（需求 1.3 / 1.4 / 1.5）。字段缺失 / 类型非法按校验失败处理。
    this.assertValidBody(body);

    // 2) 模型配置存在性检查 —— 必须先于任何提供商调用（需求 2.5）。
    const config = await this.modelConfigService.getInternalConfig();
    if (config === undefined) {
      throw ServiceError.modelNotConfigured(
        '尚未配置模型，请先在设置中填写 base URL、API Key 与模型名称。',
      );
    }

    // 3) 目标章节存在性检查（需求 5.4），并取得所属项目。
    const chapter = await this.store.getChapter(chapterId);
    if (!chapter) {
      throw ServiceError.notFound(`章节不存在：${chapterId}`);
    }
    const { projectId } = chapter;

    // === Refactor: delegate core planning to Python LangGraph (thin proxy) ===
    // Only when explicitly enabled (USE_PYTHON_CORE=1). Default legacy for test compat & envs without full Python agent.
    // Explicit config already checked. Python bridge will fail fast on missing provider (no silent mock).
    let bpFromPy: ChapterBlueprint | null = null;
    if (process.env.USE_PYTHON_CORE === '1') {
      const pyPrompt = `target ${body.targetWords} words. requirement: ${body.requirement}`;
      try {
        const py = await pythonBridge.call({
          task: 'plan_blueprint',
          prompt: pyPrompt,
          chapterId,
          // projectDir inferred by workspace + bridge
        });
        if (py.blueprint) {
          bpFromPy = { ...py.blueprint, chapter_id: chapterId } as ChapterBlueprint;
        }
      } catch (e) {
        // fallthrough to legacy Node path
      }
    }

    if (bpFromPy) {
      // persist & return python result (single engine)
      return this.store.saveChapterBlueprint(bpFromPy);
    }

    // --- Legacy Node path (kept for tests / fallback) ---
    // 4) 读取项目大纲 / 人物 / 世界观作为生成上下文；缺某类则以空集合处理（需求 2.1）。
    const [outlines, characters, worldSettings] = await Promise.all([
      this.store.listOutlines(projectId),
      this.store.listCharacters(projectId),
      this.store.listWorldSettings(projectId),
    ]);

    const outlineContext: OutlineContext[] = outlines.map((o) => ({
      title: o.title,
      content: o.content,
    }));
    const characterContext: CharacterContext[] = characters.map((c) => ({
      name: c.name,
      description: c.description,
    }));
    const worldSettingContext: WorldSettingContext[] = worldSettings.map(
      (w) => ({ title: w.title, content: w.content }),
    );

    // 5) 组装蓝图生成消息（需求 2.2）。
    const messages = buildBlueprintPrompt({
      requirement: body.requirement,
      targetWords: body.targetWords,
      outlines: outlineContext,
      characters: characterContext,
      worldSettings: worldSettingContext,
    });

    // 6) 经模型代理流式生成并聚合为完整文本（需求 2.2）。
    //    模型错误 / 超时由 ModelProxy 抛出 ProxyError，向上透传（需求 2.6）。
    const fullText = await this.collectStream(
      this.modelProxy.streamCompletion(config, messages, signal, {
        jsonMode: true,
        disableThinking: true,
        maxTokens: 4096,
      }),
    );

    // 7–8) 解析并校验。结构化模型偶尔返回被截断的 JSON；只对这种领域校验
    // 错误补发一次更精简的 JSON 请求，提供商/网络错误仍直接向上传递。
    let core;
    try {
      core = parseBlueprintFromText(fullText);
      validateBlueprint(core);
    } catch (error) {
      if (!(error instanceof ServiceError) || error.code !== 'VALIDATION_ERROR') throw error;
      const retryMessages = [
        ...messages,
        {
          role: 'user' as const,
          content: [
            '上一次蓝图 JSON 不完整或未通过结构校验。请重新输出一份更精简的完整 JSON。',
            '只保留 schema 要求字段；场景控制在 3–5 个；不要解释、Markdown 或思考过程。',
          ].join('\n'),
        },
      ];
      const retryText = await this.collectStream(
        this.modelProxy.streamCompletion(config, retryMessages, signal, {
          jsonMode: true,
          disableThinking: true,
          maxTokens: 4096,
        }),
      );
      core = parseBlueprintFromText(retryText);
      validateBlueprint(core);
    }

    // 9) 绑定目标章节标识符，确保蓝图与目标章节一致。
    const blueprint: ChapterBlueprint = { ...core, chapter_id: chapterId };

    // 10) 持久化（按章节替换既有，仅保留一份，需求 5.1 / 5.3），返回。
    return this.store.saveChapterBlueprint(blueprint);
  }

  /**
   * 读取某章节最新已持久化的章节蓝图（需求 5.2）。
   *
   * 章节不存在或该章节尚无已持久化蓝图，均返回 `NOT_FOUND`（需求 5.4 / 5.6）。
   * 两种情形对外均表现为「资源不存在」，故以蓝图缺失统一判定即可。
   *
   * @param chapterId 目标章节标识符（数据存储主键）。
   * @returns 该章节最新已持久化的章节蓝图。
   * @throws {ServiceError} `NOT_FOUND`（章节不存在或无蓝图）。
   */
  async getByChapter(chapterId: Id): Promise<ChapterBlueprint> {
    const blueprint = await this.store.getChapterBlueprintByChapter(chapterId);
    if (!blueprint) {
      throw ServiceError.notFound(`章节蓝图不存在：${chapterId}`);
    }
    return blueprint;
  }

  /**
   * 校验生成蓝图请求体（需求 1.3 / 1.4 / 1.5）。
   *
   * - 目标字数：必须为 {@link MIN_TARGET_WORDS}–{@link MAX_TARGET_WORDS} 的正整数（需求 1.3）。
   * - 章节需求文本：必须为非空字符串且字符长度不超过 {@link MAX_REQUIREMENT_LENGTH}（需求 1.4）。
   * - 字段缺失 / 类型非法：按校验失败处理（需求 1.5）。
   *
   * 字符长度以 Unicode 码点计，正确处理多字节字符（与字数统计口径一致）。
   */
  private assertValidBody(body: GenerateBlueprintBody): void {
    // 目标字数（需求 1.3 / 1.5）：必须为数字且为 [100, 100000] 范围内的正整数。
    const targetWords = body?.targetWords;
    if (
      typeof targetWords !== 'number' ||
      !isPositiveInteger(targetWords) ||
      targetWords < MIN_TARGET_WORDS ||
      targetWords > MAX_TARGET_WORDS
    ) {
      throw ServiceError.validation(
        `目标字数非法：必须为 ${MIN_TARGET_WORDS}–${MAX_TARGET_WORDS} 之间的正整数`,
      );
    }

    // 章节需求文本（需求 1.4 / 1.5）：必须为非空字符串且长度不超过 5000 字符。
    const requirement = body?.requirement;
    if (typeof requirement !== 'string' || requirement.length === 0) {
      throw ServiceError.validation('章节需求文本不能为空');
    }
    if ([...requirement].length > MAX_REQUIREMENT_LENGTH) {
      throw ServiceError.validation(
        `章节需求文本过长：长度不能超过 ${MAX_REQUIREMENT_LENGTH} 个字符`,
      );
    }
  }

  /**
   * 将模型代理产出的文本增量序列聚合为完整字符串（需求 2.2）。
   *
   * 以 `for await` 逐段累加；提供商错误 / 超时时 {@link ModelProxy} 会抛出
   * `ProxyError`，本助手不做转换、直接向上透传（需求 2.6）。聚合结果与抛出的错误
   * 均不含 API Key。
   */
  private async collectStream(stream: AsyncIterable<StreamDelta>): Promise<string> {
    let full = '';
    for await (const delta of stream) {
      if (delta.kind === 'content') {
        full += delta.text;
      }
    }
    return full;
  }
}
