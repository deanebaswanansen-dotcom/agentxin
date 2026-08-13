/**
 * 章节蓝图模块的 Prompt 组装（纯逻辑）。
 *
 * 本模块提供四个纯函数（无 IO、无副作用，相同输入恒产生相同输出），仿照既有
 * `services/writing/buildPromptMessages.ts` 的风格，将「已解析好的上下文」组装为
 * 发送给模型代理的 {@link ChatMessage} 序列。设计为纯函数以便独立做属性测试
 * （design.md「纯函数：Prompt 组装」）：
 *
 * - {@link buildBlueprintPrompt}：章节蓝图生成提示词，注入项目大纲/人物/世界观 +
 *   章节需求 + 目标字数，并要求模型输出严格符合字段要求的 JSON（需求 2.1, 2.2,
 *   2.3, 2.4）。
 * - {@link buildScenePrompt}：分场景写作提示词，注入场景 target_words/purpose/
 *   must_include/ending_state + 出场角色设定 +（若有）上一场景正文（需求 6.1,
 *   6.2, 6.3）。
 * - {@link buildExpandPrompt}：场景扩写提示词，注入当前正文 + 蓝图约束，并要求
 *   保留关键剧情、维持走向、不新增重大设定，扩写后目标实际字数 = 当前实际字数 +
 *   扩写字数（需求 11.4）。
 * - {@link buildRewritePrompt}：场景重写提示词，注入当前正文 + 蓝图约束 + 用户
 *   修改要求，并要求保留 purpose 与 must_include 承担的剧情功能、维持相邻场景
 *   衔接（需求 12.1, 12.2）。
 *
 * 可测试性约定（属性测试核心）：各构造函数把关键约束（如场景 purpose、
 * must_include 各项、ending_state、出场角色设定、上一场景正文、目标字数等）确保
 * 作为子串出现在某条消息的 content 中，便于以「子串包含」断言验证。
 */

import type { BlueprintCore, ChatMessage, Scene } from '../../types/index.js';

// ---------------------------------------------------------------------------
// 入参接口（字段为「已解析好的上下文」，由服务层从数据存储读取并整理后传入）
// ---------------------------------------------------------------------------

/** 大纲上下文片段：标题 + 内容。 */
export interface OutlineContext {
  title: string;
  content: string;
}

/** 世界观上下文片段：标题 + 内容。 */
export interface WorldSettingContext {
  title: string;
  content: string;
}

/** 人物上下文片段：名称 + 设定描述。 */
export interface CharacterContext {
  name: string;
  description: string;
}

/** 蓝图生成提示词入参（需求 2.1, 2.2）。 */
export interface BlueprintPromptInput {
  requirement: string; // 章节需求文本（标准模板或单句简化形式）
  targetWords: number; // 章节目标字数
  outlines: OutlineContext[]; // 项目大纲（缺失则空集合）
  characters: CharacterContext[]; // 项目人物（缺失则空集合）
  worldSettings: WorldSettingContext[]; // 项目世界观（缺失则空集合）
}

/** 场景写作提示词入参（需求 6.1, 6.2, 6.3）。 */
export interface ScenePromptInput {
  blueprint: BlueprintCore; // 章节蓝图（提供章节级背景约束）
  scene: Scene; // 目标场景蓝图
  characters: CharacterContext[]; // 该场景出场角色设定
  previousSceneContent?: string; // 上一场景已持久化正文（若存在）
}

/** 场景扩写提示词入参（需求 11.4）。 */
export interface ExpandPromptInput {
  blueprint: BlueprintCore; // 章节蓝图（提供章节级背景约束）
  scene: Scene; // 目标场景蓝图
  currentContent: string; // 该场景当前正文
  addWords: number; // 期望新增字数
}

/** 场景重写提示词入参（需求 12.1, 12.2）。 */
export interface RewritePromptInput {
  blueprint: BlueprintCore; // 章节蓝图（提供章节级背景约束）
  scene: Scene; // 目标场景蓝图
  currentContent: string; // 该场景当前正文
  instruction: string; // 用户修改要求
}

// ---------------------------------------------------------------------------
// 内部纯辅助（无导出）
// ---------------------------------------------------------------------------

