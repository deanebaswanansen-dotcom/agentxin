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

function fallbackStem(seedPrompt: string, project: Project): string {
  const firstSeedLine = seedPrompt.split(/\r?\n/u).map((item) => item.trim()).find(Boolean);
  return (firstSeedLine ?? project.name ?? '原创短剧').slice(0, 40);
}

function fallbackProposal(seedPrompt: string, project: Project, index: number): ScriptConceptProposal {
  const stem = fallbackStem(seedPrompt, project);
  const directions = [
    { suffix: '绝境反击', conflict: '主角必须在失去一切前找到破局证据', highlight: '绝境翻盘' },
    { suffix: '真相倒计时', conflict: '主角必须在真相被掩盖前识破身边的谎言', highlight: '真相反转' },
    { suffix: '身份翻盘', conflict: '主角必须在身份暴露前完成自救并守住重要的人', highlight: '身份反差' },
  ] as const;
  const direction = directions[index % directions.length]!;
  return {
    title: `${stem}：${direction.suffix}`,
    theme: stem,
    market: 'domestic',
    channel: 'general',
    genres: ['剧情', '逆袭'],
    logline: `身陷困局的主角围绕“${stem}”主动反击，并为最终选择承担代价。`,
    audience: '喜欢强冲突、快节奏和连续反转的短剧观众',
    coreConflict: direction.conflict,
    highlights: [direction.highlight, '连续反转'],
    mainArc: '主角遭遇危机、寻找突破口，在接连反扑中付出代价，最终完成选择并解决核心矛盾。',
    endingDirection: '核心矛盾解决，人物关系完成阶段性落点。',
    coverPrompt: '9:16 竖版短剧海报，主角位于画面中心，强对比光影，突出冲突与悬念。',
    totalEpisodes: 60,
  };
}

function hasUsableConceptContent(input: Record<string, unknown>): boolean {
  return [input.title, input.name, input.theme, input.logline, input.story, input.coreConflict, input.mainArc]
    .some((value) => Boolean(optionalText(value)));
}

function proposal(
  input: Record<string, unknown>,
  index: number,
  seedPrompt: string,
  project: Project,
): ScriptConceptProposal {
  const fallback = fallbackProposal(seedPrompt, project, index);
  const title = textOr(input.title ?? input.name, fallback.title, 200);
  const theme = textOr(input.theme ?? input.topic, fallback.theme, 2_000);
  const logline = textOr(input.logline ?? input.story ?? input.summary, fallback.logline, 2_000);
  const coreConflict = textOr(input.coreConflict ?? input.conflict, fallback.coreConflict, 2_000);
  return {
    title,
    theme,
    market: conceptChoice(
      input.market,
      ['domestic', 'overseas'] as const,
      { '国内': 'domestic', '中国': 'domestic', '海外': 'overseas', '国外': 'overseas' },
      fallback.market,
    ),
    channel: conceptChoice(
      input.channel,
      ['female', 'male', 'general'] as const,
      { '女频': 'female', '女性': 'female', '男频': 'male', '男性': 'male', '通用': 'general', '大众': 'general' },
      fallback.channel,
    ),
    genres: textListOr(input.genres ?? input.genre, fallback.genres, 6),
    logline,
    audience: textOr(input.audience ?? input.targetAudience, fallback.audience, 1_000),
    coreConflict,
    highlights: textListOr(input.highlights ?? input.sellingPoints, fallback.highlights, 8),
    mainArc: textOr(input.mainArc ?? input.arc, fallback.mainArc),
    endingDirection: textOr(input.endingDirection ?? input.ending, fallback.endingDirection, 2_000),
    coverPrompt: textOr(input.coverPrompt ?? input.posterPrompt, fallback.coverPrompt, 2_000),
    totalEpisodes: episodeCountOr(input.totalEpisodes ?? input.episodes, fallback.totalEpisodes),
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

function normalizeProposals(raw: string, seedPrompt: string, project: Project): ScriptConceptProposal[] {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = parseStructuredModelOutput(raw);
  } catch (error) {
    if (!(error instanceof ScriptModelOutputError)) throw error;
  }

  const source = parsed
    ? Array.isArray(parsed.proposals)
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
    .map((item, index) => proposal(item, index, seedPrompt, project)))
    .slice(0, 3);
  if (proposals.length > 0) return proposals;
  return [0, 1, 2].map((index) => fallbackProposal(seedPrompt, project, index));
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
    let raw: string;
    try {
      raw = await this.model.complete({
        node: 'plan',
        projectId,
        signal,
        prompt: [
          '你是短剧 AI 选题策划。请给出 1-3 个明显不同、可连续拍摄的原创短剧选题，优先给出三个供用户选择。',
          '只返回 JSON {"proposals":[...]}，不输出 Markdown 或分析过程。',
          '每项尽量包含 title, theme, market(domestic|overseas), channel(female|male|general), genres, logline, audience, coreConflict, highlights, mainArc, endingDirection, coverPrompt, totalEpisodes；个别辅助字段不确定时可以省略，系统会补齐。',
          '三个方案在核心冲突、人物关系和主要爽点上必须有实质差异；标题简短有传播性，一句话梗概清楚交代主角、困境、行动和代价。',
          'mainArc 用一段话说明全剧起承转合；highlights 返回 2-8 项；coverPrompt 描述 9:16 竖版海报构图且不要使用真实明星姓名。',
          '不得改写现成影视、网文或用户未提供的受版权保护故事；只提炼用户灵感中的主题和约束。',
          seed ? `用户灵感与硬约束：${seed}` : '用户没有提供灵感，请覆盖当前短剧市场常见但彼此不同的三个方向。',
        ].join('\n'),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      raw = '';
    }
    return { proposals: normalizeProposals(raw, seed, project) };
  }
}
