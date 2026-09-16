import type { Project } from '../../../types/index.js';
import { ServiceError } from '../../ServiceError.js';
import type { ScriptModelAdapter } from './ScriptDirector.js';
import { ScriptModelOutputError } from './structuredOutput.js';
import { generateStructured, type StructuredModel } from './generateStructured.js';
import { modelStoryText, requireModelStoryText, scriptPlanningFailureMessage } from './ScriptPlanModelContent.js';

export interface ScriptConceptProposal {
  title: string;
  theme: string;
  market: 'domestic' | 'overseas';
  channel: 'female' | 'male' | 'general';
  genres: string[];
  logline: string;
  audience: string;
  coreConflict: string;
  highlights: string[];
  mainArc: string;
  endingDirection: string;
  coverPrompt: string;
  totalEpisodes: number;
}

export interface ScriptConceptResult {
  proposals: ScriptConceptProposal[];
}

interface ScriptProjectLookup {
  (projectId: string): Promise<Project | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalText(value: unknown, maxLength = 6_000): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function textOr(value: unknown, fallback: string, maxLength = 6_000): string {
  return optionalText(value, maxLength) ?? fallback.slice(0, maxLength);
}

function textListOr(value: unknown, fallback: readonly string[], max = 8): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,，、;；/]+/u)
      : [];
  const items = [...new Set(rawItems
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean))]
    .slice(0, max);
  return items.length > 0 ? items : [...fallback].slice(0, max);
}

function conceptChoice<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  aliases: Readonly<Record<string, T>>,
  fallback: T,
): T {
  const normalized = optionalText(value)?.toLocaleLowerCase('zh-CN');
  if (!normalized) return fallback;
  if (allowed.includes(normalized as T)) return normalized as T;
  return aliases[normalized] ?? fallback;
}

function episodeCountOr(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(200, Math.round(numeric)));
}

function normalizeConceptText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function hasUsableConceptContent(input: Record<string, unknown>): boolean {
  return [
    ['title', 'name', '剧名'],
    ['logline', 'story', 'summary', '一句话故事'],
    ['coreConflict', 'conflict', '核心冲突'],
  ].every((keys) => keys.some((key) => Boolean(modelStoryText(input[key]))));
}

function proposal(input: Record<string, unknown>): ScriptConceptProposal {
  const title = requireModelStoryText(input, ['title', 'name', '剧名']).slice(0, 200);
  const logline = requireModelStoryText(input, ['logline', 'story', 'summary', '一句话故事']).slice(0, 2_000);
  const coreConflict = requireModelStoryText(input, ['coreConflict', 'conflict', '核心冲突']).slice(0, 2_000);
  const theme = textOr(input.theme ?? input.topic, title, 2_000);
  return {
    title,
    theme,
    market: conceptChoice(
      input.market,
      ['domestic', 'overseas'] as const,
      { '国内': 'domestic', '中国': 'domestic', '海外': 'overseas', '国外': 'overseas' },
      'domestic',
    ),
    channel: conceptChoice(
      input.channel,
      ['female', 'male', 'general'] as const,
      { '女频': 'female', '女性': 'female', '男频': 'male', '男性': 'male', '通用': 'general', '大众': 'general' },
      'general',
    ),
    genres: textListOr(input.genres ?? input.genre, ['剧情'], 6),
    logline,
    audience: textOr(input.audience ?? input.targetAudience, '大众短剧观众', 1_000),
    coreConflict,
    highlights: textListOr(input.highlights ?? input.sellingPoints, [], 8),
    mainArc: textOr(input.mainArc ?? input.arc, logline),
    endingDirection: textOr(input.endingDirection ?? input.ending, '核心冲突得到解决', 2_000),
    coverPrompt: textOr(input.coverPrompt ?? input.posterPrompt, '', 2_000),
    totalEpisodes: episodeCountOr(input.totalEpisodes ?? input.episodes, 60),
  };
}