/**
 * 实际字数 = 去除全部空白字符（含空格、制表、换行及 Unicode 空白）后的码点数量。
 * 用于扩写提示词计算「当前实际字数」，与术语表 ActualWordCount 口径一致（需求 9.1）。
 */
function countActualWords(text: string): number {
  return [...text.replace(/\s+/gu, '')].length;
}

/** 将字符串数组渲染为带项目符号的多行文本；空数组返回占位提示。 */
function renderBulletList(items: readonly string[], emptyHint: string): string {
  if (items.length === 0) {
    return emptyHint;
  }
  return items.map((item) => `- ${item}`).join('\n');
}

/** 将人物设定渲染为文本：包含每个出场角色的名称与设定描述（需求 6.2）。 */
function renderCharacters(
  characters: readonly CharacterContext[],
  emptyHint: string,
): string {
  if (characters.length === 0) {
    return emptyHint;
  }
  return characters
    .map((c) => `【角色】${c.name}\n${c.description}`)
    .join('\n\n');
}

/** 将「标题 + 内容」型设定片段渲染为文本（用于大纲 / 世界观）。 */
function renderTitledSnippets(
  label: string,
  snippets: readonly { title: string; content: string }[],
  emptyHint: string,
): string {
  if (snippets.length === 0) {
    return emptyHint;
  }
  return snippets
    .map((s) => `【${label}】${s.title}\n${s.content}`)
    .join('\n\n');
}

function renderChapterCacheContext(blueprint: BlueprintCore): string {
  return [
    `标题：${blueprint.title}`,
    `章节主目标（main_goal）：${blueprint.main_goal}`,
    `整体基调（tone）：${blueprint.tone}`,
    `章节节奏要求（pacing）：${blueprint.pacing}`,
    `情绪曲线（emotional_curve）：${blueprint.emotional_curve}`,
    '必含剧情点（required_plot_points）：',
    renderBulletList(blueprint.required_plot_points, '（无）'),
    '禁止事项（forbidden_points）：',
    renderBulletList(blueprint.forbidden_points, '（无）'),
    `章末钩子（ending_hook）：${blueprint.ending_hook}`,
  ].join('\n');
}

/**
 * 渲染目标场景的蓝图约束文本：场景目标字数、目的、必含要点各项与结束状态。
 * 供写作 / 扩写 / 重写共享，确保关键约束作为子串出现在消息中（需求 6.1, 12.2）。
 */
