import type { CriticalStateEntry } from '../../memory/MemoryStore.js';
import type { CriticalStateUpdateInput } from '../../memory/MemoryService.js';

export type DeterministicCriticalStateUpdate = Pick<
  CriticalStateUpdateInput,
  'kind' | 'entity' | 'key' | 'value' | 'evidence'
>;

interface TextClause {
  text: string;
  offset: number;
}

interface StateEvent extends DeterministicCriticalStateUpdate {
  offset: number;
}

const DEATH_MARKER_SOURCE = [
  '(?:已经|已|当场|最终|彻底|正式)?(?:死亡|身亡|断气|咽气|毙命|丧命|死了)',
  '(?:没有|失去)(?:了)?(?:脉搏|呼吸|生命体征)',
  '(?:无|停止)(?:脉搏|呼吸|生命体征)',
  '生命体征(?:已经|已)?消失',
].join('|');

const NON_FACTUAL_DEATH =
  /没(?:有)?死|未死|并未(?:死亡|身亡)|还活着|仍然?活着|差点|险些|几乎|假死|诈死|装死|误判|如果|假如|若是|一旦|可能|或许|也许|担心|恐怕|梦见|梦到|梦中|幻觉|传闻|据说|以为|假设|推测|猜测/u;
const NON_CURRENT_ACTION =
  /回忆|想起|记得|梦里|梦中|梦见|幻觉|幻象|照片|画像|录像|录音|遗言|日记|生前|昔日|当年|曾经|过去|年前|如果|假如|若是|可能|仿佛|好像|酷似|冒充|假扮|扮成|灵魂|鬼魂|剧本|小说/u;
const BODY_REFERENCE = /尸体|遗体|遗骸|骨灰|墓碑|牌位/u;
const TRANSITION_EXPLANATION = /复活|死而复生|假死|误判死亡|抢救成功|还魂|重生/u;
const ACTIVE_VERB_SOURCE = [
  '推门', '走进', '进入', '走出', '离开', '走来', '走到', '走过', '回来', '返回', '出现',
  '起身', '醒来', '睁开', '开口', '说道', '回答', '抬手', '伸手', '握住', '抓住', '拿起',
  '端起', '举起', '放下', '转身', '看向', '望向', '敲门', '拥抱', '点头', '摇头', '签字',
  '行动', '呼吸', '站', '坐', '走', '跑', '奔', '说', '问', '喊', '笑', '哭', '吃', '喝', '写',
].join('|');
const SUBJECT_ADVERB_SOURCE =
  '(?:本人|竟然|居然|突然|缓缓|径直|亲自|又|再次|已经|正在|正|仍然|仍|还|也|便|就|随即|当即|马上|立刻)*';

const EXCLUDED_ENTITIES = new Set([
  '我们', '你们', '他们', '她们', '它们', '自己', '对方', '有人', '众人', '所有人', '一个人',
]);
const ENTITY_PREFIXES = [
  '在场众人', '所有人', '众人', '警方', '法医', '医生', '医师', '大夫', '最终', '随后', '后来',
  '此时', '那时', '当场', '反复', '已经',
];
const ENTITY_BOUNDARIES = [
  '反复确认', '确认', '证实', '宣告', '认定', '发现', '看见', '看到', '目睹', '表示', '声称',
  '说道', '说', '将', '把',
];

function splitClauses(text: string): TextClause[] {
  const clauses: TextClause[] = [];
  const matcher = /[^\n。！？!?；;，,]+/gu;
  for (const match of text.matchAll(matcher)) {
    const clause = match[0].trim();
    if (clause) clauses.push({ text: clause, offset: match.index ?? 0 });
  }
  return clauses;
}

function entityLength(value: string): number {
  return Array.from(value).length;
}

