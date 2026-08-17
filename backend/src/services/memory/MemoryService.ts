/**
 * MemoryService：Agent 长期记忆的领域逻辑层。
 *
 * 在 {@link MemoryStore}（纯持久化）之上提供：
 * - 章节摘要追加（滚动保留，供续写回灌前情）；
 * - 故事事实(bible) 记录与去重（人物状态 / 世界规则 / 关键剧情）；
 * - 风格学习沉淀（Agent 自我进化）；
 * - 伏笔台账（埋设 / 呼应 / 回收，StoryForge 风格）；
 * - {@link buildContext}：把记忆压成一段「稳定上下文块」，注入写作 system prompt。
 *   该块刻意放在 prompt 前部且内容稳定，既保证连贯性，又最大化 DeepSeek 前缀缓存命中。
 *
 * 本类不直接调用模型——「如何反思 / 抽取摘要」属于编排层（AgentOrchestrator）职责，
 * 这里只负责存取与拼装，便于无网络环境下单测。
 *
 * 所有写路径经 {@link MemoryStore.update} 做原子 RMW，避免并发丢更新。
 */
import { randomUUID } from 'node:crypto';
import type {
  ChapterSummary,
  CriticalStateEntry,
  CriticalStateKind,
  ForeshadowEntry,
  ForeshadowStatus,
  ForeshadowUrgency,
  Learning,
  MemoryFact,
  ProjectMemory,
  WorkflowEvent,
} from './MemoryStore.js';
import type { MemoryStorePort } from './MemoryStore.js';

export interface BuildContextOptions {
  /** 最多回灌的近端章节摘要条数（默认 6）。 */
  maxSummaries?: number;
  /** 最多回灌的故事事实条数（默认 24）。 */
  maxFacts?: number;
  /** 最多回灌的关键章末状态条数（默认 48）。 */
  maxCriticalStates?: number;
  /** 最多回灌的学习沉淀条数（默认 8）。 */
  maxLearnings?: number;
  /** 最多回灌的最近工作流事件条数（默认 6）。 */
  maxWorkflow?: number;
  /** 最多回灌的未回收伏笔条数（默认 12）。 */
  maxForeshadows?: number;
  /** 最终注入文本的字符上限；长篇默认由 scaledMemoryOptions 固定为 16,000。 */
  maxChars?: number;
  /**
   * 当前写作进度 0–1（章号/总章数）。
   * 接近收尾时会提高未回收伏笔的提示强度。
   */
  progressRatio?: number;
}

export interface PlantForeshadowInput {
  title: string;
  detail: string;
  urgency?: ForeshadowUrgency;
  suggestPayoffBy?: string;
  plantedChapterId?: string;
  plantedChapterTitle?: string;
}

export interface TouchForeshadowInput {
  /** 匹配已有伏笔的标题或详情关键词。 */
  match: string;
  note?: string;
  status: 'echoed' | 'resolved' | 'dropped';
  chapterId?: string;
  chapterTitle?: string;
}

export interface CriticalStateUpdateInput {
  kind: CriticalStateKind;
  entity: string;
  key?: string;
  value: string;
  evidence: string;
  chapterId: string;
  chapterTitle: string;
}

export interface CriticalStateIssue {
  severity: 'P0';
  code:
    | 'DEAD_CHARACTER_REAPPEARS'
    | 'RESTRICTED_CHARACTER_MOVES_FREELY'
    | 'SEALED_ABILITY_REAPPEARS'
    | 'SEVERE_INJURY_DISAPPEARS'
    | 'CRITICAL_KNOWLEDGE_LOST'
    | 'KEY_ITEM_TRANSFER_WITHOUT_SOURCE';
  kind: CriticalStateKind;
  entity: string;
  message: string;
  evidence: string;
}

export interface CriticalStateApplyResult {
  applied: number;
  issues: CriticalStateIssue[];
}

/**
 * 长篇写作使用固定窗口和固定字符预算，章数增长只增加持久化记忆，不增加单章 prompt。
 */
