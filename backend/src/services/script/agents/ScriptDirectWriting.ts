import { createHash } from 'node:crypto';

import type {
  ScriptCharacter,
  ScriptEpisode,
  ScriptEpisodeContinuityCommitInput,
  ScriptEpisodeOutline,
  ScriptPlan,
  ScriptProjectState,
  ScriptWorldBible,
} from '../domain.js';
import { projectScriptContinuity } from '../ScriptContinuityCommit.js';
import type { ScriptTextParseWarning } from '../parsers/chineseShortDramaText.js';
import {
  scriptCreativeWritingInstruction,
  scriptQualityReviewInstruction,
} from './ScriptCreativeRules.js';
import { scriptEpisodeLengthRange } from './ScriptEpisodeLength.js';

export const SCRIPT_DIRECT_ISSUE_CODES = [
  'OFF_OUTLINE',
  'WRONG_GENRE_OR_SETTING',
  'CHARACTER_IDENTITY_CONFLICT',
  'DUPLICATE_MAJOR_EVENT',
  'CAUSAL_CONTRADICTION',
  'PROP_STATE_CONTRADICTION',
] as const;

export type ScriptDirectIssueCode = typeof SCRIPT_DIRECT_ISSUE_CODES[number];

export interface ScriptDirectReviewIssue {
  code: ScriptDirectIssueCode;
  sceneNumber?: number;
  evidence: string;
  expected: string;
}

export interface ScriptDirectHandoffReview {
  verdict: 'pass' | 'major_issue';
  issues: ScriptDirectReviewIssue[];
  qualityNotes?: string[];
  handoff: {
    summary: string;
    characterStates: Array<{
      characterId: string;
      location?: string;
      state: string;
      knows: string[];
    }>;
    props: Array<{
      name: string;
      holder?: string;
      location?: string;
      state: string;
    }>;
    openThreads: string[];
    ending: string;
  };
}

export interface ScriptDirectDraftArtifact {
  schemaVersion: 1;
  stage: 'direct_draft' | 'direct_continuation' | 'direct_rewrite';
  rawText: string;
  episode: ScriptEpisode;
  candidateHash: string;
  parseWarnings: ScriptTextParseWarning[];
  createdAt: string;
}

export interface ScriptDirectReviewArtifact {
  schemaVersion: 1;
  stage: 'direct_review';
  review: ScriptDirectHandoffReview;
  createdAt: string;
}

function hasNextEpisodeDirection(context: Record<string, unknown>): boolean {
  return Boolean(
    context.nextEpisodeDirection &&
    typeof context.nextEpisodeDirection === 'object' &&
    !Array.isArray(context.nextEpisodeDirection)
  );
}

function targetCharsFromContext(context: Record<string, unknown>): number | undefined {
  if (!context.episode || typeof context.episode !== 'object' || Array.isArray(context.episode)) {
    return undefined;
  }
  const target = (context.episode as Record<string, unknown>).targetChars;
  return typeof target === 'number' && Number.isFinite(target) && target > 0
    ? Math.floor(target)
    : undefined;
}

function creativeRulesFromContext(context: Record<string, unknown>): ScriptPlan['creativeRules'] {
  if (!context.project || typeof context.project !== 'object' || Array.isArray(context.project)) {
    return undefined;
  }
  return (context.project as { creativeRules?: ScriptPlan['creativeRules'] }).creativeRules;
}

function directLengthInstruction(context: Record<string, unknown>): string {
  const targetChars = targetCharsFromContext(context);
  if (!targetChars) return '正文保持紧凑完整，不要靠重复台词凑字。';
  const { minimum, maximum } = scriptEpisodeLengthRange(targetChars);
  return `正文以 ${targetChars} 个可见字符为目标，尽量控制在约 ${minimum}—${maximum} 字。字数是软目标，必须优先保证剧情和每句话完整；绝不能把一句话写一半后用省略号代替未写内容。不要靠重复台词凑字。`;
}

