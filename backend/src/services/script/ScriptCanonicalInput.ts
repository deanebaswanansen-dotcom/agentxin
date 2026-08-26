import { randomUUID } from 'node:crypto';

import type {
  ScriptBlock,
  ScriptCharacterInput,
  ScriptEpisodeInput,
  ScriptEpisodeOutlineInput,
  ScriptPlanInput,
  ScriptScene,
  ScriptSeriesOutlineInput,
  ScriptWorldBibleInput,
} from './domain.js';
import { ScriptServiceError } from './ScriptServiceError.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PLAN_STATUSES = ['draft', 'approved', 'locked'] as const;
const CHARACTER_ROLES = ['lead', 'supporting', 'antagonist', 'minor'] as const;
const OUTLINE_STATUSES = ['card', 'expanded', 'approved'] as const;
const EPISODE_STATUSES = ['planned', 'generating', 'reviewing', 'completed', 'failed'] as const;
const TIMES = ['day', 'night', 'dawn', 'dusk'] as const;
const IN_OUT = ['interior', 'exterior'] as const;

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

export function decodeScriptPlanInput(value: unknown): ScriptPlanInput {
  const input = record(value, '剧本策划');
  const duration = record(input.episodeDurationSeconds, '单集时长');
  const minDuration = integer(duration.min, '最短时长', 30, 180);
  const maxDuration = integer(duration.max, '最长时长', 30, 180);
  if (minDuration > maxDuration) {
    throw ScriptServiceError.validation('最短时长不能大于最长时长');
  }
  const id = optionalId(input.id);
  const coverPrompt = optionalString(input.coverPrompt, '封面提示词', 4_000);
  return {
    ...(id ? { id } : {}),
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
    ...(coverPrompt !== undefined ? { coverPrompt } : {}),
  };
}

