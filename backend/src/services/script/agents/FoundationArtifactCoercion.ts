import type {
  ScriptCharacter,
  ScriptPlan,
  ScriptWorldBible,
} from '../domain.js';

type UnknownRecord = Record<string, unknown>;

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function record(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function unwrapped(value: unknown, keys: readonly string[]): UnknownRecord {
  const outer = record(value);
  for (const key of keys) {
    const nested = record(outer[key]);
    if (Object.keys(nested).length > 0) return nested;
  }
  return outer;
}

function firstValue(source: UnknownRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function text(value: unknown, fallback: string, max = 20_000): string {
  const candidate = typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
  return (candidate || fallback).slice(0, max);
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const candidate = String(value).trim();
  return candidate ? candidate.slice(0, max) : undefined;
}

function textArray(value: unknown, fallback: readonly string[] = [], max = 100): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,，、;；/]+/u)
      : [];
  const result = [...new Set(raw
    .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    .map((item) => String(item).trim().slice(0, 2_000))
    .filter(Boolean))].slice(0, max);
  return result.length > 0 ? result : [...fallback].slice(0, max);
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value.trim().match(/-?\d+(?:\.\d+)?/u)?.[0])
      : Number.NaN;
  if (!Number.isFinite(parsed)) return Math.min(max, Math.max(min, fallback));
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function enumValue<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  aliases: Readonly<Record<string, T>>,
  fallback: T,
): T {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLocaleLowerCase('zh-CN');
  return allowed.includes(normalized as T) ? normalized as T : aliases[normalized] ?? fallback;
}

export interface CoercePlanOptions {
  projectId: string;
  now: string;
  id: string;
  current?: ScriptPlan;
  explicit: Partial<Pick<
    ScriptPlan,
    | 'genres'
    | 'audience'
    | 'coreConflict'
    | 'totalEpisodes'
    | 'episodeDurationSeconds'
    | 'targetCharsPerEpisode'
    | 'maxScenesPerEpisode'
    | 'dialogueDensityPercent'
    | 'endingDirection'
  >>;
  seedPrompt?: string;
}

/**
 * Makes a model-authored plan editable and canonical without asking the model
 * to repeat itself merely because a secondary field was omitted.
 */
export function coerceScriptPlanCandidate(
  value: unknown,
  options: CoercePlanOptions,
): ScriptPlan {
  const source = unwrapped(value, ['script_plan', 'plan', '策划']);
  const seed = options.seedPrompt?.trim() || '主角在困境中寻找突破并完成成长';
  const genres = textArray(
    options.explicit.genres ?? firstValue(source, ['genres', 'genre', '题材']),
    ['都市剧情'],
    6,
  );
  const theme = text(firstValue(source, ['theme', '主题']), genres[0] ?? '成长', 1_000);
  const coreConflict = text(
    options.explicit.coreConflict ?? firstValue(source, ['coreConflict', 'core_conflict', '核心冲突']),
    seed,
    2_000,
  );
  const audience = text(
    options.explicit.audience ?? firstValue(source, ['audience', 'targetAudience', '受众']),
    '大众短剧观众',
    1_000,
  );
  const endingDirection = text(
    options.explicit.endingDirection ?? firstValue(source, ['endingDirection', 'ending', '结局方向']),
    '核心冲突得到解决，主角完成成长',
    2_000,
  );
  const rawDuration = record(firstValue(source, ['episodeDurationSeconds', 'episodeDuration', '单集时长']));
  const explicitDuration = options.explicit.episodeDurationSeconds;
  let minDuration = integer(
    explicitDuration?.min ?? firstValue(rawDuration, ['min', 'minimum']),
    60,
    30,
    180,
  );
  let maxDuration = integer(
    explicitDuration?.max ?? firstValue(rawDuration, ['max', 'maximum']),
    90,
    30,
    180,
  );
  if (minDuration > maxDuration) [minDuration, maxDuration] = [maxDuration, minDuration];

  return {
    id: options.current?.id ?? options.id,
    projectId: options.projectId,
    status: 'draft',
    revision: options.current?.revision ?? 0,
    title: text(firstValue(source, ['title', 'name', 'scriptTitle', '剧名']), seed, 200),
    theme,
    market: enumValue(firstValue(source, ['market', '市场']), ['domestic', 'overseas'], {
      '国内': 'domestic', '内地': 'domestic', '海外': 'overseas',
    }, 'domestic'),
    channel: enumValue(firstValue(source, ['channel', '频道']), ['female', 'male', 'general'], {
      '女频': 'female', '男频': 'male', '通用': 'general', '大众': 'general',
    }, 'general'),
    genres,
    audience,
    coreConflict,
    logline: text(firstValue(source, ['logline', 'oneLineStory', '一句话故事']), coreConflict, 2_000),
    highlights: textArray(firstValue(source, ['highlights', 'sellingPoints', '亮点']), [theme], 20),
    totalEpisodes: integer(
      options.explicit.totalEpisodes ?? firstValue(source, ['totalEpisodes', 'episodeCount', '总集数']),
      60,
      1,
      200,
    ),
    episodeDurationSeconds: { min: minDuration, max: maxDuration },
    targetCharsPerEpisode: integer(
      options.explicit.targetCharsPerEpisode ?? firstValue(source, ['targetCharsPerEpisode', 'targetChars', '单集字数']),
      1_000,
      300,
      3_000,
    ),
    maxPrimaryCharacters: integer(
      firstValue(source, ['maxPrimaryCharacters', 'maxCharacters', '主要人物上限']),
      8,
      1,
      20,
    ),
    maxScenesPerEpisode: integer(
      options.explicit.maxScenesPerEpisode ?? firstValue(source, ['maxScenesPerEpisode', 'maxScenes', '单集场景上限']),
      3,
      1,
      5,
    ),
    dialogueDensityPercent: integer(
      options.explicit.dialogueDensityPercent ?? firstValue(source, ['dialogueDensityPercent', 'dialogueDensity', '对白密度']),
      60,
      20,
      90,
    ),
    language: 'zh-CN',
    format: 'cn_short_drama',
    coreRequirements: text(firstValue(source, ['coreRequirements', 'requirements', '核心要求']), seed, 4_000),
    forbiddenElements: textArray(firstValue(source, ['forbiddenElements', 'forbidden', '禁止元素']), [], 30),
    endingDirection,
    ...(optionalText(firstValue(source, ['coverPrompt', 'cover_prompt', '封面提示词']), 4_000)
      ? { coverPrompt: optionalText(firstValue(source, ['coverPrompt', 'cover_prompt', '封面提示词']), 4_000) }
      : {}),
    createdAt: options.current?.createdAt ?? options.now,
    updatedAt: options.now,
  };
}

