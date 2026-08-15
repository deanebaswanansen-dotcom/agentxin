import type { Project } from '../../../types/index.js';
import { ServiceError } from '../../ServiceError.js';
import type { ScriptModelAdapter } from './ScriptDirector.js';
import { parseStructuredModelOutput, ScriptModelOutputError } from './structuredOutput.js';

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

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScriptModelOutputError(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxLength = 6_000): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new ScriptModelOutputError(`${label} 必须是非空文本。`);
  }
  return value.trim();
}

function textList(value: unknown, label: string, min = 1, max = 8): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ScriptModelOutputError(`${label} 必须是字符串数组。`);
  }
  const items = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (items.length < min || items.length > max) {
    throw new ScriptModelOutputError(`${label} 必须包含 ${min}-${max} 项。`);
  }
  return items;
}

function choice<const T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ScriptModelOutputError(`${label} 的值无效。`);
  }
  return value as T;
}

function episodeCount(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 200) {
    throw new ScriptModelOutputError('totalEpisodes 必须是 1-200 的整数。');
  }
  return value as number;
}

function normalizeConceptText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function assertDistinctConceptField(
  proposals: readonly ScriptConceptProposal[],
  field: 'title' | 'logline' | 'coreConflict' | 'mainArc',
  label: string,
): void {
  const values = proposals.map((item) => normalizeConceptText(item[field]));
  if (new Set(values).size !== values.length) {
    throw new ScriptModelOutputError(`AI 选题${label}不能重复或仅有标点、空白差异。`);
  }
}

function proposal(value: unknown, index: number): ScriptConceptProposal {
  const input = record(value, `第 ${index + 1} 个选题`);
  return {
    title: text(input.title, 'title', 200),
    theme: text(input.theme, 'theme', 2_000),
    market: choice(input.market, 'market', ['domestic', 'overseas'] as const),
    channel: choice(input.channel, 'channel', ['female', 'male', 'general'] as const),
    genres: textList(input.genres, 'genres', 1, 6),
    logline: text(input.logline, 'logline', 2_000),
    audience: text(input.audience, 'audience', 1_000),
    coreConflict: text(input.coreConflict, 'coreConflict', 2_000),
    highlights: textList(input.highlights, 'highlights', 2, 8),
    mainArc: text(input.mainArc, 'mainArc'),
    endingDirection: text(input.endingDirection, 'endingDirection', 2_000),
    coverPrompt: text(input.coverPrompt, 'coverPrompt', 2_000),
    totalEpisodes: episodeCount(input.totalEpisodes),
  };
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
    const raw = await this.model.complete({
      node: 'plan',
      projectId,
      signal,
      prompt: [
        '你是短剧 AI 选题策划。请给出三个明显不同、可连续拍摄的原创短剧选题，供用户选择。',
        '只返回 JSON {"proposals":[...]}，proposals 必须恰好三项，不输出 Markdown 或分析过程。',
        '每项严格包含 title, theme, market(domestic|overseas), channel(female|male|general), genres, logline, audience, coreConflict, highlights, mainArc, endingDirection, coverPrompt, totalEpisodes。不得改名或省略字段。',
        '三个方案在核心冲突、人物关系和主要爽点上必须有实质差异；标题简短有传播性，一句话梗概清楚交代主角、困境、行动和代价。',
        'mainArc 用一段话说明全剧起承转合；highlights 返回 2-8 项；coverPrompt 描述 9:16 竖版海报构图且不要使用真实明星姓名。',
        '不得改写现成影视、网文或用户未提供的受版权保护故事；只提炼用户灵感中的主题和约束。',
        seed ? `用户灵感与硬约束：${seed}` : '用户没有提供灵感，请覆盖当前短剧市场常见但彼此不同的三个方向。',
      ].join('\n'),
    });
    const parsed = parseStructuredModelOutput(raw);
    if (!Array.isArray(parsed.proposals) || parsed.proposals.length !== 3) {
      throw new ScriptModelOutputError('AI 选题必须返回恰好三个 proposals。');
    }
    const proposals = parsed.proposals.map(proposal);
    assertDistinctConceptField(proposals, 'title', '标题');
    assertDistinctConceptField(proposals, 'logline', '一句话故事');
    assertDistinctConceptField(proposals, 'coreConflict', '核心冲突');
    assertDistinctConceptField(proposals, 'mainArc', '主线');
    return { proposals };
  }
}