export function decodeScriptCharacterInputs(value: unknown): ScriptCharacterInput[] {
  if (!Array.isArray(value)) throw ScriptServiceError.validation('人物资料必须是数组');
  const names = new Set<string>();
  const ids = new Set<string>();
  return value.map((raw, index) => {
    const input = record(raw, `第${index + 1}个人物`);
    const name = stringValue(input.name, '人物姓名', 100);
    if (names.has(name)) throw ScriptServiceError.validation(`人物姓名重复: ${name}`);
    names.add(name);
    const suppliedId = optionalId(input.id);
    if (suppliedId && ids.has(suppliedId)) {
      throw ScriptServiceError.validation(`人物 id 重复: ${suppliedId}`);
    }
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

export type CanonicalScriptCharacter = ScriptCharacterInput & { id: string };

/** Validate constraints that require the complete, ID-materialized cast. */
export function validateScriptCharacterSet(
  characters: readonly CanonicalScriptCharacter[],
  options: { maxPrimaryCharacters?: number } = {},
): void {
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const character of characters) {
    const canonicalName = character.name.trim();
    if (names.has(canonicalName)) {
      throw ScriptServiceError.validation(`人物姓名重复: ${canonicalName}`);
    }
    names.add(canonicalName);
    if (ids.has(character.id)) {
      throw ScriptServiceError.validation(`人物 id 重复: ${character.id}`);
    }
    ids.add(character.id);
  }

  const limit = options.maxPrimaryCharacters ?? 20;
  if (characters.filter((item) => item.role !== 'minor').length > limit) {
    throw ScriptServiceError.validation(`主要人物数超过策划上限${limit}`);
  }

  for (const character of characters) {
    for (const relationship of character.relationships) {
      if (relationship.characterId === character.id) {
        throw ScriptServiceError.validation(`人物「${character.name}」不能与自己建立关系`);
      }
      if (!ids.has(relationship.characterId)) {
        throw ScriptServiceError.validation(
          `人物「${character.name}」的关系目标不存在: ${relationship.characterId}`,
        );
      }
    }
  }
}

export function decodeScriptWorldBibleInput(value: unknown): ScriptWorldBibleInput {
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

export function decodeScriptSeriesOutlineInput(value: unknown): ScriptSeriesOutlineInput {
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

export function validateScriptSeriesOutlineInput(
  outline: ScriptSeriesOutlineInput,
  options: { totalEpisodes?: number } = {},
): void {
  if (
    options.totalEpisodes !== undefined
    && outline.episodeCards.length !== options.totalEpisodes
  ) {
    throw ScriptServiceError.validation(
      `分集卡必须完整覆盖1到${options.totalEpisodes}集`,
    );
  }
}

export function decodeScriptEpisodeOutlineInput(value: unknown): ScriptEpisodeOutlineInput {
  const input = record(value, '详细分集大纲');
  if (!Array.isArray(input.plannedScenes)) throw ScriptServiceError.validation('计划场景必须是数组');
  const scenes = input.plannedScenes.map((rawScene, index) => {
    const scene = record(rawScene, `第${index + 1}个计划场景`);
    return {
      // Model scene numbers are presentation metadata. Preserve the returned
      // order and normalize locally instead of rejecting duplicate/skipped numbers.
      ordinal: index + 1,
      location: stringValue(scene.location, '场景地点', 300),
      timeOfDay: enumValue(scene.timeOfDay, '时间', TIMES),
      interiorExterior: enumValue(scene.interiorExterior, '内外景', IN_OUT),
      purpose: stringValue(scene.purpose, '场景目的', 2_000),
    };
  });
  const id = optionalId(input.id);
  const reveal = optionalString(input.reveal, '揭示', 2_000);
  const reversal = optionalString(input.reversal, '反转', 2_000);
  return {
    ...(id ? { id } : {}),
    episodeNumber: integer(input.episodeNumber, '集号', 1, 200),
    title: stringValue(input.title, '分集标题', 200),
    goal: stringValue(input.goal, '分集目标', 2_000),
    conflict: stringValue(input.conflict, '分集冲突', 2_000),
    beats: stringArray(input.beats, '节拍', { min: 1, max: 50 }),
    characterIds: stringArray(input.characterIds, '出场人物', { max: 20 })
      .map((idValueCandidate) => idValue(idValueCandidate, '人物 id')),
    plannedScenes: scenes,
    ...(reveal !== undefined ? { reveal } : {}),
    ...(reversal !== undefined ? { reversal } : {}),
    endingHook: stringValue(input.endingHook, '结尾卡点', 2_000),
    requiredFacts: stringArray(input.requiredFacts, '必须事实', { max: 100 }),
    forbiddenFacts: stringArray(input.forbiddenFacts, '禁止事实', { max: 100 }),
    status: enumValue(input.status, '大纲状态', OUTLINE_STATUSES),
  };
}

export function validateScriptEpisodeOutlineInput(
  outline: ScriptEpisodeOutlineInput,
  options: {
    expectedEpisodeNumber?: number;
    totalEpisodes?: number;
    maxScenesPerEpisode?: number;
  } = {},
): void {
  if (
    options.expectedEpisodeNumber !== undefined
    && outline.episodeNumber !== options.expectedEpisodeNumber
  ) {
    throw ScriptServiceError.validation('请求路径与正文中的集号不一致');
  }
  if (options.totalEpisodes !== undefined && outline.episodeNumber > options.totalEpisodes) {
    throw ScriptServiceError.validation('集号超过策划总集数');
  }
  if (outline.plannedScenes.length < 1) {
    throw ScriptServiceError.validation('计划场景至少需要1场');
  }
}

function decodeScriptBlock(value: unknown, createId: () => string): ScriptBlock {
  const input = record(value, '剧本块');
  const type = enumValue(input.type, '剧本块类型', ['caption', 'action', 'dialogue'] as const);
  const id = optionalId(input.id) ?? createId();
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

function decodeScriptScene(value: unknown, createId: () => string, ordinal: number): ScriptScene {
  const input = record(value, '剧本场景');
  if (!Array.isArray(input.blocks) || input.blocks.length === 0) {
    throw ScriptServiceError.validation('剧本场景必须包含正文块');
  }
  return {
    id: optionalId(input.id) ?? createId(),
    ordinal,
    location: stringValue(input.location, '场景地点', 300),
    timeOfDay: enumValue(input.timeOfDay, '时间', TIMES),
    interiorExterior: enumValue(input.interiorExterior, '内外景', IN_OUT),
    characterIds: stringArray(input.characterIds, '场景人物', { max: 20 })
      .map((idValueCandidate) => idValue(idValueCandidate, '人物 id')),
    blocks: input.blocks.map((block) => decodeScriptBlock(block, createId)),
  };
}

export function decodeScriptEpisodeInput(
  value: unknown,
  options: { createId?: () => string } = {},
): ScriptEpisodeInput {
  const input = record(value, '剧本正文');
  if (!Array.isArray(input.scenes)) throw ScriptServiceError.validation('剧本场景必须是数组');
  const createId = options.createId ?? randomUUID;
  const scenes = input.scenes.map((scene, index) => decodeScriptScene(scene, createId, index + 1));
  const id = optionalId(input.id);
  return {
    ...(id ? { id } : {}),
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

export function validateScriptEpisodeInput(
  episode: ScriptEpisodeInput,
  options: {
    expectedEpisodeNumber?: number;
    totalEpisodes?: number;
    maxScenesPerEpisode?: number;
  } = {},
): void {
  if (
    options.expectedEpisodeNumber !== undefined
    && episode.episodeNumber !== options.expectedEpisodeNumber
  ) {
    throw ScriptServiceError.validation('请求路径与正文中的集号不一致');
  }
  if (options.totalEpisodes !== undefined && episode.episodeNumber > options.totalEpisodes) {
    throw ScriptServiceError.validation('集号超过策划总集数');
  }
  if (episode.scenes.length < 1) {
    throw ScriptServiceError.validation('剧本正文至少需要1场');
  }
}
