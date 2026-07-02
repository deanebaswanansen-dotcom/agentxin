/**
 * PacingChecker — 节奏检查编排（design.md「Services 领域层 > PacingService（节奏检查，经模型）」）。
 *
 * 该服务编排一次章节节奏检查的完整流程，将四件事串联：
 * 1. 模型配置存在性检查 —— **必须先于任何提供商调用**：未配置模型直接抛出
 *    `MODEL_NOT_CONFIGURED`，绝不触达 {@link ModelProxy}（需求 10.6）。
 * 2. 加载目标章节蓝图；缺失 → 抛出 `NOT_FOUND`。读取整章正文（合并后写入章节
 *    `content` 字段）；为空也继续（由模型据此判断，需求 10.1）。
 * 3. 调用纯函数 {@link buildPacingPrompt} 组装消息（注入蓝图 pacing /
 *    emotional_curve / required_plot_points / forbidden_points 与整章正文，
 *    需求 10.1），经 {@link ModelProxy.streamCompletion} 聚合为完整文本后，
 *    用 {@link parsePacingReportFromText} 解析为结构化报告（剧情点完成状态
 *    需求 10.2、被违反禁止事项需求 10.3、按场景问题 / 建议 / 优先级需求 10.4）。
 * 4. 注入元数据（`chapterId` / `generatedAt`）拼成完整 {@link PacingReport}，
 *    经 {@link DataStore.savePacingReport} upsert 持久化后返回（需求 10.5）。
 *
 * 设计要点：
 * - 领域层仅依赖抽象（{@link DataStore}、{@link ModelConfigService}、
 *   {@link ModelProxy}），通过依赖注入传入，与既有 {@link BlueprintService} 一致，
 *   便于替换与测试。
 * - 安全（需求 15.3）：API Key 由 {@link ModelProxy} 在服务端注入出站请求头，本服务
 *   从不将其写入任何返回值；聚合结果与抛出的错误均不含 API Key。
 */
import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type { StreamDelta } from '../../proxy/sseParser.js';
import type { DataStore } from '../../store/DataStore.js';
import type {
  BlueprintCore,
  ChapterBlueprint,
  ChatMessage,
  Id,
  PacingPriority,
  PacingReport,
  PlotPointResult,
  PlotPointStatus,
  ScenePacingIssue,
} from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import { repairLooseJson } from './blueprintParser.js';

// ---------------------------------------------------------------------------
// 枚举取值集合（与 types 中的字面量联合保持一致，用于运行时校验）
// ---------------------------------------------------------------------------

/** 合法的剧情点完成状态取值（需求 10.2）。 */
const PLOT_POINT_STATUSES: readonly PlotPointStatus[] = [
  'completed',
  'partial',
  'missing',
];

/** 合法的修改优先级取值（需求 10.4）。 */
const PACING_PRIORITIES: readonly PacingPriority[] = ['high', 'medium', 'low'];

// ---------------------------------------------------------------------------
// 纯辅助
// ---------------------------------------------------------------------------

/** 是否为「普通对象」（非 null、非数组的对象）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 是否为字符串数组（数组且每个元素均为 `string`）。 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** 将字符串数组渲染为带项目符号的多行文本；空数组返回占位提示。 */
function renderBulletList(items: readonly string[], emptyHint: string): string {
  if (items.length === 0) {
    return emptyHint;
  }
  return items.map((item) => `- ${item}`).join('\n');
}

/**
 * 从文本中提取「首个 `{` 到与之平衡的 `}`」之间的子串（含两端花括号）。
 *
 * 与 `blueprintParser.ts` 的同名逻辑一致：从首个 `{` 起逐字符扫描，用计数器追踪
 * 花括号嵌套深度，深度归零处即为与首个 `{` 平衡的 `}`；正确跳过字符串字面量内部
 * 的花括号与转义符。模型常在 JSON 前后夹带说明文字，故需先做平衡提取再解析。
 *
 * @returns 平衡的 JSON 对象子串；不存在 `{` 或找不到与之平衡的 `}` 时返回 `undefined`。
 */
function extractFirstBalancedJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return undefined;
}

/**
 * 收集单个剧情点结果对象的字段缺失 / 类型 / 枚举非法项（需求 10.2 / 校验）。
 */
function collectPlotPointErrors(
  value: unknown,
  index: number,
  errors: string[],
): void {
  const prefix = `plotPoints[${index}]`;

  if (!isPlainObject(value)) {
    errors.push(`${prefix}（应为对象）`);
    return;
  }

  if (typeof value.point !== 'string') {
    errors.push(`${prefix}.point`);
  }
  if (!PLOT_POINT_STATUSES.includes(value.status as PlotPointStatus)) {
    errors.push(`${prefix}.status（应为 completed/partial/missing 之一）`);
  }
}

