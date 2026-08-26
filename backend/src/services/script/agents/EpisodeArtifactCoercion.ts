import type {
  ScriptBlock,
  ScriptEpisode,
  ScriptEpisodeCard,
  ScriptEpisodeOutline,
  ScriptInteriorExterior,
  ScriptPlannedScene,
  ScriptPlan,
  ScriptTimeOfDay,
} from '../domain.js';
import { ScriptModelOutputError } from './structuredOutput.js';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function first(source: UnknownRecord, keys: readonly string[]): unknown {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
  return undefined;
}

function text(value: unknown, fallback = '', max = 20_000): string {
  const candidate = typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
  return (candidate || fallback).slice(0, max);
}

function strings(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return [...new Set(source
    .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    .map((item) => String(item).trim())
    .filter(Boolean))];
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) ? parsed : undefined;
}

function timeOfDay(value: unknown, fallback: ScriptTimeOfDay = 'day'): ScriptTimeOfDay {
  const normalized = text(value).toLocaleLowerCase('zh-CN');
  if (normalized === 'night' || normalized === '夜' || normalized === '晚上') return 'night';
  if (normalized === 'dawn' || normalized === '晨' || normalized === '清晨') return 'dawn';
  if (normalized === 'dusk' || normalized === '黄昏' || normalized === '傍晚') return 'dusk';
  if (normalized === 'day' || normalized === '日' || normalized === '白天') return 'day';
  return fallback;
}

function interiorExterior(
  value: unknown,
  fallback: ScriptInteriorExterior = 'interior',
): ScriptInteriorExterior {
  const normalized = text(value).toLocaleLowerCase('zh-CN');
  if (normalized === 'exterior' || normalized === '外' || normalized === '外景') return 'exterior';
  if (normalized === 'interior' || normalized === '内' || normalized === '内景') return 'interior';
  return fallback;
}

export function coercePlannedScenes(
  value: unknown,
  options: { fallbackPurpose?: string; max?: number } = {},
): ScriptPlannedScene[] {
  const raw = Array.isArray(value) ? value : [];
  const candidates = raw.length > 0 ? raw : [{ purpose: options.fallbackPurpose }];
  return candidates.slice(0, options.max ?? 20).map((candidate, index) => {
    const source = record(candidate);
    return {
      ordinal: index + 1,
      location: text(first(source, ['location', 'place', 'scene', '地点']), '未指定地点', 300),
      timeOfDay: timeOfDay(first(source, ['timeOfDay', 'time', '时间'])),
      interiorExterior: interiorExterior(first(source, ['interiorExterior', 'space', '内外景'])),
      purpose: text(
        first(source, ['purpose', 'goal', 'event', 'content', '场景目的']),
        options.fallbackPurpose || `推进第 ${index + 1} 场事件`,
        2_000,
      ),
    };
  });
}

export function coerceEpisodeOutlineCandidate(
  value: unknown,
  options: {
    projectId: string;
    episodeNumber: number;
    card: ScriptEpisodeCard;
    registeredCharacterIds: ReadonlySet<string>;
    createId: () => string;
  },
): ScriptEpisodeOutline {
  const source = record(value);
  const rawCharacterIds = strings(first(source, ['characterIds', 'characters', '人物']));
  const characterIds = rawCharacterIds.filter((id) => options.registeredCharacterIds.has(id));
  const goal = text(first(source, ['goal', 'episodeGoal', '目标']), options.card.logline, 2_000);
  const conflict = text(first(source, ['conflict', '核心冲突', '冲突']), options.card.mainEvent, 2_000);
  const beats = strings(first(source, ['beats', 'beat', '节拍']));
  const plannedScenesValue = first(source, ['plannedScenes', 'scenes', '场景']);
  return {
    id: options.createId(),
    projectId: options.projectId,
    episodeNumber: options.episodeNumber,
    title: text(first(source, ['title', 'name', '标题']), options.card.title, 200),
    goal,
    conflict,
    beats: beats.length > 0 ? beats : [conflict],
    characterIds,
    plannedScenes: Array.isArray(plannedScenesValue) && plannedScenesValue.length > 0
      ? coercePlannedScenes(plannedScenesValue, { fallbackPurpose: conflict })
      : [],
    ...(text(first(source, ['reveal', '揭示'])) ? { reveal: text(first(source, ['reveal', '揭示']), '', 2_000) } : {}),
    ...(text(first(source, ['reversal', '反转'])) ? { reversal: text(first(source, ['reversal', '反转']), '', 2_000) } : {}),
    endingHook: text(first(source, ['endingHook', 'hook', '结尾卡点']), options.card.endingHook, 2_000),
    requiredFacts: strings(first(source, ['requiredFacts', 'required', '必须事实'])),
    forbiddenFacts: strings(first(source, ['forbiddenFacts', 'forbidden', '禁止事实'])),
    status: 'expanded',
    revision: 0,
  };
}

function cleanBlockText(type: 'caption' | 'action' | 'dialogue', value: string, speaker: string): string {
  let result = value.trim();
  if (type === 'caption') result = result.replace(/^【?\s*字幕\s*[：:]\s*/u, '').replace(/】$/u, '');
  if (type === 'action') result = result.replace(/^[△▲]\s*/u, '');
  if (type === 'dialogue' && speaker) {
    result = result.replace(new RegExp(`^${speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[（(][^）)]*[）)])?\\s*[：:]\\s*`, 'u'), '');
  }
  return result.trim();
}

