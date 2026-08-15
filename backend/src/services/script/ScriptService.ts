import { randomUUID } from 'node:crypto';

import { StoreError } from '../../store/StoreError.js';
import type {
  ScriptBlock,
  ScriptCharacter,
  ScriptCharacterInput,
  ScriptEpisode,
  ScriptEpisodeInput,
  ScriptEpisodeOutline,
  ScriptEpisodeOutlineInput,
  ScriptEpisodeSummary,
  ScriptExportFormat,
  ScriptPlan,
  ScriptPlanInput,
  ScriptProjectState,
  ScriptScene,
  ScriptSeriesOutline,
  ScriptSeriesOutlineInput,
  ScriptWorldBible,
  ScriptWorldBibleInput,
} from './domain.js';
import { serializeChineseShortDrama } from './serializers/chineseShortDrama.js';
import { serializeScriptMarkdown } from './serializers/markdown.js';
import { serializeFountain } from './serializers/fountain.js';
import { ScriptConflictError, type ScriptStore } from './ScriptStore.js';
import { validateScriptEpisode } from './quality/ScriptQualityGates.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PLAN_STATUSES = ['draft', 'approved', 'locked'] as const;
const CHARACTER_ROLES = ['lead', 'supporting', 'antagonist', 'minor'] as const;
const OUTLINE_STATUSES = ['card', 'expanded', 'approved'] as const;
const EPISODE_STATUSES = ['planned', 'generating', 'reviewing', 'completed', 'failed'] as const;
const TIMES = ['day', 'night', 'dawn', 'dusk'] as const;
const IN_OUT = ['interior', 'exterior'] as const;

export type ScriptServiceErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND';

export class ScriptServiceError extends Error {
  constructor(
    readonly code: ScriptServiceErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ScriptServiceError';
    Object.setPrototypeOf(this, ScriptServiceError.prototype);
  }

  static validation(message: string, details?: unknown): ScriptServiceError {
    return new ScriptServiceError('VALIDATION_ERROR', message, details);
  }

  static notFound(message: string): ScriptServiceError {
    return new ScriptServiceError('NOT_FOUND', message);
  }
}

export interface ScriptServiceOptions {
  projectLookup?: (
    projectId: string,
  ) => Promise<{ kind?: 'novel' | 'short_drama' } | undefined>;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw ScriptServiceError.validation(`${label}必须是对象`);
  }
  return value as UnknownRecord;
}

function stringValue(value: unknown, label: string, max = 20_000): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ScriptServiceError.validation(`${label}不能为空`);
  }
  if (value.length > max) throw ScriptServiceError.validation(`${label}超过${max}个字符`);
  return value;
}

function optionalString(value: unknown, label: string, max = 20_000): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw ScriptServiceError.validation(`${label}必须是字符串`);
  if (value.length > max) throw ScriptServiceError.validation(`${label}超过${max}个字符`);
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw ScriptServiceError.validation(`${label}必须是${min}到${max}的整数`);
  }
  return value as number;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: T,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw ScriptServiceError.validation(`${label}的值无效`);
  }
  return value as T[number];
}

function stringArray(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {},
): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw ScriptServiceError.validation(`${label}必须是字符串数组`);
  }
  const items = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (items.length < min || items.length > max) {
    throw ScriptServiceError.validation(`${label}数量必须为${min}到${max}`);
  }
  return items;
}

function optionalId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return idValue(value, 'id');
}

function idValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw ScriptServiceError.validation(`${label}格式无效`);
  }
  return value;
}