/**
 * 收集单个场景节奏问题对象的字段缺失 / 类型 / 枚举非法项（需求 10.4 / 校验）。
 */
function collectSceneIssueErrors(
  value: unknown,
  index: number,
  errors: string[],
): void {
  const prefix = `sceneIssues[${index}]`;

  if (!isPlainObject(value)) {
    errors.push(`${prefix}（应为对象）`);
    return;
  }

  if (typeof value.sceneId !== 'string') {
    errors.push(`${prefix}.sceneId`);
  }
  if (typeof value.issue !== 'string') {
    errors.push(`${prefix}.issue`);
  }
  if (typeof value.suggestion !== 'string') {
    errors.push(`${prefix}.suggestion`);
  }
  if (!PACING_PRIORITIES.includes(value.priority as PacingPriority)) {
    errors.push(`${prefix}.priority（应为 high/medium/low 之一）`);
  }
}

// ---------------------------------------------------------------------------
// Prompt 组装（纯函数）
// ---------------------------------------------------------------------------

/** 节奏检查 system 消息：要求模型扮演节奏编辑并严格输出结构化 JSON（需求 10.2/10.4）。 */
function buildPacingSystemContent(): string {
  return [
    '你是一名专业的小说节奏编辑。',
    '请依据给定章节蓝图的节奏要求（pacing）、情绪曲线（emotional_curve）、必含剧情点',
    '（required_plot_points）与禁止事项（forbidden_points），检查整章正文的节奏与剧情完成情况。',
    '',
    '请严格以合法 JSON 输出检查结果，结构如下：',
    '{',
    '  "plotPoints": [ { "point": "对应一条必含剧情点", "status": "completed | partial | missing" } ],',
    '  "violatedForbiddenPoints": [ "被违反的禁止事项原文" ],',
    '  "sceneIssues": [ { "sceneId": "场景标识符", "issue": "节奏问题描述", "suggestion": "修改建议", "priority": "high | medium | low" } ]',
    '}',
    '',
    '输出规则：',
    '- 必须为每一条 required_plot_points 在 plotPoints 中给出且仅给出一条对应结果，',
    '  status 取值必须为 completed（已完成）、partial（部分完成）或 missing（未完成）之一。',
    '- violatedForbiddenPoints 仅列出正文中确实违反的禁止事项；若无则为空数组 []。',
    '- sceneIssues 按场景给出节奏问题、修改建议与修改优先级，',
    '  priority 取值必须为 high（高）、medium（中）或 low（低）之一；若无问题则为空数组 []。',
    '- sceneId 必须取自下方蓝图所列的场景标识符。',
    '- 必须输出合法 JSON，不要输出除 JSON 之外的多余解释文字。',
  ].join('\n');
}

/**
 * 组装节奏检查的对话消息序列（需求 10.1, 10.2, 10.3, 10.4）。
 *
 * 纯函数：相同输入恒产生相同输出，不读取 / 修改任何外部状态。user 消息纳入蓝图的
 * pacing、emotional_curve、required_plot_points、forbidden_points、场景标识清单与
 * 整章正文，使节奏检查依据与待检正文均作为子串出现在消息中（需求 10.1）。
 *
 * @param blueprint 章节蓝图（{@link ChapterBlueprint} 或等价的 {@link BlueprintCore}）。
 * @param chapterContent 整章正文（合并后的章节 content）；允许为空字符串。
 */
export function buildPacingPrompt(
  blueprint: ChapterBlueprint | BlueprintCore,
  chapterContent: string,
): ChatMessage[] {
  const sceneList =
    blueprint.scenes.length === 0
      ? '（无场景）'
      : blueprint.scenes
          .map((scene) => `- ${scene.scene_id}：${scene.name}`)
          .join('\n');

  const userContent = [
    '【章节节奏要求（pacing）】',
    blueprint.pacing,
    '',
    '【情绪曲线（emotional_curve）】',
    blueprint.emotional_curve,
    '',
    '【必含剧情点（required_plot_points）】',
    renderBulletList(blueprint.required_plot_points, '（无必含剧情点）'),
    '',
    '【禁止事项（forbidden_points）】',
    renderBulletList(blueprint.forbidden_points, '（无禁止事项）'),
    '',
    '【场景标识清单】',
    sceneList,
    '',
    '【整章正文】',
    chapterContent.length > 0 ? chapterContent : '（正文为空）',
    '',
    '请据此检查节奏并按上述结构输出节奏检查报告 JSON。',
  ].join('\n');

  return [
    { role: 'system', content: buildPacingSystemContent() },
    { role: 'user', content: userContent },
  ];
}