function renderSceneConstraints(scene: Scene): string {
  return [
    `场景名称：${scene.name}`,
    `目标字数（target_words）：${scene.target_words}`,
    `地点（location）：${scene.location}`,
    `场景目的（purpose）：${scene.purpose}`,
    `情绪基调（emotion）：${scene.emotion}`,
    `节奏要求（pacing）：${scene.pacing}`,
    '必含要点（must_include）：',
    renderBulletList(scene.must_include, '（无）'),
    `结束状态（ending_state）：${scene.ending_state}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 1) 蓝图生成提示词（需求 2.1, 2.2, 2.3, 2.4）
// ---------------------------------------------------------------------------

/** 蓝图生成 system 消息：要求模型扮演章节结构编辑并输出严格合法的蓝图 JSON。 */
function buildBlueprintSystemContent(): string {
  return [
    '你是一名专业的小说章节结构编辑。',
    '请依据用户提供的项目设定与章节需求，生成一份结构化的「章节蓝图」，并严格以合法 JSON 输出。',
    '',
    '章节蓝图必须包含以下章节级字段：',
    '- chapter_id：章节标识符（字符串）',
    '- title：章节标题',
    '- target_words：章节目标字数（正整数）',
    '- main_goal：章节主目标',
    '- tone：整体基调',
    '- pacing：章节节奏要求',
    '- required_plot_points：必含剧情点（字符串数组）',
    '- forbidden_points：禁止事项（字符串数组）',
    '- emotional_curve：情绪曲线',
    '- scenes：场景数组（每个元素为一个场景对象）',
    '- ending_hook：章末钩子',
    '',
    '每个场景（scenes 中的元素）必须包含以下场景级字段：',
    '- scene_id：场景标识符（在本章节蓝图内唯一）',
    '- name：场景名称',
    '- target_words：场景目标字数（正整数）',
    '- location：地点',
    '- characters：出场角色（字符串数组，与项目人物名称对应）',
    '- purpose：场景目的',
    '- emotion：情绪基调',
    '- pacing：节奏要求',
    '- must_include：必含要点（字符串数组）',
    '- ending_state：结束状态',
    '',
    '生成规则：',
    '- 场景数量必须为 3 到 7 个。',
    '- 各场景 target_words 之和应尽量接近章节 target_words（偏差比例不超过 0.1）。',
    '- 不要新增重大设定，应在用户提供的大纲、人物与世界观范围内规划。',
    '- 必须输出合法 JSON，不要输出除 JSON 之外的多余解释文字。',
  ].join('\n');
}

/**
 * 组装章节蓝图生成的对话消息序列。
 *
 * 纯函数：相同输入恒产生相同输出，不读取 / 修改任何外部状态。
 * user 消息纳入项目大纲 / 人物 / 世界观上下文、章节需求文本与目标字数（需求 2.1, 2.2）。
 */
export function buildBlueprintPrompt(input: BlueprintPromptInput): ChatMessage[] {
  const { requirement, targetWords, outlines, characters, worldSettings } =
    input;

  const userContent = [
    '【项目大纲】',
    renderTitledSnippets('大纲', outlines, '（无大纲）'),
    '',
    '【项目人物】',
    renderCharacters(characters, '（无人物设定）'),
    '',
    '【项目世界观】',
    renderTitledSnippets('世界观', worldSettings, '（无世界观设定）'),
    '',
    '【章节需求】',
    requirement,
    '',
    '【章节目标字数】',
    `${targetWords}`,
    '',
    '请据此生成符合上述字段要求的章节蓝图 JSON。',
  ].join('\n');

  return [
    { role: 'system', content: buildBlueprintSystemContent() },
    { role: 'user', content: userContent },
  ];
}

// ---------------------------------------------------------------------------
// 2) 分场景写作提示词（需求 6.1, 6.2, 6.3）
// ---------------------------------------------------------------------------

/** 场景写作 system 消息：要求模型依据场景蓝图约束写作正文。 */
function buildSceneSystemContent(): string {
  return [
    '你是一名专业的小说写作助手。',
    '请依据给定的章节背景与单个场景的蓝图约束，写出该场景的正文。',
    '写作要求：',
    '- 严格围绕场景目的（purpose）与必含要点（must_include）展开。',
    '- 场景结尾需达到指定的结束状态（ending_state）。',
    '- 正文实际字数应尽量接近场景目标字数（target_words）。',
    '- 字数按去除空格与换行后的可见字符计数，控制在 target_words 的 90%-110%；达到上限前自然收束并立即停止。',
    '- 保持与已给出的出场角色设定一致；如有上一场景正文，需与其自然衔接。',
    '- 只输出场景正文，不要输出额外说明。',
  ].join('\n');
}

/**
 * 组装分场景写作的对话消息序列。
 *
 * 纯函数。user 消息纳入场景 target_words/purpose/must_include/ending_state、
 * 出场角色设定（需求 6.2）以及（若存在）上一场景正文（需求 6.3）；上述关键约束
 * 均作为子串出现在消息内容中，便于属性测试断言。
 */
export function buildScenePrompt(input: ScenePromptInput): ChatMessage[] {
  const { blueprint, scene, characters, previousSceneContent } = input;

  const parts: string[] = [
    '【稳定章节缓存前缀】',
    renderChapterCacheContext(blueprint),
    '',
    '【场景蓝图约束】',
    renderSceneConstraints(scene),
    '',
    '【出场角色设定】',
    renderCharacters(characters, '（无出场角色设定）'),
  ];

  // 上一场景正文（仅当存在时纳入，需求 6.3）。
  if (previousSceneContent !== undefined && previousSceneContent.length > 0) {
    parts.push(
      '',
      '【上一场景正文（用于衔接）】',
      previousSceneContent,
    );
  }

  parts.push('', '请据此写出本场景的正文。');

  return [
    { role: 'system', content: buildSceneSystemContent() },
    { role: 'user', content: parts.join('\n') },
  ];
}

// ---------------------------------------------------------------------------
// 3) 场景扩写提示词（需求 11.4）
// ---------------------------------------------------------------------------

/** 扩写 system 消息：要求在保留剧情的前提下扩写至目标字数。 */
function buildExpandSystemContent(): string {
  return [
    '你是一名专业的小说写作助手，正在对一个已写好的场景做扩写。',
    '扩写要求：',
    '- 保留该场景既有的关键剧情。',
    '- 维持原有剧情走向，不改变事件结果与因果。',
    '- 避免新增重大设定。',
    '- 在现有正文基础上扩充细节、描写与节奏，使内容更充实。',
    '- 只输出扩写后的完整场景正文，不要输出额外说明。',
  ].join('\n');
}

/**
 * 组装场景扩写的对话消息序列。
 *
 * 纯函数。消息纳入当前正文与蓝图约束，并明确要求扩写后实际字数达到
 * 「当前实际字数 + 扩写字数」（需求 11.4）。当前实际字数由 currentContent
 * 去除空白字符后的码点数得出（与字数统计口径一致）。
 */
export function buildExpandPrompt(input: ExpandPromptInput): ChatMessage[] {
  const { blueprint, scene, currentContent, addWords } = input;

  const currentActualWords = countActualWords(currentContent);
  const targetActualWords = currentActualWords + addWords;

  const userContent = [
    '【稳定章节缓存前缀】',
    renderChapterCacheContext(blueprint),
    '',
    '【场景蓝图约束】',
    renderSceneConstraints(scene),
    '',
    '【当前场景正文】',
    currentContent,
    '',
    '【扩写要求】',
    `当前正文实际字数约为 ${currentActualWords} 字，期望新增 ${addWords} 字。`,
    `请在保留既有关键剧情、维持原有剧情走向、不新增重大设定的前提下扩写，` +
      `使扩写后场景正文的实际字数达到约 ${targetActualWords} 字（当前实际字数 + 扩写字数）。`,
  ].join('\n');

  return [
    { role: 'system', content: buildExpandSystemContent() },
    { role: 'user', content: userContent },
  ];
}

// ---------------------------------------------------------------------------
// 4) 场景重写提示词（需求 12.1, 12.2）
// ---------------------------------------------------------------------------

/** 重写 system 消息：要求保留剧情功能并维持衔接。 */
function buildRewriteSystemContent(): string {
  return [
    '你是一名专业的小说写作助手，正在依据用户的修改要求重写一个场景。',
    '重写要求：',
    '- 保留该场景在蓝图中承担的剧情功能（即 purpose 与 must_include 所要求的内容）。',
    '- 维持与相邻场景的衔接，不破坏整章结构。',
    '- 在满足用户修改要求的同时，仅对本场景做局部重写。',
    '- 只输出重写后的完整场景正文，不要输出额外说明。',
  ].join('\n');
}

/**
 * 组装场景重写的对话消息序列。
 *
 * 纯函数。消息纳入当前正文、蓝图约束（含 purpose 与 must_include）与用户修改
 * 要求，并要求保留 purpose 与 must_include 承担的剧情功能、维持相邻场景衔接
 * （需求 12.1, 12.2）。
 */
export function buildRewritePrompt(input: RewritePromptInput): ChatMessage[] {
  const { blueprint, scene, currentContent, instruction } = input;

  const userContent = [
    '【稳定章节缓存前缀】',
    renderChapterCacheContext(blueprint),
    '',
    '【场景蓝图约束】',
    renderSceneConstraints(scene),
    '',
    '【当前场景正文】',
    currentContent,
    '',
    '【用户修改要求】',
    instruction,
    '',
    '【重写要求】',
    `请在满足上述修改要求的同时，保留本场景的剧情功能：` +
      `场景目的（purpose）「${scene.purpose}」与下列必含要点（must_include），并维持与相邻场景的衔接。`,
    renderBulletList(scene.must_include, '（无必含要点）'),
  ].join('\n');

  return [
    { role: 'system', content: buildRewriteSystemContent() },
    { role: 'user', content: userContent },
  ];
}