function parsePlan(value: unknown): ScriptPlanInput {
  const input = record(value, '剧本策划');
  const duration = record(input.episodeDurationSeconds, '单集时长');
  const minDuration = integer(duration.min, '最短时长', 30, 180);
  const maxDuration = integer(duration.max, '最长时长', 30, 180);
  if (minDuration > maxDuration) {
    throw ScriptServiceError.validation('最短时长不能大于最长时长');
  }
  return {
    ...(optionalId(input.id) ? { id: optionalId(input.id) } : {}),
    status: enumValue(input.status ?? 'draft', '策划状态', PLAN_STATUSES),
    title: stringValue(input.title, '剧本名称', 200),
    theme: stringValue(input.theme, '主题', 1_000),
    market: enumValue(input.market, '市场', ['domestic', 'overseas'] as const),
    channel: enumValue(input.channel, '频类', ['female', 'male', 'general'] as const),
    genres: stringArray(input.genres, '题材', { min: 1, max: 6 }),
    audience: stringValue(input.audience, '目标受众', 1_000),
    coreConflict: stringValue(input.coreConflict, '核心冲突', 2_000),
    logline: stringValue(input.logline, '一句话故事', 2_000),
    highlights: stringArray(input.highlights, '亮点', { max: 20 }),
    totalEpisodes: integer(input.totalEpisodes, '总集数', 1, 200),
    episodeDurationSeconds: { min: minDuration, max: maxDuration },
    targetCharsPerEpisode: integer(input.targetCharsPerEpisode, '单集目标字数', 300, 3_000),
    maxPrimaryCharacters: integer(input.maxPrimaryCharacters, '主要角色上限', 1, 20),
    maxScenesPerEpisode: integer(input.maxScenesPerEpisode, '单集场景上限', 1, 5),
    dialogueDensityPercent: integer(input.dialogueDensityPercent, '对白密度', 20, 90),
    language: enumValue(input.language, '语言', ['zh-CN'] as const),
    format: enumValue(input.format, '格式', ['cn_short_drama'] as const),
    coreRequirements: optionalString(input.coreRequirements, '核心要求', 4_000) ?? '',
    forbiddenElements: stringArray(input.forbiddenElements, '禁止元素', { max: 30 }),
    endingDirection: stringValue(input.endingDirection, '结局方向', 2_000),
    ...(optionalString(input.coverPrompt, '封面提示词', 4_000) !== undefined
      ? { coverPrompt: optionalString(input.coverPrompt, '封面提示词', 4_000) }
      : {}),
  };
}

function parseCharacters(value: unknown): ScriptCharacterInput[] {
  if (!Array.isArray(value)) throw ScriptServiceError.validation('人物资料必须是数组');
  const names = new Set<string>();
  const ids = new Set<string>();
  return value.map((raw, index) => {
    const input = record(raw, `第${index + 1}个人物`);
    const name = stringValue(input.name, '人物姓名', 100);
    if (names.has(name)) throw ScriptServiceError.validation(`人物姓名重复: ${name}`);
    names.add(name);
    const suppliedId = optionalId(input.id);
    if (suppliedId && ids.has(suppliedId)) throw ScriptServiceError.validation(`人物 id 重复: ${suppliedId}`);
    if (suppliedId) ids.add(suppliedId);
    if (input.relationships !== undefined && !Array.isArray(input.relationships)) {
      throw ScriptServiceError.validation('人物关系必须是数组');
    }
    const relationships = (input.relationships ?? []).map((rawRelationship) => {
      const relationship = record(rawRelationship, '人物关系');
      const notes = optionalString(relationship.notes, '关系备注', 1_000);
      return {
        characterId: idValue(relationship.characterId, '关系人物 id'),
        label: stringValue(relationship.label, '关系标签', 100),
        ...(notes !== undefined ? { notes } : {}),
      };
    });
    const age = input.age === undefined ? undefined : integer(input.age, '年龄', 0, 150);
    const occupation = optionalString(input.occupation, '职业', 300);
    return {
      ...(suppliedId ? { id: suppliedId } : {}),
      name,
      aliases: stringArray(input.aliases ?? [], '别名', { max: 20 }),
      role: enumValue(input.role, '人物类型', CHARACTER_ROLES),
      ...(age !== undefined ? { age } : {}),
      ...(occupation !== undefined ? { occupation } : {}),
      identity: stringValue(input.identity, '人物身份', 2_000),
      biography: stringValue(input.biography, '人物小传', 8_000),
      motivation: stringValue(input.motivation, '动机', 2_000),
      goal: stringValue(input.goal, '目标', 2_000),
      weakness: stringValue(input.weakness, '弱点', 2_000),
      arc: stringValue(input.arc, '人物弧光', 4_000),
      appearance: stringValue(input.appearance, '外貌', 2_000),
      hairstyle: stringValue(input.hairstyle, '发型', 1_000),
      physique: stringValue(input.physique, '体格', 1_000),
      defaultOutfit: stringValue(input.defaultOutfit, '默认服装', 2_000),
      personality: stringArray(input.personality, '性格', { min: 1, max: 20 }),
      skills: stringArray(input.skills, '技能', { max: 20 }),
      speechStyle: stringValue(input.speechStyle, '语言风格', 2_000),
      catchphrases: stringArray(input.catchphrases, '口头禅', { max: 20 }),
      relationships,
    };
  });
}