const REPEATED_PLOT_ACTIONS = [
  { key: 'open', pattern: /打开|拉开|推开|掀开|翻开/u },
  { key: 'take', pattern: /拿起|取出|掏出|捡起|抽出/u },
  { key: 'inspect', pattern: /看着|查看|盯着|看向|端详|翻看|检查/u },
  { key: 'store', pattern: /放回|收起|关上|合上|锁上|藏进/u },
  { key: 'handoff', pattern: /递给|交给|交出|接过/u },
  { key: 'destroy', pattern: /撕碎|烧掉|销毁|摔碎/u },
] as const;

const REPEATED_PLOT_OBJECTS = [
  { key: 'drawer', label: '抽屉或柜子', pattern: /抽屉|柜子|工具柜|保险柜/u },
  { key: 'photo', label: '照片或相框', pattern: /相框|照片|合影/u },
  { key: 'phone', label: '手机', pattern: /手机|电话|来电/u },
  { key: 'document', label: '文件或账本', pattern: /文件|档案|合同|账本|登记表|名单/u },
  { key: 'recording', label: '录音或数据', pattern: /录音笔|录音|录像|数据卡|存储卡|U盘/u },
  { key: 'letter', label: '信件', pattern: /信封|信件|遗书|纸条/u },
  { key: 'key', label: '钥匙', pattern: /钥匙|门卡/u },
  { key: 'box', label: '箱盒', pattern: /纸箱|木箱|盒子|首饰盒/u },
  { key: 'jewelry', label: '首饰', pattern: /项链|戒指|手镯|玉佩/u },
  { key: 'weapon', label: '武器', pattern: /匕首|刀|手枪|枪支/u },
] as const;

interface DirectPlotWindow {
  sceneNumber: number;
  text: string;
  objects: Set<string>;
  anchors: Set<string>;
}

function directPlotWindow(
  blocks: Array<{ sceneNumber: number; text: string }>,
  start: number,
  size: number,
): DirectPlotWindow {
  const selected = blocks.slice(start, start + size);
  const objects = new Set<string>();
  const anchors = new Set<string>();
  for (const block of selected) {
    const blockActions = REPEATED_PLOT_ACTIONS.filter((item) => item.pattern.test(block.text));
    const blockObjects = REPEATED_PLOT_OBJECTS.filter((item) => item.pattern.test(block.text));
    blockObjects.forEach((item) => objects.add(item.key));
    blockActions.forEach((action) => {
      blockObjects.forEach((object) => anchors.add(`${action.key}:${object.key}`));
    });
  }
  return {
    sceneNumber: selected[0]?.sceneNumber ?? 1,
    text: selected.map((item) => item.text).join(' '),
    objects,
    anchors,
  };
}

/**
 * Finds only high-confidence replays of a concrete prop/action chain. It is
 * deliberately narrower than semantic similarity so ordinary callbacks and
 * recurring props do not trigger another model pass.
 */
export function detectRepeatedDirectPlotEvents(
  episode: ScriptEpisode,
): ScriptDirectReviewIssue[] {
  const narrativeBlocks = episode.scenes.flatMap((scene) => scene.blocks
    .filter((block) => block.type === 'action' || block.type === 'caption')
    .map((block) => ({ sceneNumber: scene.ordinal, text: block.text.trim() }))
    .filter((block) => block.text.length > 0));
  const windowSize = 2;
  const windows = narrativeBlocks.map((_, index) => directPlotWindow(
    narrativeBlocks,
    index,
    windowSize,
  ));

  for (let leftIndex = 0; leftIndex < windows.length; leftIndex += 1) {
    const left = windows[leftIndex]!;
    if (left.objects.size < 2 || left.anchors.size === 0) continue;
    for (let rightIndex = leftIndex + windowSize; rightIndex < windows.length; rightIndex += 1) {
      const right = windows[rightIndex]!;
      const commonObjects = [...left.objects].filter((key) => right.objects.has(key));
      const commonAnchors = [...left.anchors].filter((key) => right.anchors.has(key));
      if (commonObjects.length < 2 || commonAnchors.length < 1) continue;
      const objectLabels = commonObjects
        .map((key) => REPEATED_PLOT_OBJECTS.find((item) => item.key === key)?.label ?? key)
        .join('、');
      return [{
        code: 'DUPLICATE_MAJOR_EVENT',
        sceneNumber: right.sceneNumber,
        evidence: `前段“${left.text.slice(0, 160)}”与后段“${right.text.slice(0, 160)}”重复演了${objectLabels}的同一动作链`,
        expected: '同一道具动作链只完整演一次；后段应删除重复铺垫，直接增加新的发现、冲突或后果。',
      }];
    }
  }
  return [];
}

