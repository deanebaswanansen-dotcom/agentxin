import type { FrozenMemoryProjection, SourceMemoryView } from '../../types/SourceMemory.js';
import type { StoryControlCollection } from '../../types/StoryControl.js';
import type { StoryMemoryContext, StoryMemoryContextStatistics } from '../../types/StoryMemoryWorkspace.js';
import { ServiceError } from '../ServiceError.js';
import { activeStoryControls } from '../story/StoryControls.js';
import { searchAcceptedMemory } from '../retrieval/KeywordMemoryRetrieval.js';
import { buildStoryThreads } from './StoryThreads.js';
import { validateFrozenMemoryProjection } from './sourceMemoryContract.js';

export interface StoryMemoryContextInput {
  view: SourceMemoryView;
  controls: StoryControlCollection;
  projection?: FrozenMemoryProjection;
  query?: string;
  maxChars?: number;
}

/** One budget for the memory section, not a claim about the entire model prompt. */
export function composeStoryMemoryContext(input: StoryMemoryContextInput): StoryMemoryContext {
  const maxChars = input.maxChars ?? 16_000;
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 16_000) throw ServiceError.validation('记忆上下文预算须为1至16000字符。');
  if (input.projection) {
    validateFrozenMemoryProjection(input.projection);
    if (input.view.projectId !== input.projection.projectId || input.view.mode !== input.projection.mode || input.view.projectionRevision !== input.projection.revision)
      throw ServiceError.conflict('写前记忆来源已更新。');
  }
  const currentSources = input.projection?.acceptances.map((acceptance) => acceptance.source) ?? [];
  const threads = buildStoryThreads(input.view, input.controls, input.view.beforeUnit, currentSources);
  const controls = activeStoryControls(input.controls, input.view.beforeUnit).filter((control) => control.kind !== 'thread');
  const eligibleIds = new Set(currentSources.filter((source) => source.unitNumber < input.view.beforeUnit).map((source) => source.acceptanceId));
  const matchedEntries = input.view.entries.filter((entry) => entry.status === 'active' && entry.evidenceStatus === 'matched' &&
    eligibleIds.has(entry.source.acceptanceId)).sort((a, b) => b.source.unitNumber - a.source.unitNumber);
  const sourceLine = (entry: (typeof matchedEntries)[number]) => `- [引文匹配，非语义证明 / 单元${entry.source.unitNumber} / ${entry.kind}${entry.kind === 'state' ? ` / ${entry.entity}:${entry.key}=${entry.value}` : entry.kind === 'thread' ? ` / ${entry.action}` : ''}] ${entry.text}`;
  type Category = 'source' | 'author' | 'thread' | 'retrieval';
  const titles: Record<Category, string> = {
    source: '已接受来源条目：matched只表示引用位置匹配，不证明语义判断；未核实条目仅供核对',
    author: '作者主动指定：偏好与裁决不冒充正文事实',
    thread: '伏笔安排：仅作者明确指定本单元必达才是硬约束，其他期限为建议',
    retrieval: '检索到的历史正文观察：按当时情境理解，不代表当前状态，也不覆盖作者要求',
  };
  const statistics: StoryMemoryContextStatistics = { maxChars, usedChars: 0, estimatedTokens: 0, requiredChars: 0,
    sourceChars: 0, authorChars: 0, threadChars: 0, retrievalChars: 0, omittedItems: 0, truncated: false };
  const chunks: string[] = [];
  let previousCategory: Category | undefined;
  function append(category: Category, line: string, required = false, categoryCap = maxChars): void {
    const prefix = previousCategory === category ? '\n' : `${chunks.length ? '\n\n' : ''}【${titles[category]}】\n`;
    const key = `${category}Chars` as const;
    const available = Math.min(maxChars - statistics.usedChars, categoryCap - statistics[key]);
    let addition = prefix + line;
    if (addition.length > available) {
      if (required) throw ServiceError.validation('作者必需记忆依据超过上下文预算，请精简要求后再写作。');
      statistics.omittedItems += 1; statistics.truncated = true;
      const suffix = '…[预算截断]';
      if (available <= prefix.length + suffix.length) return;
      addition = prefix + line.slice(0, available - prefix.length - suffix.length) + suffix;
    }
    chunks.push(addition); previousCategory = category;
    statistics.usedChars += addition.length; statistics[key] += addition.length;
    if (required) statistics.requiredChars += addition.length;
  }
  const authorLine = (control: (typeof controls)[number]) => {
    const sourceStatus = !currentSources.some((source) => source.acceptanceId === control.source?.acceptanceId)
      ? '原来源已撤回，仅供审计' : control.source && control.source.unitNumber >= input.view.beforeUnit ? '关联未来来源，不作当前事实' : '关联来源仅供审计';
    return `- [${control.importance === 'required' ? '必须遵守' : '作者建议'} / ${control.kind === 'fact_correction' ? `作者裁决，${sourceStatus}` : '表达偏好'}] ${control.text}`;
  };
  // Never spend optional material's budget before complete author requirements.
  for (const control of controls.filter((control) => control.importance === 'required')) append('author', authorLine(control), true);
  for (const thread of threads.filter((thread) => thread.requiredNow)) append('thread', `- [作者指定本单元必须回收] ${thread.title}：${thread.text}`, true);
  // Current matched fact/state entries are required continuity inputs. A large
  // accepted set must be explicitly reduced, never silently dropped for hints.
  for (const entry of matchedEntries.filter((entry) => entry.kind === 'fact' || entry.kind === 'state')) append('source', sourceLine(entry), true);
  // Nearby prose is useful even when the instruction has no searchable nouns.
  // It is a bounded historical observation inside this same optional budget.
  const nearest = input.projection?.acceptances.filter((acceptance) => acceptance.source.unitNumber < input.view.beforeUnit &&
    acceptance.blocks.some((block) => block.text.trim())).sort((a, b) => b.source.unitNumber - a.source.unitNumber ||
      (a.source.acceptanceId < b.source.acceptanceId ? -1 : a.source.acceptanceId > b.source.acceptanceId ? 1 : 0))[0];
  const finalBlock = nearest?.blocks.filter((block) => block.text.trim()).at(-1);
  let tailStart = finalBlock ? Math.max(0, finalBlock.text.length - 1200) : 0;
  if (finalBlock && tailStart > 0 && /[\uDC00-\uDFFF]/.test(finalBlock.text[tailStart]!)) tailStart += 1;
  if (nearest && finalBlock) append('retrieval', `- [临近前文历史观察 / ${nearest.title} / 单元${nearest.source.unitNumber} / ${finalBlock.id}:${tailStart}-${finalBlock.text.length}] ${finalBlock.text.slice(tailStart)}`, false, 6000);
  for (const control of controls.filter((control) => control.importance !== 'required')) append('author', authorLine(control), false, 2500);
  for (const thread of threads.filter((thread) => !thread.requiredNow && thread.status !== 'resolved' && thread.status !== 'dropped')) {
    append('thread', `- [${thread.priority === 'overdue' ? '已过建议期限' : thread.priority === 'due_soon' ? '建议期限临近' : '可推进'}] ${thread.title}：${thread.text}${thread.deadlineUnit !== undefined ? `（建议期限${thread.deadlineUnit}）` : ''}`, false, 2500);
  }
  for (const entry of matchedEntries.filter((entry) => entry.kind !== 'fact' && entry.kind !== 'state')) append('source', sourceLine(entry), false, 5500);
  if (input.projection && input.query?.trim()) {
    const result = searchAcceptedMemory({ projection: input.projection, view: input.view, query: input.query,
      clientId: input.projection.clientId, projectId: input.projection.projectId, mode: input.projection.mode,
      beforeUnit: input.view.beforeUnit, topK: 5, maxContextChars: 6000 });
    for (const hit of result.hits.filter((hit) => hit.kind === 'body')) {
      if (nearest && finalBlock && hit.source.acceptanceId === nearest.source.acceptanceId &&
        hit.evidence.some((evidence) => evidence.blockId === finalBlock.id && evidence.start >= tailStart && evidence.end <= finalBlock.text.length)) continue;
      append('retrieval', `- [历史正文 / ${hit.title} / 单元${hit.source.unitNumber} / ${hit.evidence.map((evidence) => `${evidence.blockId}:${evidence.start}-${evidence.end}`).join(',')}] ${hit.text}`, false, 6000);
    }
  }
  for (const entry of input.view.unverifiedReferences) {
    if (entry.status === 'stale' || entry.source.unitNumber >= input.view.beforeUnit || !eligibleIds.has(entry.source.acceptanceId)) continue;
    append('source', `- [未核实，仅供核对 / 单元${entry.source.unitNumber} / ${entry.evidenceReason ?? '证据不足'}] ${entry.text}`, false, 5500);
  }
  statistics.estimatedTokens = Math.ceil(statistics.usedChars / 2);
  return { text: chunks.join(''), statistics };
}
