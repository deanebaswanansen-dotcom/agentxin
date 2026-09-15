import type { MemorySourceRef, SourceMemoryView } from '../../types/SourceMemory.js';
import type { StoryControlCollection } from '../../types/StoryControl.js';
import type { StoryThreadView } from '../../types/StoryMemoryWorkspace.js';
import { ServiceError } from '../ServiceError.js';
import { hashSourceMemoryValue } from './sourceMemoryContract.js';

function open(thread: StoryThreadView): boolean { return thread.status === 'planted' || thread.status === 'echoed'; }

/** The same ordering drives the workbench and writing brief. A reminder is not a hard goal. */
export function sortStoryThreads(threads: readonly StoryThreadView[], beforeUnit: number): StoryThreadView[] {
  const priority = { overdue: 0, due_soon: 1, normal: 2, closed: 3 };
  const urgency = { high: 0, medium: 1, low: 2 };
  return threads.map((thread): StoryThreadView => ({ ...structuredClone(thread),
    requiredNow: open(thread) && thread.requiredAtUnit === beforeUnit,
    priority: !open(thread) ? 'closed' : thread.deadlineUnit !== undefined && thread.deadlineUnit < beforeUnit ? 'overdue'
      : thread.deadlineUnit !== undefined && thread.deadlineUnit <= beforeUnit + 2 ? 'due_soon' : 'normal',
  })).sort((a, b) => priority[a.priority] - priority[b.priority] || Number(b.requiredNow) - Number(a.requiredNow) ||
    Number(b.importance === 'required') - Number(a.importance === 'required') || urgency[a.urgency] - urgency[b.urgency] ||
    (a.deadlineUnit ?? Number.MAX_SAFE_INTEGER) - (b.deadlineUnit ?? Number.MAX_SAFE_INTEGER) ||
    a.effectiveFromUnit - b.effectiveFromUnit || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function buildStoryThreads(view: Pick<SourceMemoryView, 'entries'>, controls: StoryControlCollection, beforeUnit: number,
  currentSources: readonly MemorySourceRef[] = view.entries.map((entry) => entry.source)): StoryThreadView[] {
  const threads = new Map<string, StoryThreadView>();
  const sourceHashes = new Set(currentSources.filter((source) => source.unitNumber < beforeUnit).map(hashSourceMemoryValue));
  for (const entry of view.entries) {
    if (entry.kind !== 'thread' || !entry.entity || entry.evidenceStatus !== 'matched' || entry.status !== 'active' ||
        entry.source.unitNumber >= beforeUnit || !sourceHashes.has(hashSourceMemoryValue(entry.source))) continue;
    threads.set(entry.entity, { id: `${entry.source.acceptanceId}:${entry.id}`, threadId: entry.entity, title: entry.text,
      text: entry.text, status: entry.action === 'close' ? 'resolved' : entry.action === 'drop' ? 'dropped' : 'planted',
      urgency: 'medium', importance: 'advisory', origin: 'accepted_source', source: structuredClone(entry.source),
      effectiveFromUnit: entry.source.unitNumber, requiredNow: false, priority: 'normal' });
  }
  for (const control of controls.items) {
    if (!control.enabled || control.kind !== 'thread' || !control.thread || control.fromUnit > beforeUnit ||
        (control.throughUnit !== undefined && control.throughUnit < beforeUnit)) continue;
    const thread = control.thread;
    const canonical = threads.get(thread.threadId);
    if (control.source && (!sourceHashes.has(hashSourceMemoryValue(control.source)) ||
        (canonical?.source && hashSourceMemoryValue(canonical.source) !== hashSourceMemoryValue(control.source)))) continue;
    // A source-less author thread is independent; it cannot impersonate an accepted thread identity.
    const key = control.source ? thread.threadId : `author:${control.id}`;
    threads.set(key, { id: control.id, threadId: thread.threadId, title: thread.title, text: control.text,
      status: thread.status, urgency: thread.urgency, importance: control.importance, origin: 'author', controlId: control.id,
      effectiveFromUnit: control.fromUnit, ...(control.source ? { source: structuredClone(control.source) } : {}),
      ...(thread.deadlineUnit !== undefined ? { deadlineUnit: thread.deadlineUnit } : {}),
      ...(thread.requiredAtUnit !== undefined ? { requiredAtUnit: thread.requiredAtUnit } : {}), requiredNow: false, priority: 'normal' });
  }
  return sortStoryThreads([...threads.values()], beforeUnit);
}

/** Both callers receive identical priorities; resolved/dropped threads never ask for payoff. */
export function renderStoryThreadPriorities(threads: readonly StoryThreadView[], beforeUnit: number, maxChars = 2000): string {
  const lines: string[] = [];
  let remaining = Math.max(0, Math.floor(maxChars));
  const ordered = sortStoryThreads(threads, beforeUnit).filter(open);
  const render = (thread: StoryThreadView) => {
    const label = thread.requiredNow ? '作者指定本单元必须回收' : thread.priority === 'overdue' ? '已过建议期限' : thread.priority === 'due_soon' ? '建议期限临近' : '可推进伏笔';
    return `- [${label}] ${thread.title}：${thread.text}${thread.deadlineUnit !== undefined ? `（建议期限：${thread.deadlineUnit}）` : ''}`;
  };
  const required = ordered.filter((thread) => thread.requiredNow).map(render);
  if (required.join('\n').length > remaining) throw ServiceError.validation('本单元必达伏笔超过上下文预算，请先精简作者要求。');
  lines.push(...required); remaining -= required.reduce((total, line) => total + line.length + 1, 0);
  for (const thread of ordered.filter((item) => !item.requiredNow)) {
    const line = render(thread);
    if (remaining <= 0) break;
    lines.push(line.slice(0, remaining)); remaining -= line.length + 1;
  }
  return lines.join('\n');
}