export function reconcileDirectReviewBoundary(
  context: Record<string, unknown>,
  review: ScriptDirectHandoffReview,
): ScriptDirectHandoffReview {
  if (hasNextEpisodeDirection(context)) return review;
  const issues = review.issues.filter((issue) => !(
    (issue.code === 'OFF_OUTLINE' || issue.code === 'DUPLICATE_MAJOR_EVENT') &&
    /(?:下一集|后续集|留待后续|留到后续)/u.test(issue.expected)
  ));
  return {
    ...review,
    verdict: issues.length > 0 ? 'major_issue' : 'pass',
    issues,
  };
}

function compactCharacter(character: ScriptCharacter): Record<string, unknown> {
  return {
    id: character.id,
    name: character.name,
    aliases: character.aliases,
    identity: character.identity,
    occupation: character.occupation,
    motivation: character.motivation,
    goal: character.goal,
    weakness: character.weakness,
    personality: character.personality,
    speechStyle: character.speechStyle,
    catchphrases: character.catchphrases,
    relationships: character.relationships,
  };
}

function compactWorld(world: ScriptWorldBible): Record<string, unknown> {
  return {
    era: world.era,
    primaryLocations: world.primaryLocations,
    worldState: world.worldState,
    rules: world.rules,
    organizations: world.organizations,
    recurringProps: world.recurringProps,
    forbiddenAnachronisms: world.forbiddenAnachronisms,
  };
}

function previousEpisodeContext(state: ScriptProjectState, episodeNumber: number): Record<string, unknown> {
  const previous = state.episodes.find((episode) => episode.episodeNumber === episodeNumber - 1);
  if (!previous) return {};
  const tail = previous.scenes
    .flatMap((scene) => scene.blocks.map((block) => block.text.trim()))
    .filter(Boolean)
    .join('\n')
    .slice(-1_200);
  return {
    summary: previous.summary,
    newFacts: previous.newFacts,
    openedThreads: previous.openedThreads,
    endingTail: tail,
  };
}

export function directWritingContext(
  state: ScriptProjectState,
  plan: ScriptPlan,
  outline: ScriptEpisodeOutline,
): Record<string, unknown> {
  const involvedIds = new Set(outline.characterIds);
  const involvedCharacters = state.characters.filter((character) => involvedIds.has(character.id));
  const nextCard = state.seriesOutline?.episodeCards.find(
    (card) => card.episodeNumber === outline.episodeNumber + 1,
  );
  return {
    project: {
      title: plan.title,
      theme: plan.theme,
      genres: plan.genres,
      highlights: plan.highlights,
      coreConflict: plan.coreConflict,
      coreRequirements: plan.coreRequirements,
      forbiddenElements: plan.forbiddenElements,
      creativeRules: plan.creativeRules,
    },
    episode: {
      episodeNumber: outline.episodeNumber,
      title: outline.title,
      goal: outline.goal,
      conflict: outline.conflict,
      beats: outline.beats,
      reveal: outline.reveal,
      reversal: outline.reversal,
      requiredFacts: outline.requiredFacts,
      forbiddenFacts: outline.forbiddenFacts,
      endingHook: outline.endingHook,
      maxScenes: plan.maxScenesPerEpisode,
      targetChars: plan.targetCharsPerEpisode,
      dialogueDensityPercent: plan.dialogueDensityPercent,
    },
    characters: involvedCharacters.map(compactCharacter),
    world: compactWorld(state.worldBible!),
    previousEpisode: previousEpisodeContext(state, outline.episodeNumber),
    continuity: projectScriptContinuity(state, outline.episodeNumber),
    nextEpisodeDirection: nextCard
      ? { title: nextCard.title, logline: nextCard.logline, mainEvent: nextCard.mainEvent }
      : undefined,
  };
}

