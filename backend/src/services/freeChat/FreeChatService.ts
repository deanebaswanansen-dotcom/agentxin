/**
 * FreeChatService — 自由对话编排。
 *
 * 让用户与 AI 就小说创作相关话题进行自由讨论。服务层编排流程：
 * 1. 模型配置存在性检查。
 * 2. （可选）加载附加设定条目 / 章节内容作为上下文。
 * 3. 根据 context 字段选取系统提示词。
 * 4. 构建消息数组并调用 ModelProxy 流式接口。
 */
import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type { StreamDelta } from '../../proxy/sseParser.js';
import type { DataStore } from '../../store/DataStore.js';
import type {
  ChatMessage,
  FreeChatRequestBody,
  Id,
} from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';

/** 按 context 字段选取的系统提示词映射。 */
const SYSTEM_PROMPTS: Record<string, string> = {
  plot: '你是一名资深小说编辑和剧情策划专家。根据用户提供的设定和大纲，就剧情走向、情节安排、冲突设计等问题提供专业建议。',
  character:
    '你是一名角色塑造专家。根据用户提供的人物设定，就角色性格、动机、成长弧、人物关系等问题提供专业建议。',
  world: '你是一名世界观设计师。根据用户提供的世界观设定，就背景设定、规则体系、势力分布等问题提供专业建议。',
  writing:
    '你是一名创意写作导师。就写作技巧、文笔提升、节奏控制、叙述视角等问题提供专业建议。',
};

const DEFAULT_SYSTEM_PROMPT =
  '你是一名资深小说创作顾问。根据用户提供的项目资料，就小说创作的任何问题提供专业建议和讨论。';

/** 会话历史只保留最近若干轮 user/assistant，避免注入过长或 system 角色。 */
const MAX_SESSION_HISTORY_TURNS = 40;

export class FreeChatService {
  constructor(
    private readonly store: DataStore,
    private readonly modelConfigService: ModelConfigService,
    private readonly modelProxy: ModelProxy,
  ) {}

  /**
   * 编排一次自由对话请求并返回提供商增量文本的异步可迭代序列。
   */
  async streamChat(
    projectId: Id,
    body: FreeChatRequestBody,
    signal: AbortSignal,
  ): Promise<AsyncIterable<StreamDelta>> {
    const project = await this.store.getProject(projectId);
    if (!project) {
      throw ServiceError.notFound(`项目不存在：${projectId}`);
    }

    // 1) 模型配置存在性检查
    const config = await this.modelConfigService.getInternalConfig();
    if (config === undefined) {
      throw ServiceError.modelNotConfigured(
        '尚未配置模型，请先在设置中填写 base URL、API Key 与模型名称。',
      );
    }

    // 2) 构建附加上下文片段
    const contextSnippets: string[] = [];

    // 加载附加设定条目
    if (body.attachedSettingIds && body.attachedSettingIds.length > 0) {
      const snippets = await this.resolveSettings(projectId, body.attachedSettingIds);
      if (snippets.length > 0) {
        contextSnippets.push('【相关设定资料】\n' + snippets.join('\n---\n'));
      }
    }

    // 加载章节内容（必须属于当前项目，避免跨项目读正文）
    if (body.chapterId) {
      const chapter = await this.store.getChapter(body.chapterId);
      if (!chapter || chapter.projectId !== projectId) {
        throw ServiceError.notFound(`章节不存在：${body.chapterId}`);
      }
      if (chapter.content) {
        contextSnippets.push(
          `【当前章节：${chapter.title}】\n${chapter.content}`,
        );
      }
    }

    // 3) 选取系统提示词
    const basePrompt =
      body.context && SYSTEM_PROMPTS[body.context]
        ? SYSTEM_PROMPTS[body.context]
        : DEFAULT_SYSTEM_PROMPT;

    const systemContent =
      contextSnippets.length > 0
        ? `${basePrompt}\n\n以下是用户提供的项目资料，请在回答时参考：\n\n${contextSnippets.join('\n\n')}`
        : basePrompt;

    // 4) 构建消息数组
    const messages: ChatMessage[] = [
      { role: 'system', content: systemContent },
    ];

    // 追加会话历史：丢弃 system，只保留最近若干轮 user/assistant。
    const history = sanitizeSessionHistory(body.sessionHistory);
    for (const turn of history) {
      messages.push({ role: turn.role, content: turn.content });
    }

    // 追加当前用户消息
    messages.push({ role: 'user', content: body.message });

    // 5) 调用 ModelProxy 流式接口
    return this.modelProxy.streamCompletion(config, messages, signal);
  }

  /**
   * 将 attachedSettingIds 解析为文本片段列表。
   * 尝试在人物、世界观、大纲中查找匹配的条目。
   */
  private async resolveSettings(
    projectId: Id,
    settingIds: Id[],
  ): Promise<string[]> {
    const [characters, worldSettings, outlines] = await Promise.all([
      this.store.listCharacters(projectId),
      this.store.listWorldSettings(projectId),
      this.store.listOutlines(projectId),
    ]);

    const snippets: string[] = [];
    const idSet = new Set(settingIds);

    for (const c of characters) {
      if (idSet.has(c.id)) {
        snippets.push(`[人物] ${c.name}：${c.description}`);
      }
    }
    for (const w of worldSettings) {
      if (idSet.has(w.id)) {
        snippets.push(`[世界观] ${w.title}：${w.content}`);
      }
    }
    for (const o of outlines) {
      if (idSet.has(o.id)) {
        snippets.push(`[大纲] ${o.title}：${o.content}`);
      }
    }

    return snippets;
  }
}

function sanitizeSessionHistory(
  history: FreeChatRequestBody['sessionHistory'],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!history || history.length === 0) return [];
  const allowed: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const turn of history) {
    if (!turn || typeof turn.content !== 'string') continue;
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    allowed.push({ role: turn.role, content: turn.content });
  }
  return allowed.slice(-MAX_SESSION_HISTORY_TURNS);
}