function parseWorld(value: unknown): ScriptWorldBibleInput {
  const input = record(value, '世界圣经');
  return {
    era: stringValue(input.era, '时代', 1_000),
    primaryLocations: stringArray(input.primaryLocations, '主要地点', { min: 1, max: 50 }),
    worldState: stringValue(input.worldState, '世界状态', 8_000),
    rules: stringArray(input.rules, '世界规则', { max: 100 }),
    transport: stringArray(input.transport, '交通手段', { max: 50 }),
    communication: stringArray(input.communication, '通信手段', { max: 50 }),
    organizations: stringArray(input.organizations, '组织', { max: 100 }),
    recurringProps: stringArray(input.recurringProps, '重复道具', { max: 100 }),
    forbiddenAnachronisms: stringArray(input.forbiddenAnachronisms, '禁止时代错位', { max: 100 }),
  };
}

function parseSeriesOutline(value: unknown): ScriptSeriesOutlineInput {
  const input = record(value, '全剧大纲');
  if (!Array.isArray(input.episodeCards)) throw ScriptServiceError.validation('分集卡必须是数组');
  const cards = input.episodeCards.map((rawCard, index) => {
    const card = record(rawCard, `第${index + 1}张分集卡`);
    return {
      episodeNumber: integer(card.episodeNumber, '分集卡集号', 1, 200),
      title: stringValue(card.title, '分集卡标题', 200),
      logline: stringValue(card.logline, '分集卡概要', 2_000),
      mainEvent: stringValue(card.mainEvent, '主要事件', 2_000),
      endingHook: stringValue(card.endingHook, '结尾卡点', 2_000),
    };
  });
  const numbers = cards.map((card) => card.episodeNumber).sort((a, b) => a - b);
  if (numbers.some((number, index) => number !== index + 1)) {
    throw ScriptServiceError.validation('分集卡集号必须从1开始连续且唯一');
  }
  return {
    synopsis: stringValue(input.synopsis, '全剧概要', 20_000),
    openingState: stringValue(input.openingState, '开场状态', 4_000),
    midpointTurn: stringValue(input.midpointTurn, '中点转折', 4_000),
    climax: stringValue(input.climax, '高潮', 4_000),
    endingState: stringValue(input.endingState, '结局状态', 4_000),
    mainArc: stringArray(input.mainArc, '主线阶段', { min: 1, max: 100 }),
    subplotArcs: stringArray(input.subplotArcs, '副线', { max: 100 }),
    episodeCards: cards,
  };
}