export function scaledMemoryOptions(_chapterCount: number): BuildContextOptions {
  return {
    maxSummaries: 2,
    maxFacts: 24,
    maxCriticalStates: 48,
    maxLearnings: 6,
    maxWorkflow: 3,
    maxForeshadows: 10,
    maxChars: 16_000,
  };
}

/** 上限：防止记忆无限膨胀拖垮 prompt 与文件体积。 */
const MAX_SUMMARIES = 200;
const MAX_FACTS = 400;
const MAX_CRITICAL_STATES = 400;
const MAX_LEARNINGS = 100;
const MAX_WORKFLOW = 200;
const MAX_FORESHADOWS = 120;

const OPEN_STATUSES: readonly ForeshadowStatus[] = ['planted', 'echoed'];

const CRITICAL_STATE_VALUES: Partial<Record<CriticalStateKind, ReadonlySet<string>>> = {
  alive_status: new Set(['alive', 'dead', 'missing']),
  mobility_status: new Set(['free', 'detained', 'unconscious', 'immobile']),
  physical_state: new Set(['healthy', 'injured', 'severely_injured']),
  ability_state: new Set(['available', 'unavailable', 'sealed', 'lost']),
  critical_knowledge: new Set(['known', 'unknown']),
};

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizedCriticalStateKey(
  kind: CriticalStateKind,
  entity: string,
  key: string,
): string {
  return [kind, entity, key]
    .map((value) => value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN'))
    .join(':');
}

function normalizeCriticalStateUpdate(
  input: CriticalStateUpdateInput,
): Omit<CriticalStateEntry, 'id' | 'updatedAt'> | undefined {
  const entity = normalize(input.entity).slice(0, 80);
  const key = normalize(input.key ?? 'current').slice(0, 160) || 'current';
  const rawValue = normalize(input.value).slice(0, 120);
  const enumValues = CRITICAL_STATE_VALUES[input.kind];
  const value = enumValues ? rawValue.toLocaleLowerCase('en-US') : rawValue;
  const evidence = normalize(input.evidence).slice(0, 400);
  if (!entity || !value || !evidence || (enumValues && !enumValues.has(value))) return undefined;
  return {
    kind: input.kind,
    entity,
    key,
    value,
    evidence,
    chapterId: input.chapterId,
    chapterTitle: normalize(input.chapterTitle).slice(0, 200),
  };
}

function hasTransitionExplanation(kind: CriticalStateKind, evidence: string): boolean {
  if (kind === 'alive_status') {
    return /复活|死而复生|假死|误判死亡|抢救成功|还魂|重生/u.test(evidence);
  }
  if (kind === 'mobility_status') {
    return /获释|释放|保释|越狱|逃脱|苏醒|醒来|恢复行动|解除拘禁|被救出/u.test(evidence);
  }
  if (kind === 'ability_state') {
    return /解封|解除封印|恢复能力|重新获得|取回力量|修复|补充能量|充能/u.test(evidence);
  }
  if (kind === 'physical_state') {
    return /治疗|治愈|疗伤|康复|痊愈|休养|数日后|数月后|多年后|时间跳转/u.test(evidence);
  }
  if (kind === 'critical_knowledge') {
    return /失忆|记忆被抹|洗去记忆|遗忘术|催眠/u.test(evidence);
  }
  if (kind === 'key_item') {
    return /交给|递给|转交|赠予|归还|夺走|抢走|偷走|取回|捡到|找到|获得|继承|丢失|遗失|销毁/u.test(evidence);
  }
  return false;
}

function criticalTransitionIssue(
  previous: CriticalStateEntry,
  next: Omit<CriticalStateEntry, 'id' | 'updatedAt'>,
): CriticalStateIssue | undefined {
  if (previous.value === next.value || hasTransitionExplanation(next.kind, next.evidence)) {
    return undefined;
  }
  const base = {
    severity: 'P0' as const,
    kind: next.kind,
    entity: next.entity,
    evidence: next.evidence,
  };
  if (next.kind === 'alive_status' && previous.value === 'dead' && next.value === 'alive') {
    return {
      ...base,
      code: 'DEAD_CHARACTER_REAPPEARS',
      message: `「${next.entity}」此前已死亡，本章却在没有复活或假死说明时恢复存活。`,
    };
  }
  if (
    next.kind === 'mobility_status' &&
    ['detained', 'unconscious', 'immobile'].includes(previous.value) &&
    next.value === 'free'
  ) {
    return {
      ...base,
      code: 'RESTRICTED_CHARACTER_MOVES_FREELY',
      message: `「${next.entity}」此前处于受限状态，本章却在没有获释、苏醒或恢复说明时自由行动。`,
    };
  }
  if (
    next.kind === 'ability_state' &&
    ['unavailable', 'sealed', 'lost'].includes(previous.value) &&
    next.value === 'available'
  ) {
    return {
      ...base,
      code: 'SEALED_ABILITY_REAPPEARS',
      message: `「${next.entity}」的能力「${next.key}」此前不可用，本章却在没有恢复或解封说明时重新可用。`,
    };
  }
  if (
    next.kind === 'physical_state' &&
    previous.value === 'severely_injured' &&
    next.value === 'healthy'
  ) {
    return {
      ...base,
      code: 'SEVERE_INJURY_DISAPPEARS',
      message: `「${next.entity}」此前重伤，本章却在没有治疗、休养或时间跳转时恢复健康。`,
    };
  }
  if (
    next.kind === 'critical_knowledge' &&
    previous.value === 'known' &&
    next.value === 'unknown'
  ) {
    return {
      ...base,
      code: 'CRITICAL_KNOWLEDGE_LOST',
      message: `「${next.entity}」此前已知「${next.key}」，本章却在没有失忆说明时变为未知。`,
    };
  }
  if (
    next.kind === 'key_item' &&
    previous.value !== 'unheld' &&
    previous.value !== 'destroyed' &&
    next.value !== 'unheld' &&
    next.value !== 'destroyed'
  ) {
    return {
      ...base,
      code: 'KEY_ITEM_TRANSFER_WITHOUT_SOURCE',
      message: `唯一物品「${next.entity}」从「${previous.value}」变为「${next.value}」持有，但正文没有明确转移来源。`,
    };
  }
  return undefined;
}

/**
 * 字符二元组集合（对中文友好的轻量分词）。先去掉空白与常见标点，再做长度 2 的滑窗。
 * 单字时退化为单字符集合，保证短文本也可比较。
 */
function bigrams(text: string): Set<string> {
  const cleaned = normalize(text)
    .toLowerCase()
    .replace(/[\s，。、；：！？,.;:!?"'（）()【】\[\]]/g, '');
  const grams = new Set<string>();
  if (cleaned.length <= 1) {
    if (cleaned.length === 1) grams.add(cleaned);
    return grams;
  }
  for (let i = 0; i < cleaned.length - 1; i += 1) {
    grams.add(cleaned.slice(i, i + 2));
  }
  return grams;
}

/** 两段文本的 Jaccard 相似度（基于字符二元组），范围 0–1。 */
function similarity(a: string, b: string): number {
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.size === 0 || gb.size === 0) return a === b ? 1 : 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  const union = ga.size + gb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 近重复合并阈值：相似度 ≥ 该值视为同一事实，合并而非新增。 */
const MERGE_THRESHOLD = 0.82;

export class MemoryService {
  constructor(private readonly store: MemoryStorePort) {}

  /** 读取某项目记忆快照（深拷贝）。 */
  get(projectId: string): ProjectMemory {
    return this.store.read(projectId);
  }

  /** 追加一条章节摘要（同 chapterId 覆盖，保证一章一条最新摘要）。 */
  async appendChapterSummary(
    projectId: string,
    entry: { chapterId: string; title: string; summary: string },
  ): Promise<void> {
    const summary = normalize(entry.summary);
    if (summary.length === 0) return;
    await this.store.update(projectId, (memory) => {
      const next: ChapterSummary = {
        chapterId: entry.chapterId,
        title: entry.title,
        summary,
        at: new Date().toISOString(),
      };
      const filtered = memory.summaries.filter((s) => s.chapterId !== entry.chapterId);
      filtered.push(next);
      memory.summaries = filtered.slice(-MAX_SUMMARIES);
    });
  }

  /**
   * 记录故事事实，带语义去重/合并。返回实际新增条数（合并不计入）。
   *
   * 合并策略（同 kind 内）：
   * - 与已有事实归一后完全相同 → 跳过；
   * - 与已有事实字符二元组 Jaccard 相似度 ≥ {@link MERGE_THRESHOLD} → 视为近重复，
   *   保留更详细（更长）的文本覆盖原条目并刷新时间戳，避免「主角叫林辰」「主角名叫林辰」
   *   这类同义事实反复堆积、互相矛盾；
   * - 否则新增。
   */
  async recordFacts(
    projectId: string,
    facts: Array<{ kind: MemoryFact['kind']; text: string }>,
  ): Promise<number> {
    let added = 0;
    let changed = false;

    await this.store.update(projectId, (memory) => {
      for (const fact of facts) {
        const text = normalize(fact.text);
        if (text.length === 0) continue;

        // 同 kind 内找最相似的既有事实。
        let bestIndex = -1;
        let bestScore = 0;
        for (let i = 0; i < memory.facts.length; i += 1) {
          const existing = memory.facts[i]!;
          if (existing.kind !== fact.kind) continue;
          const score = similarity(text, existing.text);
          if (score > bestScore) {
            bestScore = score;
            bestIndex = i;
          }
        }

        if (bestIndex >= 0 && bestScore >= MERGE_THRESHOLD) {
          // 近重复：保留更详细的文本（取更长者），刷新时间戳，移动到末尾表示最新。
          const existing = memory.facts[bestIndex]!;
          const canonical = text.length > existing.text.length ? text : existing.text;
          memory.facts.splice(bestIndex, 1);
          memory.facts.push({
            id: existing.id,
            kind: fact.kind,
            text: canonical,
            at: new Date().toISOString(),
          });
          changed = true;
          continue;
        }

        memory.facts.push({ id: randomUUID(), kind: fact.kind, text, at: new Date().toISOString() });
        added += 1;
        changed = true;
      }

      if (!changed) return;
      memory.facts = memory.facts.slice(-MAX_FACTS);
    });

    return added;
  }

  /**
   * 原子校验并提交本章关键状态。任何一条 P0 转换不成立时整批拒绝，避免半章状态污染后文。
   */
  async applyCriticalStateUpdates(
    projectId: string,
    inputs: CriticalStateUpdateInput[],
  ): Promise<CriticalStateApplyResult> {
    const latestByKey = new Map<string, Omit<CriticalStateEntry, 'id' | 'updatedAt'>>();
    for (const input of inputs.slice(0, 24)) {
      const normalized = normalizeCriticalStateUpdate(input);
      if (!normalized) continue;
      latestByKey.set(
        normalizedCriticalStateKey(normalized.kind, normalized.entity, normalized.key),
        normalized,
      );
    }
    if (latestByKey.size === 0) return { applied: 0, issues: [] };

    let result: CriticalStateApplyResult = { applied: 0, issues: [] };
    await this.store.update(projectId, (memory) => {
      const existingByKey = new Map(
        memory.criticalStates.map((entry) => [
          normalizedCriticalStateKey(entry.kind, entry.entity, entry.key),
          entry,
        ]),
      );
      const issues: CriticalStateIssue[] = [];
      for (const [stateKey, update] of latestByKey) {
        const previous = existingByKey.get(stateKey);
        if (!previous) continue;
        const issue = criticalTransitionIssue(previous, update);
        if (issue) issues.push(issue);
      }
      if (issues.length > 0) {
        result = { applied: 0, issues };
        return;
      }

      const now = new Date().toISOString();
      for (const [stateKey, update] of latestByKey) {
        const previous = existingByKey.get(stateKey);
        existingByKey.set(stateKey, {
          ...update,
          id: previous?.id ?? randomUUID(),
          updatedAt: now,
        });
      }
      memory.criticalStates = [...existingByKey.values()]
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        .slice(-MAX_CRITICAL_STATES);
      result = { applied: latestByKey.size, issues: [] };
    });
    return result;
  }

  /** 标记 P0 拦截稿；正文可供人工查看，但续写时不得把它当作已提交章节。 */
  async markChapterRejected(projectId: string, chapterId: string): Promise<void> {
    const id = normalize(chapterId);
    if (!id) return;
    await this.store.update(projectId, (memory) => {
      if (!memory.rejectedChapterIds.includes(id)) memory.rejectedChapterIds.push(id);
      memory.rejectedChapterIds = memory.rejectedChapterIds.slice(-100);
    });
  }

  /** 章节通过全部硬门后清除拦截标记。 */
  async markChapterCommitted(projectId: string, chapterId: string): Promise<void> {
    const id = normalize(chapterId);
    if (!id) return;
    await this.store.update(projectId, (memory) => {
      memory.rejectedChapterIds = memory.rejectedChapterIds.filter((item) => item !== id);
    });
  }

  isChapterRejected(projectId: string, chapterId: string): boolean {
    return this.store.read(projectId).rejectedChapterIds.includes(chapterId);
  }

  formatCriticalStateLedger(projectId: string, maxEntries = 80): string {
    const states = this.store.read(projectId).criticalStates.slice(-Math.max(0, maxEntries));
    if (states.length === 0) return '';
    const labels: Record<CriticalStateKind, string> = {
      alive_status: '生死',
      mobility_status: '行动',
      location: '地点',
      physical_state: '伤势',
      ability_state: '能力',
      critical_knowledge: '关键知识',
      key_item: '唯一物品',
      relationship_stage: '关系阶段',
    };
    return [
      '# 关键状态账（只含可能造成大 Bug 的章末事实，后文不得无解释推翻）',
      ...states.map((state) =>
        `- [${labels[state.kind]}] ${state.entity} · ${state.key} = ${state.value}（${state.chapterTitle}）`,
      ),
    ].join('\n');
  }

  /** 记录一条风格学习（自我进化），按文本去重。返回是否新增。 */
  async recordLearning(projectId: string, text: string): Promise<boolean> {
    const clean = normalize(text);
    if (clean.length === 0) return false;
    let added = false;
    await this.store.update(projectId, (memory) => {
      const key = clean.toLowerCase();
      if (memory.learnings.some((l) => normalize(l.text).toLowerCase() === key)) {
        return;
      }
      const learning: Learning = { id: randomUUID(), text: clean, at: new Date().toISOString() };
      memory.learnings.push(learning);
      memory.learnings = memory.learnings.slice(-MAX_LEARNINGS);
      added = true;
    });
    return added;
  }

  /** 记录一次 Agent 工作流结果，用于跨任务理解当前创作阶段。 */
  async recordWorkflow(projectId: string, entry: { task: string; summary: string }): Promise<void> {
    const summary = normalize(entry.summary);
    if (summary.length === 0) return;
    await this.store.update(projectId, (memory) => {
      const event: WorkflowEvent = {
        id: randomUUID(),
        task: normalize(entry.task) || 'agent',
        summary,
        at: new Date().toISOString(),
      };
      memory.workflow.push(event);
      memory.workflow = memory.workflow.slice(-MAX_WORKFLOW);
    });
  }

  /** 未回收伏笔（planted / echoed），高紧急度优先。 */
  listOpenForeshadows(projectId: string): ForeshadowEntry[] {
    const memory = this.store.read(projectId);
    return sortOpenForeshadows(memory.foreshadows.filter((f) => OPEN_STATUSES.includes(f.status)));
  }

  /**
   * 埋设伏笔。近重复标题/详情会合并为更新已有条目（加强 detail，提高 urgency）。
   * 返回实际新增条数。
   */
  async plantForeshadows(projectId: string, inputs: PlantForeshadowInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    let added = 0;
    let changed = false;

    await this.store.update(projectId, (memory) => {
      const now = new Date().toISOString();

      for (const input of inputs) {
        const title = normalize(input.title);
        const detail = normalize(input.detail);
        if (title.length === 0 && detail.length === 0) continue;
        const effectiveTitle = title || detail.slice(0, 24);
        const effectiveDetail = detail || title;
        const urgency = normalizeUrgency(input.urgency);

        const existingIndex = findSimilarForeshadowIndex(memory.foreshadows, effectiveTitle, effectiveDetail);
        if (existingIndex >= 0) {
          const existing = memory.foreshadows[existingIndex]!;
          if (existing.status === 'resolved' || existing.status === 'dropped') {
            // 已回收的同名伏笔：重新埋设为新条目（可能是新一轮暗示）
          } else {
            const mergedDetail =
              effectiveDetail.length > existing.detail.length ? effectiveDetail : existing.detail;
            memory.foreshadows[existingIndex] = {
              ...existing,
              title: existing.title || effectiveTitle,
              detail: mergedDetail,
              urgency: higherUrgency(existing.urgency, urgency),
              suggestPayoffBy: input.suggestPayoffBy?.trim() || existing.suggestPayoffBy,
              plantedChapterId: existing.plantedChapterId ?? input.plantedChapterId,
              plantedChapterTitle: existing.plantedChapterTitle ?? input.plantedChapterTitle,
              updatedAt: now,
            };
            changed = true;
            continue;
          }
        }

        memory.foreshadows.push({
          id: randomUUID(),
          title: effectiveTitle,
          detail: effectiveDetail,
          status: 'planted',
          urgency,
          suggestPayoffBy: input.suggestPayoffBy?.trim() || undefined,
          plantedChapterId: input.plantedChapterId,
          plantedChapterTitle: input.plantedChapterTitle,
          at: now,
          updatedAt: now,
        });
        added += 1;
        changed = true;
      }

      if (!changed) return;
      memory.foreshadows = memory.foreshadows.slice(-MAX_FORESHADOWS);
    });

    return added;
  }

  /**
   * 呼应 / 回收 / 作废伏笔。按标题+详情相似度匹配 open 条目。
   * 返回成功更新条数。
   */
  async touchForeshadows(projectId: string, inputs: TouchForeshadowInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    let updated = 0;

    await this.store.update(projectId, (memory) => {
      const now = new Date().toISOString();

      for (const input of inputs) {
        const match = normalize(input.match);
        if (match.length === 0) continue;
        const open = memory.foreshadows
          .map((f, index) => ({ f, index }))
          .filter(({ f }) => OPEN_STATUSES.includes(f.status));
        let bestIndex = -1;
        let bestScore = 0;
        for (const { f, index } of open) {
          const score = Math.max(similarity(match, f.title), similarity(match, f.detail));
          if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
          }
        }
        // 宽松阈值：反思返回的短标题也能命中
        if (bestIndex < 0 || bestScore < 0.35) continue;
        const existing = memory.foreshadows[bestIndex]!;
        memory.foreshadows[bestIndex] = {
          ...existing,
          status: input.status,
          lastTouchedChapterId: input.chapterId ?? existing.lastTouchedChapterId,
          lastTouchedChapterTitle: input.chapterTitle ?? existing.lastTouchedChapterTitle,
          resolvedNote:
            input.status === 'resolved' || input.status === 'dropped'
              ? normalize(input.note ?? '') || existing.resolvedNote
              : existing.resolvedNote,
          urgency: input.status === 'echoed' ? higherUrgency(existing.urgency, 'medium') : existing.urgency,
          updatedAt: now,
        };
        updated += 1;
      }
    });

    return updated;
  }

  /** 渲染伏笔台账 Markdown（可写入项目大纲资料，便于作者查看）。 */
  formatForeshadowLedger(projectId: string): string {
    const memory = this.store.read(projectId);
    const open = sortOpenForeshadows(
      memory.foreshadows.filter((f) => OPEN_STATUSES.includes(f.status)),
    );
    const closed = memory.foreshadows.filter(
      (f) => f.status === 'resolved' || f.status === 'dropped',
    );
    const lines: string[] = ['# 伏笔台账', '', `更新时间：${memory.updatedAt}`, ''];
    lines.push('## 未回收');
    if (open.length === 0) {
      lines.push('- （暂无）');
    } else {
      for (const f of open) {
        const where = f.plantedChapterTitle ? ` · 埋于${f.plantedChapterTitle}` : '';
        const when = f.suggestPayoffBy ? ` · 建议${f.suggestPayoffBy}回收` : '';
        const urg = urgencyLabel(f.urgency);
        lines.push(
          `- [${f.status === 'echoed' ? '已呼应' : '已埋设'}/${urg}] **${f.title}**：${f.detail}${where}${when}`,
        );
      }
    }
    lines.push('', '## 已回收 / 作废');
    if (closed.length === 0) {
      lines.push('- （暂无）');
    } else {
      for (const f of closed.slice(-30)) {
        const note = f.resolvedNote ? ` — ${f.resolvedNote}` : '';
        lines.push(`- [${f.status === 'resolved' ? '已回收' : '作废'}] **${f.title}**：${f.detail}${note}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * 把记忆压成注入写作 prompt 的稳定上下文块。
   * 无记忆时返回空字符串（首章场景），调用方据此决定是否拼接。
   */
  buildContext(projectId: string, options: BuildContextOptions = {}): string {
    const maxSummaries = options.maxSummaries ?? 6;
    const maxFacts = options.maxFacts ?? 24;
    const maxCriticalStates = options.maxCriticalStates ?? 48;
    const maxLearnings = options.maxLearnings ?? 8;
    const maxWorkflow = options.maxWorkflow ?? 6;
    const maxForeshadows = options.maxForeshadows ?? 12;
    const progressRatio =
      typeof options.progressRatio === 'number' && Number.isFinite(options.progressRatio)
        ? Math.min(1, Math.max(0, options.progressRatio))
        : undefined;

    const memory = this.store.read(projectId);
    type ContextSectionKind =
      | 'criticalStates'
      | 'facts'
      | 'foreshadows'
      | 'summaries'
      | 'learnings'
      | 'workflow';
    const sections: Array<{ kind: ContextSectionKind; content: string }> = [];

    const criticalStates = this.formatCriticalStateLedger(projectId, maxCriticalStates);
    if (criticalStates) sections.push({ kind: 'criticalStates', content: criticalStates });

    const facts = memory.facts.slice(-maxFacts);
    if (facts.length > 0) {
      const grouped: Record<MemoryFact['kind'], string[]> = { character: [], world: [], plot: [] };
      for (const fact of facts) grouped[fact.kind].push(fact.text);
      const labels: Record<MemoryFact['kind'], string> = {
        character: '人物状态',
        world: '世界规则',
        plot: '关键剧情',
      };
      const lines: string[] = [];
      (['character', 'world', 'plot'] as const).forEach((kind) => {
        if (grouped[kind].length > 0) {
          lines.push(`【${labels[kind]}】`);
          grouped[kind].forEach((t) => lines.push(`- ${t}`));
        }
      });
      sections.push({
        kind: 'facts',
        content: `# 故事设定记忆（须保持一致，禁止与下列设定冲突）\n${lines.join('\n')}`,
      });
    }

    const openForeshadows = sortOpenForeshadows(
      memory.foreshadows.filter((f) => OPEN_STATUSES.includes(f.status)),
    ).slice(0, maxForeshadows);
    if (openForeshadows.length > 0) {
      const lateGame = progressRatio !== undefined && progressRatio >= 0.75;
      const midGame = progressRatio !== undefined && progressRatio >= 0.45;
      const header = lateGame
        ? '# 伏笔台账（临近收束：优先自然回收高优先伏笔，禁止新开无法收束的大坑）'
        : midGame
          ? '# 伏笔台账（中段：可呼应旧伏笔，重大回收留给高潮）'
          : '# 伏笔台账（未回收；可埋设/轻呼应，勿提前拆穿终极悬念）';
      const lines = openForeshadows.map((f) => {
        const plant = f.plantedChapterTitle ? `（埋于${f.plantedChapterTitle}）` : '';
        const payoff = f.suggestPayoffBy ? `；建议${f.suggestPayoffBy}回收` : '';
        const status = f.status === 'echoed' ? '已呼应' : '待呼应';
        return `- [${urgencyLabel(f.urgency)}/${status}] ${f.title}：${f.detail}${plant}${payoff}`;
      });
      if (lateGame) {
        lines.push('- 写作要求：本章至少推进或回收 1 条高/中紧急度伏笔，并在结局前清掉核心悬念。');
      }
      sections.push({ kind: 'foreshadows', content: `${header}\n${lines.join('\n')}` });
    }

    const summaries = memory.summaries.slice(-maxSummaries);
    if (summaries.length > 0) {
      const lines = summaries.map((s) => `- ${s.title}：${s.summary}`);
      sections.push({
        kind: 'summaries',
        content: `# 前情提要（按章节顺序，须自然顺接）\n${lines.join('\n')}`,
      });
    }

    const learnings = memory.learnings.slice(-maxLearnings);
    if (learnings.length > 0) {
      const lines = learnings.map((l) => `- ${l.text}`);
      sections.push({
        kind: 'learnings',
        content: `# 写作风格沉淀（请遵循，持续保持文风一致）\n${lines.join('\n')}`,
      });
    }

    const workflow = memory.workflow.slice(-maxWorkflow);
    if (workflow.length > 0) {
      const lines = workflow.map((event) => `- ${event.task}：${event.summary}`);
      sections.push({
        kind: 'workflow',
        content: `# 最近工作流轨迹（用于判断当前创作阶段）\n${lines.join('\n')}`,
      });
    }

    const maxChars = options.maxChars;
    if (maxChars === undefined || !Number.isFinite(maxChars) || maxChars <= 0) {
      return sections.map((section) => section.content).join('\n\n');
    }

    const ratios: Record<ContextSectionKind, number> = {
      criticalStates: 0.25,
      facts: 0.2,
      foreshadows: 0.15,
      summaries: 0.25,
      learnings: 0.1,
      workflow: 0.05,
    };
    const keepTail = new Set<ContextSectionKind>(['summaries', 'learnings', 'workflow']);
    const bounded = sections.map((section) => {
      const budget = Math.max(40, Math.floor(maxChars * ratios[section.kind]));
      if (section.content.length <= budget) return section.content;
      if (section.kind === 'summaries') {
        const [heading = '', ...entries] = section.content.split('\n');
        const entryBudget = Math.max(
          12,
          Math.floor((budget - heading.length - entries.length) / Math.max(1, entries.length)),
        );
        return [
          heading,
          ...entries.map((entry) =>
            entry.length <= entryBudget ? entry : `${entry.slice(0, Math.max(0, entryBudget - 1))}…`,
          ),
        ]
          .join('\n')
          .slice(0, budget);
      }
      if (keepTail.has(section.kind)) {
        const headingEnd = section.content.indexOf('\n');
        const heading = headingEnd >= 0 ? section.content.slice(0, headingEnd) : '';
        const suffixBudget = Math.max(0, budget - heading.length - 4);
        return `${heading}\n…\n${section.content.slice(-suffixBudget)}`.slice(0, budget);
      }
      return `${section.content.slice(0, Math.max(0, budget - 8))}\n…（截断）`;
    });
    return bounded.join('\n\n').slice(0, maxChars);
  }
}

function normalizeUrgency(value: ForeshadowUrgency | undefined): ForeshadowUrgency {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return 'medium';
}

function urgencyRank(u: ForeshadowUrgency): number {
  if (u === 'high') return 3;
  if (u === 'medium') return 2;
  return 1;
}

function higherUrgency(a: ForeshadowUrgency, b: ForeshadowUrgency): ForeshadowUrgency {
  return urgencyRank(a) >= urgencyRank(b) ? a : b;
}

function urgencyLabel(u: ForeshadowUrgency): string {
  if (u === 'high') return '高';
  if (u === 'medium') return '中';
  return '低';
}

function sortOpenForeshadows(items: ForeshadowEntry[]): ForeshadowEntry[] {
  return [...items].sort((a, b) => {
    const urg = urgencyRank(b.urgency) - urgencyRank(a.urgency);
    if (urg !== 0) return urg;
    // 更早埋设的优先提醒
    return a.at.localeCompare(b.at);
  });
}

function findSimilarForeshadowIndex(
  list: ForeshadowEntry[],
  title: string,
  detail: string,
): number {
  let bestIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < list.length; i += 1) {
    const f = list[i]!;
    const score = Math.max(
      similarity(title, f.title),
      similarity(detail, f.detail),
      similarity(title, f.detail),
      similarity(detail, f.title),
    );
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestScore >= MERGE_THRESHOLD ? bestIndex : -1;
}