function phaseFor(plan: ScriptPlan, episodeNumber: number): string {
  const progress = episodeNumber / plan.totalEpisodes;
  if (progress <= 0.2) return '危机显现';
  if (progress <= 0.45) return '主动破局';
  if (progress <= 0.7) return '局势逆转';
  if (progress <= 0.9) return '终局逼近';
  return '结局兑现';
}

export interface CoerceOutlineChunkOptions {
  plan: ScriptPlan;
  start: number;
  end: number;
  previousBoundary?: readonly UnknownRecord[];
}

/** Reindexes, de-duplicates and fills one outline range from the approved plan. */
export function coerceSeriesOutlineChunk(
  value: unknown,
  options: CoerceOutlineChunkOptions,
): UnknownRecord {
  const source = unwrapped(value, ['series_outline_chunk', 'series_outline', 'outline', '大纲']);
  const rawCardsValue = firstValue(source, ['episodeCards', 'episode_cards', 'episodes', '分集卡']);
  const rawCards = Array.isArray(rawCardsValue) ? rawCardsValue.map(record) : [];
  const cardsByNumber = new Map<number, UnknownRecord>();
  const unnumberedCards: UnknownRecord[] = [];
  for (const candidate of rawCards) {
    const number = integer(firstValue(candidate, ['episodeNumber', 'episode', 'number', '集号']), -1, -1, 200);
    if (number >= options.start && number <= options.end && !cardsByNumber.has(number)) {
      cardsByNumber.set(number, candidate);
    } else if (number < options.start || number > options.end) {
      unnumberedCards.push(candidate);
    }
  }
  const previousHook = options.previousBoundary?.at(-1)?.endingHook;
  const cards = Array.from({ length: options.end - options.start + 1 }, (_, offset) => {
    const episodeNumber = options.start + offset;
    const candidate = cardsByNumber.get(episodeNumber) ?? unnumberedCards.shift() ?? {};
    const phase = phaseFor(options.plan, episodeNumber);
    const bridge = offset === 0 && typeof previousHook === 'string' && previousHook.trim()
      ? `承接上一集“${previousHook.trim()}”，`
      : '';
    const defaultEvent = `主角围绕“${options.plan.coreConflict}”推进到${phase}阶段，并形成一次可见结果。`;
    return {
      episodeNumber,
      title: text(firstValue(candidate, ['title', 'name', '标题']), `第${episodeNumber}集 ${phase}`, 200),
      logline: text(firstValue(candidate, ['logline', 'summary', '概要']), `${bridge}${defaultEvent}`, 2_000),
      mainEvent: text(firstValue(candidate, ['mainEvent', 'main_event', 'event', '主要事件']), defaultEvent, 2_000),
      endingHook: text(
        firstValue(candidate, ['endingHook', 'ending_hook', 'hook', '结尾卡点']),
        episodeNumber === options.plan.totalEpisodes
          ? options.plan.endingDirection
          : `新的阻力或线索出现，把剧情推向${phaseFor(options.plan, episodeNumber + 1)}阶段。`,
        2_000,
      ),
    };
  });
  return {
    synopsis: text(firstValue(source, ['synopsis', 'summary', '全剧概要']), options.plan.logline, 20_000),
    openingState: text(firstValue(source, ['openingState', 'opening', '开场状态']), `故事从“${options.plan.coreConflict}”显现开始。`, 4_000),
    midpointTurn: text(firstValue(source, ['midpointTurn', 'midpoint', '中点转折']), `主角围绕“${options.plan.coreConflict}”由守转攻。`, 4_000),
    climax: text(firstValue(source, ['climax', '高潮']), `核心冲突在终局正面爆发。`, 4_000),
    endingState: text(firstValue(source, ['endingState', 'ending', '结局状态']), options.plan.endingDirection, 4_000),
    mainArc: textArray(firstValue(source, ['mainArc', 'main_arc', '主线']), [options.plan.coreConflict, options.plan.endingDirection], 100),
    subplotArcs: textArray(firstValue(source, ['subplotArcs', 'subplot_arcs', '副线']), options.plan.highlights, 100),
    episodeCards: cards,
  };
}