// ---------------------------------------------------------------------------
// 解析（纯函数）
// ---------------------------------------------------------------------------

/** 节奏检查报告的主体（不含服务层注入的元数据 chapterId / generatedAt）。 */
type PacingReportBody = Pick<
  PacingReport,
  'plotPoints' | 'violatedForbiddenPoints' | 'sceneIssues'
>;

/**
 * 从可能夹带额外说明文字的模型输出中提取并解析节奏检查报告（需求 10.2/10.3/10.4）。
 *
 * 纯函数。流程：
 * 1. 提取首个平衡 JSON 对象子串；取不到 → 抛出 `VALIDATION_ERROR`。
 * 2. `JSON.parse`；解析抛错或顶层非对象 → 抛出 `VALIDATION_ERROR`。
 * 3. 校验 plotPoints / violatedForbiddenPoints / sceneIssues 的字段、类型与枚举值
 *    （status ∈ {completed,partial,missing}、priority ∈ {high,medium,low}）；
 *    存在缺失 / 类型非法 / 枚举非法 → 抛出 `VALIDATION_ERROR` 并列出问题字段。
 * 4. 仅保留 schema 内字段重建 {@link PacingReportBody} 返回（丢弃多余字段）。
 *
 * @throws {ServiceError} `VALIDATION_ERROR`：无法定位 / 解析合法 JSON，或字段 /
 *   类型 / 枚举非法。
 */
