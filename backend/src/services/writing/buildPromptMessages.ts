/**
 * WritingService 上下文组装（纯逻辑）。
 *
 * `buildPromptMessages` 是一个纯函数（无 IO、无副作用），将一次写作请求的
 * 输入上下文组装为发送给模型代理的 {@link ChatMessage} 序列。设计为纯函数
 * 以便独立做属性测试（design.md「WritingService：上下文组装」）。
 *
 * 组装规则（design.md）：
 * - 若存在附加设定（attachedSettings 非空），在最前面放置一条 `system` 消息，
 *   其内容包含每一条设定的标题与正文（Property 22：每条设定的正文都出现在上下文中）。
 * - 按顺序展开会话历史 sessionHistory，保留先前用户指令与模型响应的角色与内容
 *   （Property 23：历史按原顺序保留于上下文）。
 * - 最后追加一条 `user` 消息：
 *   - `continue`（续写）：内容同时包含章节现有正文与用户指令（Property 19）。
 *   - `rewrite`/`polish`（改写/润色）：内容同时包含选定文本与用户指令（Property 20）。
 */

import type {
  ChatMessage,
  SettingSnippet,
  WritingContextInput,
} from '../../types/index.js';

/** 设定类型到中文标签的映射，用于在 system 消息中标注设定来源。 */
const SETTING_KIND_LABEL: Record<SettingSnippet['kind'], string> = {
  character: '人物',
  world: '世界观',
  outline: '大纲',
};

/**
 * 稳定基础 system prompt——无论是否有附加设定都会出现在消息序列最前面，
 * 确保 DeepSeek V4 Pro prefix caching 始终从相同 token 前缀开始匹配。
 */
const BASE_SYSTEM_PROMPT =
  '你是一名专业的小说写作 Agent，能够处理不同文化、时代和类型的长篇叙事。\n' +
  '用户明确给出的题材、时代、地域、文化、人物身份和禁忌是最高优先级硬约束。\n' +
  '不得用熟悉的校园、都市、修仙或其他模板替换用户指定的核心类型。\n' +
  '保持人物动机、连续性与因果链清晰，对话自然，描写和节奏服从当前项目风格。\n' +
  '只输出要求的正文内容，不要输出额外说明。';

/**
 * 将单条设定快照渲染为文本片段。包含类型标签、标题与正文，
 * 确保正文（body）作为子串出现在最终内容中（Property 22）。
 */
function renderSettingSnippet(snippet: SettingSnippet): string {
  const label = SETTING_KIND_LABEL[snippet.kind];
  return `【${label}】${snippet.title}\n${snippet.body}`;
}

function sortSettingSnippets(snippets: readonly SettingSnippet[]): SettingSnippet[] {
  return [...snippets].sort((a, b) => {
    const kindOrder = a.kind.localeCompare(b.kind);
    if (kindOrder !== 0) return kindOrder;
    const titleOrder = a.title.localeCompare(b.title);
    if (titleOrder !== 0) return titleOrder;
    return a.body.localeCompare(b.body);
  });
}

/**
 * 构造 system 消息内容：包含全部附加设定的标题与正文。
 */
function buildSystemContent(attachedSettings: SettingSnippet[]): string {
  const header = '以下是本项目的稳定设定，写作时必须保持一致：';
  const rendered = sortSettingSnippets(attachedSettings).map(renderSettingSnippet).join('\n\n');
  return `${header}\n\n${rendered}`;
}

/**
 * 构造最终 user 消息内容：
 * - continue：包含章节现有正文 + 指令。
 * - rewrite/polish：包含选定文本 + 指令。
 */
function buildUserContent(input: WritingContextInput): string {
  const { operation, instruction, chapterContent, selectedText } = input;

  if (operation === 'continue') {
    return [
      '【当前章节正文】',
      chapterContent,
      '',
      '【续写指令】',
      instruction,
    ].join('\n');
  }

  // rewrite / polish
  const opLabel = operation === 'rewrite' ? '改写' : '润色';
  return [
    '【选定文本】',
    selectedText ?? '',
    '',
    `【${opLabel}指令】`,
    instruction,
  ].join('\n');
}

/**
 * 将写作上下文输入组装为模型对话消息序列。
 *
 * 纯函数：相同输入恒产生相同输出，不读取/修改任何外部状态。
 */
export function buildPromptMessages(
  input: WritingContextInput,
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // 1) ALWAYS emit a system message for stable prefix caching.
  //    If attachedSettings exist, append them after the base prompt.
  if (input.attachedSettings.length > 0) {
    messages.push({
      role: 'system',
      content: BASE_SYSTEM_PROMPT + '\n\n' + buildSystemContent(input.attachedSettings),
    });
  } else {
    messages.push({
      role: 'system',
      content: BASE_SYSTEM_PROMPT,
    });
  }

  // 2) 按原顺序展开会话历史，保留角色与内容。
  for (const turn of input.sessionHistory) {
    messages.push({ role: turn.role, content: turn.content });
  }

  // 3) 追加本次写作的 user 消息（动态内容，放在最后）。
  messages.push({ role: 'user', content: buildUserContent(input) });

  return messages;
}