function safeCharacterId(value: unknown, index: number, used: Set<string>): string {
  let id = typeof value === 'string' && SAFE_ID.test(value) ? value : `character-${index + 1}`;
  if (!used.has(id)) {
    used.add(id);
    return id;
  }
  let suffix = 2;
  while (used.has(`${id}-${suffix}`)) suffix += 1;
  id = `${id}-${suffix}`;
  used.add(id);
  return id;
}

function defaultCharacterCandidates(): UnknownRecord[] {
  return [
    { id: 'lead', name: '主角', role: 'lead' },
    { id: 'antagonist', name: '主要对手', role: 'antagonist' },
    { id: 'support', name: '关键助手', role: 'supporting' },
  ];
}

export function coerceCharacterBibleCandidate(
  value: unknown,
  options: { projectId: string; now: string; plan: ScriptPlan },
): ScriptCharacter[] {
  const source = unwrapped(value, ['character_bible', 'bible', '人物圣经']);
  const rawValue = firstValue(source, ['characters', 'characterCards', '角色']);
  const rawCharacters = Array.isArray(rawValue)
    ? rawValue.map(record).filter((item) => Object.keys(item).length > 0)
    : [];
  const candidates = rawCharacters.length > 0 ? rawCharacters : defaultCharacterCandidates();
  const usedIds = new Set<string>();
  const usedNames = new Map<string, number>();
  const provisional = candidates.slice(0, 100).map((candidate, index) => {
    const id = safeCharacterId(firstValue(candidate, ['id', 'characterId', '人物id']), index, usedIds);
    const rawName = text(firstValue(candidate, ['name', 'characterName', '姓名']), `人物${index + 1}`, 100);
    const normalizedName = rawName.normalize('NFKC').toLocaleLowerCase('zh-CN');
    const seenCount = usedNames.get(normalizedName) ?? 0;
    usedNames.set(normalizedName, seenCount + 1);
    const name = seenCount === 0 ? rawName : `${rawName}${seenCount + 1}`.slice(0, 100);
    let role = enumValue(firstValue(candidate, ['role', 'type', '人物类型']),
      ['lead', 'supporting', 'antagonist', 'minor'], {
        '主角': 'lead', '配角': 'supporting', '反派': 'antagonist', '次要': 'minor', '路人': 'minor',
      }, index === 0 ? 'lead' : index === 1 ? 'antagonist' : 'supporting');
    const ageValue = firstValue(candidate, ['age', '年龄']);
    const age = ageValue === undefined ? undefined : integer(ageValue, 25, 0, 150);
    return {
      id,
      projectId: options.projectId,
      name,
      aliases: textArray(firstValue(candidate, ['aliases', 'alias', '别名']), [], 20),
      role,
      ...(age === undefined ? {} : { age }),
      ...(optionalText(firstValue(candidate, ['occupation', '职业']), 300)
        ? { occupation: optionalText(firstValue(candidate, ['occupation', '职业']), 300) }
        : {}),
      identity: text(firstValue(candidate, ['identity', '身份']), `${name}是推动主线的重要人物`, 2_000),
      biography: text(firstValue(candidate, ['biography', 'bio', '人物小传']), `${name}因“${options.plan.coreConflict}”卷入故事。`, 8_000),
      motivation: text(firstValue(candidate, ['motivation', '动机']), `解决与“${options.plan.coreConflict}”有关的问题`, 2_000),
      goal: text(firstValue(candidate, ['goal', '目标']), options.plan.endingDirection, 2_000),
      weakness: text(firstValue(candidate, ['weakness', '弱点']), '在压力下容易独自承担', 2_000),
      arc: text(firstValue(candidate, ['arc', '人物弧光']), '在行动中完成认知与关系上的成长', 4_000),
      appearance: text(firstValue(candidate, ['appearance', '外貌']), '具有清晰辨识度的当代人物形象', 2_000),
      hairstyle: text(firstValue(candidate, ['hairstyle', '发型']), '符合人物身份的日常发型', 1_000),
      physique: text(firstValue(candidate, ['physique', '体格']), '普通体型', 1_000),
      defaultOutfit: text(firstValue(candidate, ['defaultOutfit', 'outfit', '默认服装']), '符合人物身份的日常服装', 2_000),
      personality: textArray(firstValue(candidate, ['personality', 'traits', '性格']), ['目标明确'], 20),
      skills: textArray(firstValue(candidate, ['skills', '技能']), [], 20),
      speechStyle: text(firstValue(candidate, ['speechStyle', 'speech', '语言风格']), '自然、简洁，符合人物身份', 2_000),
      catchphrases: textArray(firstValue(candidate, ['catchphrases', '口头禅']), [], 20),
      rawRelationships: Array.isArray(firstValue(candidate, ['relationships', '关系']))
        ? firstValue(candidate, ['relationships', '关系']) as unknown[]
        : [],
      revision: 0,
      updatedAt: options.now,
    };
  });

  let primaryCount = 0;
  return provisional.map((character) => {
    let role = character.role;
    if (role !== 'minor') {
      primaryCount += 1;
      if (primaryCount > options.plan.maxPrimaryCharacters) role = 'minor';
    }
    const relationships = character.rawRelationships
      .map(record)
      .map((relationship) => ({
        characterId: text(firstValue(relationship, ['characterId', 'id', '人物id']), '', 128),
        label: text(firstValue(relationship, ['label', 'relation', '关系']), '有关联', 100),
        notes: optionalText(firstValue(relationship, ['notes', '说明']), 1_000),
      }))
      .filter((relationship) =>
        SAFE_ID.test(relationship.characterId)
        && relationship.characterId !== character.id
        && usedIds.has(relationship.characterId))
      .map((relationship) => ({
        characterId: relationship.characterId,
        label: relationship.label,
        ...(relationship.notes ? { notes: relationship.notes } : {}),
      }));
    const { rawRelationships: _rawRelationships, ...rest } = character;
    return { ...rest, role, relationships };
  });
}