function parseEpisodeOutline(value: unknown): ScriptEpisodeOutlineInput {
  const input = record(value, '详细分集大纲');
  if (!Array.isArray(input.plannedScenes)) throw ScriptServiceError.validation('计划场景必须是数组');
  const scenes = input.plannedScenes.map((rawScene, index) => {
    const scene = record(rawScene, `第${index + 1}个计划场景`);
    return {
      ordinal: integer(scene.ordinal, '场号', 1, 20),
      location: stringValue(scene.location, '场景地点', 300),
      timeOfDay: enumValue(scene.timeOfDay, '时间', TIMES),
      interiorExterior: enumValue(scene.interiorExterior, '内外景', IN_OUT),
      purpose: stringValue(scene.purpose, '场景目的', 2_000),
    };
  });
  if (new Set(scenes.map((scene) => scene.ordinal)).size !== scenes.length) {
    throw ScriptServiceError.validation('场号不能重复');
  }
  const reveal = optionalString(input.reveal, '揭示', 2_000);
  const reversal = optionalString(input.reversal, '反转', 2_000);
  return {
    ...(optionalId(input.id) ? { id: optionalId(input.id) } : {}),
    episodeNumber: integer(input.episodeNumber, '集号', 1, 200),
    title: stringValue(input.title, '分集标题', 200),
    goal: stringValue(input.goal, '分集目标', 2_000),
    conflict: stringValue(input.conflict, '分集冲突', 2_000),
    beats: stringArray(input.beats, '节拍', { min: 1, max: 50 }),
    characterIds: stringArray(input.characterIds, '出场人物', { max: 20 }).map((id) => idValue(id, '人物 id')),
    plannedScenes: scenes,
    ...(reveal !== undefined ? { reveal } : {}),
    ...(reversal !== undefined ? { reversal } : {}),
    endingHook: stringValue(input.endingHook, '结尾卡点', 2_000),
    requiredFacts: stringArray(input.requiredFacts, '必须事实', { max: 100 }),
    forbiddenFacts: stringArray(input.forbiddenFacts, '禁止事实', { max: 100 }),
    status: enumValue(input.status, '大纲状态', OUTLINE_STATUSES),
  };
}

function parseBlock(value: unknown): ScriptBlock {
  const input = record(value, '剧本块');
  const type = enumValue(input.type, '剧本块类型', ['caption', 'action', 'dialogue'] as const);
  const id = optionalId(input.id) ?? randomUUID();
  const text = stringValue(input.text, '剧本块文本', 10_000);
  if (type === 'caption' || type === 'action') return { id, type, text };
  const characterId = optionalId(input.characterId);
  const delivery = optionalString(input.delivery, '台词语气', 100);
  return {
    id,
    type: 'dialogue',
    ...(characterId ? { characterId } : {}),
    speaker: stringValue(input.speaker, '说话人', 100),
    ...(delivery !== undefined ? { delivery } : {}),
    mode: enumValue(input.mode ?? 'normal', '对白模式', ['normal', 'os', 'vo'] as const),
    text,
  };
}

function parseScene(value: unknown): ScriptScene {
  const input = record(value, '剧本场景');
  if (!Array.isArray(input.blocks) || input.blocks.length === 0) {
    throw ScriptServiceError.validation('剧本场景必须包含正文块');
  }
  return {
    id: optionalId(input.id) ?? randomUUID(),
    ordinal: integer(input.ordinal, '场号', 1, 20),
    location: stringValue(input.location, '场景地点', 300),
    timeOfDay: enumValue(input.timeOfDay, '时间', TIMES),
    interiorExterior: enumValue(input.interiorExterior, '内外景', IN_OUT),
    characterIds: stringArray(input.characterIds, '场景人物', { max: 20 }).map((id) => idValue(id, '人物 id')),
    blocks: input.blocks.map(parseBlock),
  };
}

function parseEpisode(value: unknown): ScriptEpisodeInput {
  const input = record(value, '剧本正文');
  if (!Array.isArray(input.scenes)) throw ScriptServiceError.validation('剧本场景必须是数组');
  const scenes = input.scenes.map(parseScene);
  if (new Set(scenes.map((scene) => scene.ordinal)).size !== scenes.length) {
    throw ScriptServiceError.validation('场号不能重复');
  }
  return {
    ...(optionalId(input.id) ? { id: optionalId(input.id) } : {}),
    episodeNumber: integer(input.episodeNumber, '集号', 1, 200),
    title: stringValue(input.title, '单集标题', 200),
    outlineId: idValue(input.outlineId, '分集大纲 id'),
    status: enumValue(input.status, '单集状态', EPISODE_STATUSES),
    targetChars: integer(input.targetChars, '目标字数', 300, 3_000),
    scenes,
    summary: optionalString(input.summary, '单集摘要', 4_000) ?? '',
    newFacts: stringArray(input.newFacts, '新事实', { max: 100 }),
    openedThreads: stringArray(input.openedThreads, '新伏笔', { max: 100 }),
    closedThreads: stringArray(input.closedThreads, '回收伏笔', { max: 100 }),
  };
}