function coerceBlock(value: unknown, createId: () => string): ScriptBlock | undefined {
  const source = typeof value === 'string' ? { text: value, type: 'action' } : record(value);
  let rawText = text(first(source, ['text', 'content', 'body', '正文']));
  if (!rawText) return undefined;
  const rawType = text(first(source, ['type', 'kind', '类型'])).toLocaleLowerCase('zh-CN');
  const rawSpeaker = text(first(source, ['speaker', 'character', 'name', '说话人']), '', 100);
  const embedded = /^([^：:\n]{1,30})(?:[（(]([^）)]*)[）)])?\s*[：:]\s*(.+)$/u.exec(rawText);
  const speaker = rawSpeaker || embedded?.[1]?.trim() || '';
  if (!rawSpeaker && embedded?.[3]) rawText = embedded[3].trim();
  const type = rawType === 'caption' || rawType === '字幕'
    ? 'caption'
    : rawType === 'dialogue' || rawType === '对白' || Boolean(speaker)
      ? 'dialogue'
      : 'action';
  if (type === 'caption' || type === 'action') {
    return { id: createId(), type, text: cleanBlockText(type, rawText, '') };
  }
  if (!speaker) return { id: createId(), type: 'action', text: cleanBlockText('action', rawText, '') };
  const modeValue = text(source.mode).toLocaleLowerCase('en-US');
  const mode = modeValue === 'os' || modeValue === 'vo' ? modeValue : 'normal';
  const characterId = text(first(source, ['characterId', 'character_id', '人物id']), '', 128);
  const delivery = text(first(source, ['delivery', 'tone', '语气']), '', 100);
  return {
    id: createId(),
    type: 'dialogue',
    ...(characterId ? { characterId } : {}),
    speaker,
    ...(delivery ? { delivery } : {}),
    mode,
    text: cleanBlockText('dialogue', rawText, speaker),
  };
}

export function coerceEpisodeDraftCandidate(
  value: unknown,
  options: {
    projectId: string;
    outline: ScriptEpisodeOutline;
    plan: ScriptPlan;
    current?: ScriptEpisode;
    createId: () => string;
    now: string;
  },
): ScriptEpisode {
  const source = record(value);
  const suppliedEpisodeNumber = number(first(source, ['episodeNumber', 'episode', '集号']));
  if (suppliedEpisodeNumber !== undefined && (
    suppliedEpisodeNumber < 1 || suppliedEpisodeNumber > options.plan.totalEpisodes
  )) {
    throw new ScriptModelOutputError(`模型返回的集号 ${suppliedEpisodeNumber} 超出 1—${options.plan.totalEpisodes}。`);
  }
  const rawScenes = Array.isArray(source.scenes) ? source.scenes : [];
  const episodeBody = text(first(source, ['content', 'text', 'body', 'script', '正文']));
  const sceneSources: unknown[] = rawScenes.length > 0
    ? rawScenes
    : episodeBody ? [{ blocks: [{ type: 'action', text: episodeBody }] }] : [];
  const scenes = sceneSources.flatMap((candidate, index) => {
    const scene = record(candidate);
    const planned = options.outline.plannedScenes[index];
    const rawBlocks = Array.isArray(scene.blocks)
      ? scene.blocks
      : text(first(scene, ['content', 'text', 'body', '正文']))
        ? [text(first(scene, ['content', 'text', 'body', '正文']))]
        : [];
    const blocks = rawBlocks.flatMap((block) => {
      const normalized = coerceBlock(block, options.createId);
      return normalized && normalized.text.trim() ? [normalized] : [];
    });
    if (blocks.length === 0) return [];
    return [{
      id: options.createId(),
      ordinal: index + 1,
      location: text(first(scene, ['location', 'place', '地点']), planned?.location || '未指定地点', 300),
      timeOfDay: timeOfDay(first(scene, ['timeOfDay', 'time', '时间']), planned?.timeOfDay),
      interiorExterior: interiorExterior(
        first(scene, ['interiorExterior', 'space', '内外景']),
        planned?.interiorExterior,
      ),
      characterIds: strings(first(scene, ['characterIds', 'characters', '人物'])),
      blocks,
    }];
  });
  if (scenes.length === 0) throw new ScriptModelOutputError('模型未返回可见正文。', 'empty_output');
  return {
    id: options.current?.id ?? options.createId(),
    projectId: options.projectId,
    episodeNumber: options.outline.episodeNumber,
    title: text(first(source, ['title', 'name', '标题']), options.outline.title, 200),
    outlineId: options.outline.id,
    status: 'reviewing',
    targetChars: options.plan.targetCharsPerEpisode,
    scenes,
    summary: text(source.summary, options.outline.goal, 4_000),
    newFacts: strings(source.newFacts),
    openedThreads: strings(source.openedThreads),
    closedThreads: strings(source.closedThreads),
    revision: options.current?.revision ?? 0,
    createdAt: options.current?.createdAt ?? options.now,
    updatedAt: options.now,
  };
}