export function coerceWorldBibleCandidate(
  value: unknown,
  options: { projectId: string; now: string; plan: ScriptPlan },
): ScriptWorldBible {
  const source = unwrapped(value, ['world_bible', 'worldBible', 'world', '世界观']);
  const primaryLocations = textArray(
    firstValue(source, ['primaryLocations', 'locations', '主要地点']),
    ['主要故事场景'],
    50,
  );
  return {
    projectId: options.projectId,
    era: text(firstValue(source, ['era', 'timePeriod', '时代']), '当代', 1_000),
    primaryLocations,
    worldState: text(firstValue(source, ['worldState', 'state', '世界状态']), `围绕“${options.plan.theme}”展开的现实世界。`, 8_000),
    rules: textArray(firstValue(source, ['rules', 'worldRules', '规则']), [], 100),
    transport: textArray(firstValue(source, ['transport', '交通']), [], 50),
    communication: textArray(firstValue(source, ['communication', '通讯']), [], 50),
    organizations: textArray(firstValue(source, ['organizations', '组织']), [], 100),
    recurringProps: textArray(firstValue(source, ['recurringProps', 'props', '重复道具']), [], 100),
    forbiddenAnachronisms: textArray(firstValue(source, ['forbiddenAnachronisms', 'anachronisms', '禁止时代错位']), [], 100),
    revision: 0,
    updatedAt: options.now,
  };
}