export function buildDirectDraftPrompt(context: Record<string, unknown>): string {
  const boundaryInstruction = hasNextEpisodeDirection(context)
    ? '本集必须在 endingHook 处停住；nextEpisodeDirection 是下一集边界，只能做铺垫，绝不能提前完成下一集事件、后续决赛或全剧结局。'
    : '这是全剧最后一集，nextEpisodeDirection 为空；必须完成本集分集卡、endingHook 与已确认的全剧结局，不得凭空保留到不存在的下一集。';
  return [
    '请严格照已确认的当前分集卡，直接写出本集完整中文短剧正文。',
    '这是创作任务，不是数据填表；不要解释，不要分析，不要输出 JSON 或 Markdown 围栏。',
    '必须保持项目题材、人物身份、职业、关系和证物状态一致，不能把项目换成另一种题材。',
    '必须落实本集 goal、conflict、beats 与 endingHook；forbiddenFacts 和 forbiddenElements 不得出现。',
    boundaryInstruction,
    directLengthInstruction(context),
    '同一道具动作链只能完整演一次。例如已经写过“打开抽屉—拿起照片—看完放回”，后面不能换个人再次从打开同一抽屉、查看同一照片重新演起，必须直接写新的发现、冲突或后果。',
    '对白比例允许按剧情自然波动，对白要用冲突推进。',
    scriptCreativeWritingInstruction({ creativeRules: creativeRulesFromContext(context) }),
    '若创作要求禁止临时角色对白，就让路人用动作表达；否则前台、保安、快递员等临时角色必须用自己的称谓署名，绝不能把他们的台词挂到主角或其他登记人物名下。',
    '通常控制在 maxScenes 场；如完整讲清本集确有需要，最多可以写5场，不要因场数限制截断主要事件。',
    '只使用以下格式：',
    '第N集：',
    'N-1 日或夜 内或外 具体地点',
    '人物：登记人物名（人物在全剧第一次出场时，在姓名后用括号写明身份或角色；之后不重复）',
    '【字幕：文字】',
    '△可拍摄的无对白动作或神态；景别写成△【特写】动作',
    '人物（可选语气、OS或VO）：对白',
    '回忆段落分别用【闪回】和【闪回结束】包住；OS必须跟人物心里所想的话，VO只用于画外能听见但看不到人物的声音。',
    '场号从1连续递增；普通对白人物必须列在本场人物行，OS/VO人物必须是登记人物。',
    `创作资料：${JSON.stringify(context)}`,
  ].join('\n');
}

export function buildDirectContinuationPrompt(
  context: Record<string, unknown>,
  rawText: string,
  currentChars: number,
  targetChars: number,
): string {
  const suggestedAddition = Math.max(200, Math.min(900, targetChars - currentChars));
  return [
    '下面是一集已经写完但明显偏短的中文短剧。请从现有结尾自然继续，补充冲突、行动与对白。',
    '不要重写已有内容，不要复述已经发生的事件，不要再次制造“首次发现”同一证物；同一抽屉、照片、手机或文件的打开—拿取—查看动作链已经演过，就直接续写新的信息或后果。',
    '可以继续最后一场或增加下一场；只输出新增的标准剧本文本，不要输出解释、JSON或Markdown围栏。',
    `当前约 ${currentChars} 字，建议最多新增约 ${suggestedAddition} 字，并尽量让整集不超过 ${scriptEpisodeLengthRange(targetChars).maximum} 个可见字符；但必须写完每句话和当前动作，不得用省略号代替未完成内容。`,
    `创作资料：${JSON.stringify(context)}`,
    `已有完整正文：\n${rawText}`,
  ].join('\n');
}