function entityBeforeMarker(prefix: string): string | undefined {
  let candidate = prefix
    .normalize('NFKC')
    .replace(/[“”‘’"'《》【】()（）\[\]]/gu, '')
    .replace(/\s+/gu, '')
    .replace(/(?:被)?(?:反复)?(?:确认|证实|宣告|认定)$/u, '')
    .replace(/(?:已经|已|当场|最终|彻底|正式|确已)$/u, '');

  let boundary = -1;
  let boundaryLength = 0;
  for (const token of ENTITY_BOUNDARIES) {
    const index = candidate.lastIndexOf(token);
    if (index >= boundary) {
      boundary = index;
      boundaryLength = token.length;
    }
  }
  if (boundary >= 0 && candidate.slice(boundary + boundaryLength).length >= 2) {
    candidate = candidate.slice(boundary + boundaryLength);
  }

  const matched = candidate.match(/[\p{Script=Han}·]{2,8}$/u)?.[0];
  if (!matched) return undefined;
  candidate = matched;
  let trimmed = true;
  while (trimmed) {
    trimmed = false;
    for (const prefixToken of ENTITY_PREFIXES) {
      if (candidate.startsWith(prefixToken) && entityLength(candidate) - entityLength(prefixToken) >= 2) {
        candidate = candidate.slice(prefixToken.length);
        trimmed = true;
        break;
      }
    }
  }
  if (entityLength(candidate) < 2 || entityLength(candidate) > 4) return undefined;
  if (EXCLUDED_ENTITIES.has(candidate)) return undefined;
  return candidate;
}

function deathEvents(text: string, knownEntities: readonly string[]): StateEvent[] {
  const events = new Map<string, StateEvent>();
  for (const clause of splitClauses(text)) {
    if (NON_FACTUAL_DEATH.test(clause.text)) continue;
    const marker = new RegExp(DEATH_MARKER_SOURCE, 'gu');
    for (const match of clause.text.matchAll(marker)) {
      const markerOffset = match.index ?? 0;
      let entity = entityBeforeMarker(clause.text.slice(0, markerOffset));
      if (!entity) {
        entity = knownEntities.find((name) => {
          const entityOffset = clause.text.indexOf(name);
          return entityOffset >= 0 && Math.abs(entityOffset - markerOffset) <= 24;
        });
      }
      if (!entity) continue;
      events.set(entity, {
        kind: 'alive_status',
        entity,
        key: 'current',
        value: 'dead',
        evidence: clause.text.slice(0, 300),
        offset: clause.offset + markerOffset,
      });
    }
  }
  return [...events.values()];
}

function aliveEvent(text: string, entity: string): StateEvent | undefined {
  const escapedEntity = entity.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const active = new RegExp(
    `${escapedEntity}${SUBJECT_ADVERB_SOURCE}(?:${ACTIVE_VERB_SOURCE})`,
    'u',
  );
  let latest: StateEvent | undefined;
  for (const clause of splitClauses(text)) {
    if (!clause.text.includes(entity)) continue;
    const clauseContext = text.slice(Math.max(0, clause.offset - 40), clause.offset + clause.text.length);
    if (NON_CURRENT_ACTION.test(clauseContext) || BODY_REFERENCE.test(clause.text)) continue;
    const match = active.exec(clause.text);
    if (!match) continue;
    const absoluteOffset = clause.offset + (match.index ?? 0);
    const nearby = text.slice(Math.max(0, absoluteOffset - 180), absoluteOffset + 220);
    const evidence = TRANSITION_EXPLANATION.test(nearby) ? nearby : clause.text;
    latest = {
      kind: 'alive_status',
      entity,
      key: 'current',
      value: 'alive',
      evidence: evidence.slice(0, 400),
      offset: absoluteOffset,
    };
  }
  return latest;
}

/**
 * 用已有正文与反思结果做极保守的本地兜底，只识别明确死亡和已死亡人物的现实行动。
 * 不调用模型；含假设、梦境、回忆、尸体或转述语境时不推断。
 */
export function inferDeterministicCriticalStateUpdates(input: {
  content: string;
  summary?: string;
  facts?: ReadonlyArray<{ text: string }>;
  existingStates: readonly CriticalStateEntry[];
}): DeterministicCriticalStateUpdate[] {
  const aliveStates = input.existingStates.filter((state) => state.kind === 'alive_status');
  const knownEntities = [...new Set(aliveStates.map((state) => state.entity))];
  const contentEvents = new Map<string, StateEvent>();

  for (const event of deathEvents(input.content, knownEntities)) {
    contentEvents.set(event.entity, event);
  }
  for (const state of aliveStates) {
    if (state.value !== 'dead') continue;
    const event = aliveEvent(input.content, state.entity);
    const previous = contentEvents.get(state.entity);
    if (event && (!previous || event.offset > previous.offset)) contentEvents.set(state.entity, event);
  }

  const fallbackText = [input.summary ?? '', ...(input.facts ?? []).map((fact) => fact.text)]
    .filter(Boolean)
    .join('。');
  if (fallbackText) {
    for (const event of deathEvents(fallbackText, knownEntities)) {
      if (!contentEvents.has(event.entity)) contentEvents.set(event.entity, event);
    }
  }

  return [...contentEvents.values()].map(({ offset: _offset, ...update }) => update);
}
