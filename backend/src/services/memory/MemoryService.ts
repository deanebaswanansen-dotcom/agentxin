/**
 * MemoryService：Agent 长期记忆的领域逻辑层。
 *
 * 在 {@link MemoryStore}（纯持久化）之上提供：
 * - 章节摘要追加（滚动保留，供续写回灌前情）；
 * - 故事事实(bible) 记录与去重（人物状态 / 世界规则 / 关键剧情）；
 * - 风格学习沉淀（Agent 自我进化）；
 * - {@link buildContext}：把记忆压成一段「稳定上下文块」，注入写作 system prompt。
 *   该块刻意放在 prompt 前部且内容稳定，既保证连贯性，又最大化 DeepSeek 前缀缓存命中。
 *
 * 本类不直接调用模型——「如何反思 / 抽取摘要」属于编排层（AgentOrchestrator）职责，
 * 这里只负责存取与拼装，便于无网络环境下单测。
 */
import { randomUUID } from 'node:crypto';
import type { ChapterSummary, Learning, MemoryFact, ProjectMemory, WorkflowEvent } from './MemoryStore.js';
import { MemoryStore } from './MemoryStore.js';

export interface BuildContextOptions {
  /** 最多回灌的近端章节摘要条数（默认 6）。 */
  maxSummaries?: number;
  /** 最多回灌的故事事实条数（默认 24）。 */
  maxFacts?: number;
  /** 最多回灌的学习沉淀条数（默认 8）。 */
  maxLearnings?: number;
  /** 最多回灌的最近工作流事件条数（默认 6）。 */
  maxWorkflow?: number;
}

/**
 * Scale memory injection with novel length.
 * Long runs (几十万字) cannot rely on a fixed 6-summary window.
 */
export function scaledMemoryOptions(chapterCount: number): BuildContextOptions {
  const chapters = Math.max(1, Math.floor(chapterCount));
  return {
    maxSummaries: Math.min(40, Math.max(8, Math.ceil(chapters / 8))),
    maxFacts: Math.min(80, Math.max(24, Math.ceil(chapters / 4))),
    maxLearnings: Math.min(16, Math.max(8, Math.ceil(chapters / 20))),
    maxWorkflow: Math.min(12, Math.max(6, Math.ceil(chapters / 25))),
  };
}

/** 上限：防止记忆无限膨胀拖垮 prompt 与文件体积。 */
const MAX_SUMMARIES = 200;
const MAX_FACTS = 400;
const MAX_LEARNINGS = 100;
const MAX_WORKFLOW = 200;

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
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
  constructor(private readonly store: MemoryStore) {}

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
    const memory = this.store.read(projectId);
    const next: ChapterSummary = {
      chapterId: entry.chapterId,
      title: entry.title,
      summary,
      at: new Date().toISOString(),
    };
    const filtered = memory.summaries.filter((s) => s.chapterId !== entry.chapterId);
    filtered.push(next);
    memory.summaries = filtered.slice(-MAX_SUMMARIES);
    await this.store.write(projectId, memory);
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
    const memory = this.store.read(projectId);
    let added = 0;
    let changed = false;

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

    if (!changed) return 0;
    memory.facts = memory.facts.slice(-MAX_FACTS);
    await this.store.write(projectId, memory);
    return added;
  }

  /** 记录一条风格学习（自我进化），按文本去重。返回是否新增。 */
  async recordLearning(projectId: string, text: string): Promise<boolean> {
    const clean = normalize(text);
    if (clean.length === 0) return false;
    const memory = this.store.read(projectId);
    const key = clean.toLowerCase();
    if (memory.learnings.some((l) => normalize(l.text).toLowerCase() === key)) {
      return false;
    }
    const learning: Learning = { id: randomUUID(), text: clean, at: new Date().toISOString() };
    memory.learnings.push(learning);
    memory.learnings = memory.learnings.slice(-MAX_LEARNINGS);
    await this.store.write(projectId, memory);
    return true;
  }

  /** 记录一次 Agent 工作流结果，用于跨任务理解当前创作阶段。 */
  async recordWorkflow(projectId: string, entry: { task: string; summary: string }): Promise<void> {
    const summary = normalize(entry.summary);
    if (summary.length === 0) return;
    const memory = this.store.read(projectId);
    const event: WorkflowEvent = {
      id: randomUUID(),
      task: normalize(entry.task) || 'agent',
      summary,
      at: new Date().toISOString(),
    };
    memory.workflow.push(event);
    memory.workflow = memory.workflow.slice(-MAX_WORKFLOW);
    await this.store.write(projectId, memory);
  }

  /**
   * 把记忆压成注入写作 prompt 的稳定上下文块。
   * 无记忆时返回空字符串（首章场景），调用方据此决定是否拼接。
   */
  buildContext(projectId: string, options: BuildContextOptions = {}): string {
    const maxSummaries = options.maxSummaries ?? 6;
    const maxFacts = options.maxFacts ?? 24;
    const maxLearnings = options.maxLearnings ?? 8;
    const maxWorkflow = options.maxWorkflow ?? 6;

    const memory = this.store.read(projectId);
    const sections: string[] = [];

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
      sections.push(`# 故事设定记忆（须保持一致，禁止与下列设定冲突）\n${lines.join('\n')}`);
    }

    const summaries = memory.summaries.slice(-maxSummaries);
    if (summaries.length > 0) {
      const lines = summaries.map((s) => `- ${s.title}：${s.summary}`);
      sections.push(`# 前情提要（按章节顺序，须自然顺接）\n${lines.join('\n')}`);
    }

    const learnings = memory.learnings.slice(-maxLearnings);
    if (learnings.length > 0) {
      const lines = learnings.map((l) => `- ${l.text}`);
      sections.push(`# 写作风格沉淀（请遵循，持续保持文风一致）\n${lines.join('\n')}`);
    }

    const workflow = memory.workflow.slice(-maxWorkflow);
    if (workflow.length > 0) {
      const lines = workflow.map((event) => `- ${event.task}：${event.summary}`);
      sections.push(`# 最近工作流轨迹（用于判断当前创作阶段）\n${lines.join('\n')}`);
    }

    return sections.join('\n\n');
  }
}