export function buildDirectReviewPrompt(
  context: Record<string, unknown>,
  rawText: string,
): string {
  const boundaryInstruction = hasNextEpisodeDirection(context)
    ? '必须逐项比较本集 endingHook 与 nextEpisodeDirection：若正文越过 endingHook，提前完成下一集、后续高潮或结局，必须判 major_issue，并使用 OFF_OUTLINE 或 DUPLICATE_MAJOR_EVENT。'
    : '这是全剧最后一集，nextEpisodeDirection 为空：正文应完成本集分集卡、endingHook 与已确认结局，禁止虚构“应留到下一集”并据此判错。';
  return [
    '你是短剧明显错误检查员，同时为下一集提取极简交接状态。',
    '只检查：跑出当前大纲、题材或场景类型错误、人物身份关系冲突、主要事件或具体道具动作链重复发生、明显因果倒置、重要道具状态矛盾。',
    '必须对照正文前段、中段和后段：换了人物、措辞或位置，仍再次完整演“打开同一抽屉—拿取/查看同一照片（或手机、文件）—收回”的，使用 DUPLICATE_MAJOR_EVENT；后段若直接核验、转交或产生新后果则不算重复。',
    boundaryInstruction,
    '不要评论服装丰富度、文学性、节奏、镜头、表演和普通台词润色。没有明显错误必须 verdict=pass、issues=[]。',
    '只返回 JSON：',
    '{"verdict":"pass|major_issue","issues":[{"code":"OFF_OUTLINE|WRONG_GENRE_OR_SETTING|CHARACTER_IDENTITY_CONFLICT|DUPLICATE_MAJOR_EVENT|CAUSAL_CONTRADICTION|PROP_STATE_CONTRADICTION","sceneNumber":1,"evidence":"正文证据","expected":"大纲或连续性要求"}],"qualityNotes":["可选优化建议"],"handoff":{"summary":"本集摘要","characterStates":[{"characterId":"登记ID","location":"最后地点","state":"当前状态","knows":["已知信息"]}],"props":[{"name":"道具","holder":"人物ID","location":"地点","state":"状态"}],"openThreads":["未解决悬念"],"ending":"本集最后状态"}}',
    'issues 最多3条；不得虚构未在资料或正文中出现的信息。',
    scriptQualityReviewInstruction({ creativeRules: creativeRulesFromContext(context) }),
    `创作资料：${JSON.stringify(context)}`,
    `本集正文：\n${rawText}`,
  ].join('\n');
}

export function buildDirectRewritePrompt(
  context: Record<string, unknown>,
  rawText: string,
  issues: readonly ScriptDirectReviewIssue[],
  options: { rewriteFromOutline?: boolean } = {},
): string {
  const boundaryInstruction = hasNextEpisodeDirection(context)
    ? '重写后必须在本集 endingHook 停住，不得保留已经越界到 nextEpisodeDirection 或后续高潮的事件。'
    : '这是全剧最后一集：重写后必须完成本集 endingHook 与已确认结局，不得凭空删成“留待下一集”。';
  const offOutlineInstruction = issues.some((issue) => issue.code === 'OFF_OUTLINE')
    ? '存在 OFF_OUTLINE：必须彻底删除 evidence 涉及的越界人物、道具、证据和后续事件，不能只换说法或换地点保留；必要时整场重写，并精确停在本集 endingHook。'
    : '';
  const duplicateInstruction = issues.some((issue) => issue.code === 'DUPLICATE_MAJOR_EVENT')
    ? '存在 DUPLICATE_MAJOR_EVENT：保留第一次完整动作链，删除后面重复的开端和过程，把后段直接改成新的信息、冲突或后果；不能只换人物、地点或近义词后继续重复。'
    : '';
  if (options.rewriteFromOutline) {
    return [
      '上一版正文已被明确拒绝。请完全从分集卡重新写出本集完整中文短剧正文。',
      '不要参考、延续或改写上一版正文，只使用创作资料和下面列出的问题边界。',
      boundaryInstruction,
      offOutlineInstruction,
      duplicateInstruction,
      directLengthInstruction(context),
      '输出完整标准剧本文本，不要解释，不要JSON，不要Markdown围栏。',
      `禁止边界：${JSON.stringify(issues.slice(0, 3))}`,
      `创作资料：${JSON.stringify(context)}`,
    ].join('\n');
  }
  return [
    '请根据明确问题重写本集完整中文短剧正文。',
    '只修列出的大问题，保留原稿中没有问题的事件、人物关系和可用对白。',
    boundaryInstruction,
    offOutlineInstruction,
    duplicateInstruction,
    directLengthInstruction(context),
    '输出完整标准剧本文本，不要解释，不要JSON，不要Markdown围栏。',
    `问题：${JSON.stringify(issues.slice(0, 3))}`,
    `创作资料：${JSON.stringify(context)}`,
    `原正文：\n${rawText}`,
  ].join('\n');
}