function currentRevision(items: Array<{ revision: number }>): number {
  return Math.max(0, ...items.map((item) => item.revision));
}

export function countScriptVisibleChars(episode: ScriptEpisode): number {
  return episode.scenes.reduce(
    (total, scene) => total + scene.blocks.reduce((sum, block) => sum + block.text.replace(/\s/gu, '').length, 0),
    0,
  );
}

export class ScriptService {
  constructor(
    private readonly store: ScriptStore,
    private readonly options: ScriptServiceOptions = {},
  ) {}

  private async assertProject(projectId: string): Promise<void> {
    idValue(projectId, '项目 id');
    if (!this.options.projectLookup) return;
    const project = await this.options.projectLookup(projectId);
    if (!project) throw ScriptServiceError.notFound(`项目不存在: ${projectId}`);
    if (project.kind !== undefined && project.kind !== 'short_drama') {
      throw ScriptServiceError.validation('该项目不是短剧项目');
    }
  }

  async getState(projectId: string): Promise<ScriptProjectState | undefined> {
    await this.assertProject(projectId);
    return this.store.getProjectState(projectId);
  }

  private async requireState(projectId: string): Promise<ScriptProjectState> {
    const state = await this.getState(projectId);
    if (!state) throw ScriptServiceError.notFound('短剧项目资料尚未创建');
    return state;
  }

  async getPlan(projectId: string): Promise<ScriptPlan> {
    const plan = (await this.requireState(projectId)).plan;
    if (!plan) throw ScriptServiceError.notFound('剧本策划尚未创建');
    return plan;
  }