function parsePacingReportFromText(text: string): PacingReportBody {
  const jsonText = extractFirstBalancedJsonObject(text);
  if (jsonText === undefined) {
    throw ServiceError.validation(
      '节奏检查报告解析失败：未能在文本中定位到平衡的 JSON 对象（缺少 “{” 或与之匹配的 “}”）',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (firstError) {
    // 二次尝试：修复 LLM 常见的不合法之处（字符串内裸控制字符、尾随逗号）后再解析。
    try {
      parsed = JSON.parse(repairLooseJson(jsonText));
    } catch {
      const reason =
        firstError instanceof Error ? firstError.message : String(firstError);
      throw ServiceError.validation(
        `节奏检查报告解析失败：提取到的片段不是合法 JSON（${reason}）`,
      );
    }
  }

  if (!isPlainObject(parsed)) {
    throw ServiceError.validation('节奏检查报告解析失败：JSON 顶层不是对象');
  }

  const errors: string[] = [];

  // —— plotPoints：必须为数组，逐项校验字段与 status 枚举（需求 10.2） ——
  const rawPlotPoints = parsed.plotPoints;
  if (!Array.isArray(rawPlotPoints)) {
    errors.push('plotPoints');
  } else {
    rawPlotPoints.forEach((item, index) => {
      collectPlotPointErrors(item, index, errors);
    });
  }

  // —— violatedForbiddenPoints：必须为字符串数组（需求 10.3） ——
  if (!isStringArray(parsed.violatedForbiddenPoints)) {
    errors.push('violatedForbiddenPoints');
  }

  // —— sceneIssues：必须为数组，逐项校验字段与 priority 枚举（需求 10.4） ——
  const rawSceneIssues = parsed.sceneIssues;
  if (!Array.isArray(rawSceneIssues)) {
    errors.push('sceneIssues');
  } else {
    rawSceneIssues.forEach((item, index) => {
      collectSceneIssueErrors(item, index, errors);
    });
  }

  if (errors.length > 0) {
    throw ServiceError.validation(
      `节奏检查报告字段缺失或取值非法：${errors.join('、')}`,
    );
  }

  // 校验通过：仅保留 schema 内字段重建，丢弃多余字段。
  const plotPoints: PlotPointResult[] = (
    rawPlotPoints as Record<string, unknown>[]
  ).map((item) => ({
    point: item.point as string,
    status: item.status as PlotPointStatus,
  }));

  const sceneIssues: ScenePacingIssue[] = (
    rawSceneIssues as Record<string, unknown>[]
  ).map((item) => ({
    sceneId: item.sceneId as string,
    issue: item.issue as string,
    suggestion: item.suggestion as string,
    priority: item.priority as PacingPriority,
  }));

  return {
    plotPoints,
    violatedForbiddenPoints: parsed.violatedForbiddenPoints as string[],
    sceneIssues,
  };
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class PacingChecker {
  /**
   * @param store 持久化抽象，用于加载章节蓝图、整章正文并持久化节奏检查报告。
   * @param modelConfigService 模型配置服务，提供内部完整配置（含 API Key）。
   * @param modelProxy 模型代理，向 OpenAI 兼容提供商发起流式补全。
   */
  constructor(
    private readonly store: DataStore,
    private readonly modelConfigService: ModelConfigService,
    private readonly modelProxy: ModelProxy,
  ) {}

  /**
   * 执行一次节奏检查并返回（同时持久化）报告（需求 10）。
   *
   * 步骤顺序至关重要：
   * 1. 模型配置存在性检查 —— 必须先于任何提供商调用（需求 10.6）；缺失 →
   *    `MODEL_NOT_CONFIGURED`，绝不触达 {@link ModelProxy}。
   * 2. 读取该章节蓝图；缺失 → `NOT_FOUND`。
   * 3. 读取整章正文（合并后写入章节 `content`）；为空也继续（需求 10.1）。
   * 4. {@link buildPacingPrompt} 组装消息 → 经 {@link ModelProxy.streamCompletion}
   *    聚合为完整文本 → {@link parsePacingReportFromText} 解析（失败抛
   *    `VALIDATION_ERROR`，需求 10.2/10.3/10.4）。
   * 5. 注入元数据（`chapterId`、`generatedAt`）拼成完整报告，upsert 持久化
   *    （每章至多一份，需求 10.5），返回该报告。
   *
   * @param chapterId 目标章节标识符（数据存储主键）。
   * @returns 完整的节奏检查报告。
   * @throws {ServiceError} `MODEL_NOT_CONFIGURED`（未配置模型）、`NOT_FOUND`
   *   （章节蓝图不存在）或 `VALIDATION_ERROR`（模型输出解析 / 校验失败）。
   * @throws {import('../../proxy/ProxyError.js').ProxyError} 模型提供商错误 / 超时
   *   （向上透传，由路由层映射为 `PROVIDER_ERROR`）。
   */
  async check(chapterId: Id): Promise<PacingReport> {
    // 1) 模型配置存在性检查 —— 必须先于任何提供商调用（需求 10.6）。
    const config = await this.modelConfigService.getInternalConfig();
    if (config === undefined) {
      throw ServiceError.modelNotConfigured(
        '尚未配置模型，请先在设置中填写 base URL、API Key 与模型名称。',
      );
    }

    // 2) 读取章节蓝图（节奏检查依据）；缺失 → NOT_FOUND。
    const blueprint = await this.store.getChapterBlueprintByChapter(chapterId);
    if (!blueprint) {
      throw ServiceError.notFound(`章节蓝图不存在：${chapterId}`);
    }

    // 3) 读取整章正文（合并后写入章节 content）；为空也继续（需求 10.1）。
    const chapter = await this.store.getChapter(chapterId);
    const chapterContent = chapter?.content ?? '';

    // 4) 组装消息 → 聚合流式输出 → 解析为报告主体。
    //    模型错误 / 超时由 ModelProxy 抛出 ProxyError，向上透传（PROVIDER_ERROR）。
    const messages = buildPacingPrompt(blueprint, chapterContent);
    const controller = new AbortController();
    const fullText = await this.collectStream(
      this.modelProxy.streamCompletion(config, messages, controller.signal, {
        jsonMode: true,
      }),
    );
    const body = parsePacingReportFromText(fullText);

    // 5) 注入元数据，拼成完整报告并 upsert 持久化（需求 10.5），返回。
    const report: PacingReport = {
      ...body,
      chapterId,
      generatedAt: new Date().toISOString(),
    };

    return this.store.savePacingReport(report);
  }

  /**
   * 读取某章节最新已持久化的节奏检查报告（需求 13.3）。
   *
   * 尚无已持久化报告 → 抛出 `NOT_FOUND`（需求 13.5）。
   *
   * @param chapterId 目标章节标识符（数据存储主键）。
   * @returns 该章节最新已持久化的节奏检查报告。
   * @throws {ServiceError} `NOT_FOUND`（无节奏检查报告）。
   */
  async getReport(chapterId: Id): Promise<PacingReport> {
    const report = await this.store.getPacingReportByChapter(chapterId);
    if (!report) {
      throw ServiceError.notFound(`节奏检查报告不存在：${chapterId}`);
    }
    return report;
  }

  /**
   * 将模型代理产出的文本增量序列聚合为完整字符串。
   *
   * 以 `for await` 逐段累加；提供商错误 / 超时时 {@link ModelProxy} 会抛出
   * `ProxyError`，本助手不做转换、直接向上透传。聚合结果与抛出的错误均不含 API Key。
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