function deduplicateProposals(proposals: readonly ScriptConceptProposal[]): ScriptConceptProposal[] {
  const seen = new Set<string>();
  return proposals.filter((item) => {
    const identity = normalizeConceptText(item.title);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function normalizeProposals(parsed: unknown): ScriptConceptProposal[] {
  const source = parsed
    && isRecord(parsed) ? Array.isArray(parsed.proposals)
      ? parsed.proposals
      : Array.isArray(parsed.concepts)
        ? parsed.concepts
        : hasUsableConceptContent(parsed)
          ? [parsed]
          : []
    : [];
  const proposals = deduplicateProposals(source
    .filter(isRecord)
    .filter(hasUsableConceptContent)
    .map(proposal))
    .slice(0, 3);
  if (proposals.length > 0) return proposals;
  throw new ScriptModelOutputError('选题结果必须包含至少一个有 title、logline、coreConflict 的有效方案。');
}

export class ScriptConceptService {
  constructor(
    private readonly model: ScriptModelAdapter,
    private readonly projectLookup: ScriptProjectLookup,
  ) {}

  async generate(
    projectId: string,
    seedPrompt = '',
    signal?: AbortSignal,
  ): Promise<ScriptConceptResult> {
    const project = await this.projectLookup(projectId);
    if (!project) throw ServiceError.notFound(`项目 ${projectId} 不存在`);
    if (project.kind !== 'short_drama') {
      throw ServiceError.validation('AI 选题只能用于 short_drama 项目。');
    }
    const seed = seedPrompt.trim();
    if (seed.length > 20_000) throw ServiceError.validation('选题灵感不能超过 20000 个字符。');
    signal?.throwIfAborted();
    const prompt = [
          '你是短剧 AI 选题策划。请给出 1-3 个明显不同、可连续拍摄的原创短剧选题，优先给出三个供用户选择。',
          '只返回 JSON {"proposals":[...]}，不输出 Markdown 或分析过程。',
          '每项必须包含原创故事字段 title、logline、coreConflict；不得用输入说明、JSON 或项目元数据代替故事。辅助字段 theme, market(domestic|overseas), channel(female|male|general), genres, audience, highlights, mainArc, endingDirection, coverPrompt, totalEpisodes 可以省略。',
          '三个方案在核心冲突、人物关系和主要爽点上必须有实质差异；标题简短有传播性，一句话梗概清楚交代主角、困境、行动和代价。',
          'mainArc 用一段话说明全剧起承转合；highlights 返回 2-8 项；coverPrompt 描述 9:16 竖版海报构图且不要使用真实明星姓名。',
          '不得改写现成影视、网文或用户未提供的受版权保护故事；只提炼用户灵感中的主题和约束。',
          seed ? `用户灵感与硬约束：${seed}` : '用户没有提供灵感，请覆盖当前短剧市场常见但彼此不同的三个方向。',
          `项目元数据：${JSON.stringify({ name: project.name, kind: project.kind })}`,
        ].join('\n');
    const adapter = (modelNameOverride?: string): StructuredModel => ({
      complete: ({ prompt: attemptPrompt, signal: attemptSignal, attemptBudget }) => this.model.complete({
        node: 'plan', projectId, prompt: attemptPrompt, signal: attemptSignal, attemptBudget,
        ...(modelNameOverride ? { modelNameOverride } : {}),
      }),
    });
    const fallbackModel = await this.model.getStructuredFallbackModelName?.();
    const result = await generateStructured({
      prompt, primary: adapter(), signal,
      ...(fallbackModel ? { fallback: adapter(fallbackModel) } : {}),
      contract: {
        name: 'script_concepts', version: 2,
        instructions: '返回 {"proposals":[...]}，每个方案必须有 title、logline、coreConflict。',
        decode(value) {
          try {
            return { success: true, value: normalizeProposals(value) };
          } catch (error) {
            if (!(error instanceof ScriptModelOutputError)) throw error;
            return { success: false, issues: [{ path: ['proposals'], code: 'story.required', message: error.message }] };
          }
        },
      },
    });
    signal?.throwIfAborted();
    if (result.status === 'needs_review') {
      throw new ScriptModelOutputError(scriptPlanningFailureMessage('选题', result.error));
    }
    return { proposals: result.value };
  }
}