  async savePlan(projectId: string, value: unknown, expectedRevision: number): Promise<ScriptPlan> {
    await this.assertProject(projectId);
    const input = parsePlan(value);
    const current = (await this.store.getProjectState(projectId))?.plan;
    const now = new Date().toISOString();
    const plan: ScriptPlan = {
      ...input,
      id: current?.id ?? input.id ?? randomUUID(),
      projectId,
      status: current?.status ?? 'draft',
      revision: current?.revision ?? 0,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    return this.store.savePlan(plan, expectedRevision);
  }

  async approvePlan(projectId: string, expectedRevision: number): Promise<ScriptPlan> {
    const current = await this.getPlan(projectId);
    if (current.status === 'approved' || current.status === 'locked') return current;
    return this.store.savePlan({ ...current, status: 'approved' }, expectedRevision);
  }

  async getCharacters(projectId: string): Promise<ScriptCharacter[]> {
    await this.assertProject(projectId);
    return (await this.store.getProjectState(projectId))?.characters ?? [];
  }

  async saveCharacters(
    projectId: string,
    value: unknown,
    expectedRevision: number,
  ): Promise<ScriptCharacter[]> {
    await this.assertProject(projectId);
    const inputs = parseCharacters(value);
    const state = await this.store.getProjectState(projectId);
    const limit = state?.plan?.maxPrimaryCharacters ?? 20;
    if (inputs.filter((item) => item.role !== 'minor').length > limit) {
      throw ScriptServiceError.validation(`主要人物数超过策划上限${limit}`);
    }
    const byName = new Map((state?.characters ?? []).map((item) => [item.name, item]));
    const now = new Date().toISOString();
    const items: ScriptCharacter[] = inputs.map((input) => ({
      ...input,
      id: input.id ?? byName.get(input.name)?.id ?? randomUUID(),
      projectId,
      revision: currentRevision(state?.characters ?? []),
      updatedAt: now,
    }));
    return this.store.saveCharacters(projectId, items, expectedRevision);
  }

  async getWorld(projectId: string): Promise<ScriptWorldBible> {
    const value = (await this.requireState(projectId)).worldBible;
    if (!value) throw ScriptServiceError.notFound('世界圣经尚未创建');
    return value;
  }

  async saveWorld(projectId: string, value: unknown, expectedRevision: number): Promise<ScriptWorldBible> {
    await this.assertProject(projectId);
    const current = (await this.store.getProjectState(projectId))?.worldBible;
    return this.store.saveWorldBible(
      {
        ...parseWorld(value),
        projectId,
        revision: current?.revision ?? 0,
        updatedAt: new Date().toISOString(),
      },
      expectedRevision,
    );
  }

  async getSeriesOutline(projectId: string): Promise<ScriptSeriesOutline> {
    const value = (await this.requireState(projectId)).seriesOutline;
    if (!value) throw ScriptServiceError.notFound('全剧大纲尚未创建');
    return value;
  }

  async saveSeriesOutline(
    projectId: string,
    value: unknown,
    expectedRevision: number,
  ): Promise<ScriptSeriesOutline> {
    await this.assertProject(projectId);
    const parsed = parseSeriesOutline(value);
    const state = await this.store.getProjectState(projectId);
    if (state?.plan && parsed.episodeCards.length !== state.plan.totalEpisodes) {
      throw ScriptServiceError.validation(
        `分集卡必须完整覆盖1到${state.plan.totalEpisodes}集`,
      );
    }
    return this.store.saveSeriesOutline(
      { ...parsed, projectId, revision: state?.seriesOutline?.revision ?? 0 },
      expectedRevision,
    );
  }

  async getEpisodeOutline(projectId: string, episodeNumber: number): Promise<ScriptEpisodeOutline> {
    const item = (await this.requireState(projectId)).episodeOutlines.find(
      (value) => value.episodeNumber === episodeNumber,
    );
    if (!item) throw ScriptServiceError.notFound(`第${episodeNumber}集详细大纲尚未创建`);
    return item;
  }

  async saveEpisodeOutline(
    projectId: string,
    episodeNumber: number,
    value: unknown,
    expectedRevision: number,
  ): Promise<ScriptEpisodeOutline> {
    await this.assertProject(projectId);
    const input = parseEpisodeOutline(value);
    if (input.episodeNumber !== episodeNumber) {
      throw ScriptServiceError.validation('请求路径与正文中的集号不一致');
    }
    const state = await this.store.getProjectState(projectId);
    const plan = state?.plan;
    if (plan && episodeNumber > plan.totalEpisodes) {
      throw ScriptServiceError.validation('集号超过策划总集数');
    }
    const maxScenes = plan?.maxScenesPerEpisode ?? 5;
    if (input.plannedScenes.length < 1 || input.plannedScenes.length > maxScenes) {
      throw ScriptServiceError.validation(`计划场景数必须为1到${maxScenes}`);
    }
    const current = state?.episodeOutlines.find((item) => item.episodeNumber === episodeNumber);
    return this.store.saveEpisodeOutline(
      {
        ...input,
        id: current?.id ?? input.id ?? randomUUID(),
        projectId,
        revision: current?.revision ?? 0,
      },
      expectedRevision,
    );
  }

  async getEpisode(projectId: string, episodeNumber: number): Promise<ScriptEpisode> {
    const item = (await this.requireState(projectId)).episodes.find(
      (value) => value.episodeNumber === episodeNumber,
    );
    if (!item) throw ScriptServiceError.notFound(`第${episodeNumber}集正文尚未创建`);
    return item;
  }

  async listEpisodes(projectId: string): Promise<ScriptEpisodeSummary[]> {
    await this.assertProject(projectId);
    const episodes = (await this.store.getProjectState(projectId))?.episodes ?? [];
    return episodes
      .map((episode) => ({
        id: episode.id,
        episodeNumber: episode.episodeNumber,
        title: episode.title,
        status: episode.status,
        targetChars: episode.targetChars,
        visibleChars: countScriptVisibleChars(episode),
        sceneCount: episode.scenes.length,
        revision: episode.revision,
        updatedAt: episode.updatedAt,
      }))
      .sort((a, b) => a.episodeNumber - b.episodeNumber);
  }

  async saveEpisode(
    projectId: string,
    episodeNumber: number,
    value: unknown,
    expectedRevision: number,
  ): Promise<ScriptEpisode> {
    await this.assertProject(projectId);
    const input = parseEpisode(value);
    if (input.episodeNumber !== episodeNumber) {
      throw ScriptServiceError.validation('请求路径与正文中的集号不一致');
    }
    const state = await this.store.getProjectState(projectId);
    const plan = state?.plan;
    if (plan && episodeNumber > plan.totalEpisodes) {
      throw ScriptServiceError.validation('集号超过策划总集数');
    }
    const maxScenes = plan?.maxScenesPerEpisode ?? 5;
    if (input.scenes.length < 1 || input.scenes.length > maxScenes) {
      throw ScriptServiceError.validation(`剧本场景数必须为1到${maxScenes}`);
    }
    const current = state?.episodes.find((item) => item.episodeNumber === episodeNumber);
    const now = new Date().toISOString();
    const episode: ScriptEpisode = {
      ...input,
      id: current?.id ?? input.id ?? randomUUID(),
      projectId,
      revision: current?.revision ?? 0,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    if (episode.status === 'completed') {
      if (!plan) {
        throw ScriptServiceError.validation('完成正文前必须先保存并确认短剧策划');
      }
      const outline = state?.episodeOutlines.find((item) => item.episodeNumber === episodeNumber);
      if (!outline) {
        throw ScriptServiceError.validation('完成正文前必须先保存本集详细大纲');
      }
      const report = validateScriptEpisode(episode, plan, {
        expectedEpisodeNumber: episodeNumber,
        existingEpisodeNumbers: (state?.episodes ?? [])
          .filter((item) => item.episodeNumber !== episodeNumber)
          .map((item) => item.episodeNumber),
        registeredCharacterIds: new Set((state?.characters ?? []).map((item) => item.id)),
        registeredCharacterNames: new Set((state?.characters ?? []).map((item) => item.name)),
        outline,
      });
      if (report.hardFailed) {
        throw ScriptServiceError.validation('本集未通过短剧质量门，不能标记为已完成', {
          issues: report.issues,
        });
      }
    }
    return this.store.saveEpisode(episode, expectedRevision);
  }

  async remove(projectId: string): Promise<void> {
    await this.assertProject(projectId);
    await this.store.deleteProject(projectId);
  }

  async export(
    projectId: string,
    format: ScriptExportFormat,
    startEpisode?: number,
    episodeCount?: number,
  ): Promise<{ filename: string; content: string; contentType: string }> {
    const state = await this.requireState(projectId);
    const start = startEpisode ?? 1;
    const end = episodeCount === undefined ? Number.MAX_SAFE_INTEGER : start + episodeCount - 1;
    const episodes = state.episodes.filter(
      (episode) => episode.episodeNumber >= start && episode.episodeNumber <= end,
    );
    if (episodes.length === 0) throw ScriptServiceError.notFound('指定范围内没有可导出的剧本正文');
    const title = state.plan?.title ?? `短剧-${projectId}`;
    const extension = format === 'md' ? 'md' : format === 'fountain' ? 'fountain' : 'txt';
    const content = format === 'md'
      ? serializeScriptMarkdown(episodes, state.characters, { title })
      : format === 'fountain'
        ? serializeFountain(episodes, state.characters)
        : serializeChineseShortDrama(episodes, state.characters);
    return {
      filename: `${title}.${extension}`,
      content: `${content}\n`,
      contentType: format === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
    };
  }
}

export function isScriptTransportError(
  error: unknown,
): error is ScriptServiceError | ScriptConflictError | StoreError {
  return (
    error instanceof ScriptServiceError ||
    error instanceof ScriptConflictError ||
    error instanceof StoreError
  );
}