/**
 * Last-resort local draft used only when the provider returns no usable body.
 * It deliberately stays small and editable, but preserves the confirmed
 * episode boundary, scene plan, cast and ending hook so the batch can finish.
 */
export function createMinimalDirectDraftFallback(
  projectId: string,
  outline: ScriptEpisodeOutline,
  plan: ScriptPlan,
  createId: () => string,
  now: string,
): ScriptEpisode {
  const plannedScenes = outline.plannedScenes.length > 0
    ? outline.plannedScenes
    : [{
        ordinal: 1,
        location: '未指定地点',
        timeOfDay: 'day' as const,
        interiorExterior: 'interior' as const,
        purpose: outline.goal || outline.conflict || '推进本集事件',
      }];
  const scenes = plannedScenes.map((plannedScene, index) => {
    const body = [
      plannedScene.purpose,
      index === 0 ? outline.conflict : '',
      index === plannedScenes.length - 1 ? outline.endingHook : '',
    ].map((item) => item.trim()).filter(Boolean);
    return {
      id: createId(),
      ordinal: index + 1,
      location: plannedScene.location.trim() || '未指定地点',
      timeOfDay: plannedScene.timeOfDay,
      interiorExterior: plannedScene.interiorExterior,
      characterIds: [...new Set(outline.characterIds)],
      blocks: [...new Set(body.length > 0 ? body : ['推进本集事件'])].map((text) => ({
        id: createId(),
        type: 'action' as const,
        text,
      })),
    };
  });
  return {
    id: createId(),
    projectId,
    episodeNumber: outline.episodeNumber,
    title: outline.title,
    outlineId: outline.id,
    status: 'reviewing',
    targetChars: plan.targetCharsPerEpisode,
    scenes,
    summary: outline.goal || outline.conflict || outline.title,
    newFacts: [],
    openedThreads: outline.endingHook ? [outline.endingHook] : [],
    closedThreads: [],
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** Makes review transport/JSON failures advisory and keeps the existing body. */
export function createLocalDirectHandoffReview(
  outline: ScriptEpisodeOutline,
  episode: ScriptEpisode,
): ScriptDirectHandoffReview {
  const visible = episode.scenes
    .flatMap((scene) => scene.blocks.map((block) => block.text.trim()))
    .filter(Boolean);
  return {
    verdict: 'pass',
    issues: [],
    qualityNotes: [],
    handoff: {
      summary: episode.summary?.trim() || outline.goal.trim() || visible.join('；').slice(0, 300),
      characterStates: [],
      props: [],
      openThreads: [...new Set([
        ...(episode.openedThreads ?? []),
        ...(outline.endingHook.trim() ? [outline.endingHook.trim()] : []),
      ])],
      ending: visible.at(-1) ?? outline.endingHook.trim(),
    },
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringValue).filter(Boolean)
    : [];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function decodeDirectHandoffReview(value: Record<string, unknown>): ScriptDirectHandoffReview {
  const requestedVerdict = value.verdict === 'major_issue' ? 'major_issue' : 'pass';
  const rawIssues = Array.isArray(value.issues) ? value.issues : [];
  const rawHandoff = value.handoff;
  const handoff = rawHandoff && typeof rawHandoff === 'object' && !Array.isArray(rawHandoff)
    ? rawHandoff as Record<string, unknown>
    : {};
  const issues = rawIssues.flatMap((candidate): ScriptDirectReviewIssue[] => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const issue = candidate as Record<string, unknown>;
    const code = stringValue(issue.code);
    if (!SCRIPT_DIRECT_ISSUE_CODES.includes(code as ScriptDirectIssueCode)) return [];
    const evidence = stringValue(issue.evidence);
    const expected = stringValue(issue.expected);
    if (!evidence || !expected) return [];
    const sceneNumber = typeof issue.sceneNumber === 'number' && Number.isInteger(issue.sceneNumber)
      ? issue.sceneNumber
      : undefined;
    return [{
      code: code as ScriptDirectIssueCode,
      ...(sceneNumber && sceneNumber > 0 ? { sceneNumber } : {}),
      evidence,
      expected,
    }];
  }).slice(0, 3);
  const verdict = requestedVerdict === 'major_issue' && issues.length > 0 ? 'major_issue' : 'pass';
  const qualityNotes = strings(value.qualityNotes).slice(0, 2);
  const characterStates = Array.isArray(handoff.characterStates)
    ? handoff.characterStates.flatMap((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
        const item = candidate as Record<string, unknown>;
        const characterId = stringValue(item.characterId);
        const state = stringValue(item.state);
        if (!characterId || !state) return [];
        const location = stringValue(item.location);
        return [{ characterId, ...(location ? { location } : {}), state, knows: strings(item.knows) }];
      })
    : [];
  const props = Array.isArray(handoff.props)
    ? handoff.props.flatMap((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
        const item = candidate as Record<string, unknown>;
        const name = stringValue(item.name);
        const state = stringValue(item.state);
        if (!name || !state) return [];
        const holder = stringValue(item.holder);
        const location = stringValue(item.location);
        return [{ name, ...(holder ? { holder } : {}), ...(location ? { location } : {}), state }];
      })
    : [];
  const summary = stringValue(handoff.summary);
  const ending = stringValue(handoff.ending);
  return {
    verdict,
    issues,
    qualityNotes,
    handoff: {
      summary,
      characterStates,
      props,
      openThreads: strings(handoff.openThreads),
      ending,
    },
  };
}

export function mergeDirectContinuation(base: ScriptEpisode, addition: ScriptEpisode): ScriptEpisode {
  const scenes = base.scenes.map((scene) => structuredClone(scene));
  for (const added of addition.scenes) {
    const existing = scenes.find((scene) => scene.ordinal === added.ordinal);
    if (existing) {
      existing.characterIds = [...new Set([...existing.characterIds, ...added.characterIds])];
      existing.blocks.push(...structuredClone(added.blocks));
    } else {
      scenes.push(structuredClone(added));
    }
  }
  scenes.sort((left, right) => left.ordinal - right.ordinal);
  return { ...base, scenes, updatedAt: addition.updatedAt };
}

function directStableId(prefix: string, value: string): string {
  return `direct-${prefix}-${createHash('sha256').update(value.normalize('NFKC')).digest('hex').slice(0, 20)}`;
}

function normalizedName(value: string): string {
  return value.normalize('NFKC').replace(/[\s·•]/gu, '').toLocaleLowerCase('zh-CN');
}

/**
 * Overlays the reviewer's compact handoff onto the existing deterministic
 * continuity candidate. The reviewer cannot invent characters: unknown IDs
 * and names are ignored, while props and ending state remain deterministic
 * and small enough to feed the next episode.
 */
export function mergeDirectHandoffContinuity(
  base: ScriptEpisodeContinuityCommitInput,
  review: ScriptDirectHandoffReview,
  episode: ScriptEpisode,
  characters: readonly ScriptCharacter[],
): ScriptEpisodeContinuityCommitInput {
  const result = structuredClone(base);
  const characterByKey = new Map<string, ScriptCharacter>();
  for (const character of characters) {
    for (const key of [character.id, character.name, ...character.aliases]) {
      characterByKey.set(normalizedName(key), character);
    }
  }
  const updates = new Map(result.characterUpdates.map((item) => [item.characterId, item]));
  const acceptedHandoffNotes: string[] = [];
  for (const state of review.handoff.characterStates) {
    const character = characterByKey.get(normalizedName(state.characterId));
    if (!character) continue;
    const existing = updates.get(character.id) ?? {
      characterId: character.id,
      knownFactsAdded: [],
      relationshipChanges: [],
    };
    existing.location = state.location?.trim() || existing.location;
    existing.emotionalState = state.state.trim();
    existing.knownFactsAdded = unique([...existing.knownFactsAdded, ...state.knows]);
    updates.set(character.id, existing);
    acceptedHandoffNotes.push(
      `人物 ${character.id}：${state.state}${state.location ? `；位置：${state.location}` : ''}`,
    );
  }
  result.characterUpdates = [...updates.values()];

  const finalBlockId = [...episode.scenes].reverse()
    .flatMap((scene) => [...scene.blocks].reverse())
    .find(Boolean)?.id;
  const props = new Map(result.props.map((item) => [normalizedName(item.name), item]));
  for (const handoffProp of review.handoff.props) {
    const name = handoffProp.name.trim();
    if (!name) continue;
    const key = normalizedName(name);
    const holder = handoffProp.holder
      ? characterByKey.get(normalizedName(handoffProp.holder))
      : undefined;
    const evidenceBlockIds = episode.scenes.flatMap((scene) => scene.blocks)
      .filter((block) => block.text.includes(name))
      .map((block) => block.id);
    const existing = props.get(key);
    props.set(key, {
      propId: existing?.propId ?? directStableId('prop', key),
      name,
      ...(holder ? { holderCharacterId: holder.id } : {}),
      state: [handoffProp.state.trim(), handoffProp.location?.trim()]
        .filter(Boolean)
        .join('；位置：'),
      evidenceBlockIds: evidenceBlockIds.length > 0
        ? evidenceBlockIds
        : finalBlockId ? [finalBlockId] : [],
    });
    acceptedHandoffNotes.push(
      `道具 ${name}：${handoffProp.state}${holder ? `；持有人：${holder.id}` : ''}${handoffProp.location ? `；位置：${handoffProp.location}` : ''}`,
    );
  }
  result.props = [...props.values()];
  result.nextEpisodeMustInherit = unique([
    ...result.nextEpisodeMustInherit,
    review.handoff.ending,
    ...acceptedHandoffNotes,
  ]);
  return result;
}

export function directEpisodeText(episode: ScriptEpisode, characters: readonly ScriptCharacter[]): string {
  const charactersById = new Map(characters.map((character) => [character.id, character]));
  const introducedCharacterIds = new Set<string>();
  const time = { day: '日', night: '夜', dawn: '晨', dusk: '黄昏' } as const;
  const space = { interior: '内', exterior: '外' } as const;
  const lines = [`第${episode.episodeNumber}集：`];
  for (const scene of episode.scenes) {
    lines.push('', `${episode.episodeNumber}-${scene.ordinal} ${time[scene.timeOfDay]} ${space[scene.interiorExterior]} ${scene.location}`);
    if (scene.characterIds.length > 0) {
      lines.push(`人物：${scene.characterIds.map((id) => {
        const character = charactersById.get(id);
        if (!character) return id;
        if (introducedCharacterIds.has(id)) return character.name;
        introducedCharacterIds.add(id);
        const identity = character.identity?.trim() ?? '';
        return identity ? `${character.name}（${identity}）` : character.name;
      }).join(' ')}`);
    }
    for (const block of scene.blocks) {
      if (block.type === 'caption') {
        lines.push(/^(?:闪回|闪回结束|闪出)$/u.test(block.text.trim())
          ? `【${block.text.trim()}】`
          : `【字幕：${block.text}】`);
      }
      else if (block.type === 'action') lines.push(`△${block.text}`);
      else {
        const mode = block.mode === 'os' || block.mode === 'vo' ? block.mode.toUpperCase() : '';
        const delivery = block.delivery?.trim();
        lines.push(`${block.speaker}${mode || (delivery ? `（${delivery}）` : '')}：${block.text}`);
      }
    }
  }
  return lines.join('\n');
}
