import { randomUUID } from 'node:crypto';
import type { AcceptedMemoryInput, SourceMemoryMode } from '../../types/SourceMemory.js';
import type { StoryControl, StoryControlCollection, StoryControlInput } from '../../types/StoryControl.js';
import type { WriteBriefInput } from '../../types/WriteBrief.js';
import { ServiceError } from '../ServiceError.js';
import { hashWriteBriefValue, writeBriefSourceKey } from '../writing/WriteBrief.js';

export function emptyStoryControls(): StoryControlCollection { return { schemaVersion: 1, revision: 0, items: [] }; }

/** Older projects may omit the collection; malformed saved decisions must not disappear silently. */
export function assertStoryControls(value: unknown, scope: Pick<StoryControlContext, 'clientId' | 'projectId' | 'mode'>): asserts value is StoryControlCollection {
  const fail = (): never => { throw new Error('保存的作者记录格式或来源范围无效。'); };
  if (!value || typeof value !== 'object') fail();
  const collection = value as StoryControlCollection;
  if (collection.schemaVersion !== 1 || !Number.isSafeInteger(collection.revision) || collection.revision < 0 ||
      !Array.isArray(collection.items) || collection.items.length > 300) fail();
  const ids = new Set<string>();
  for (const item of collection.items) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
        !positive(item.revision) || item.revision > collection.revision ||
        !['preference', 'fact_correction', 'thread'].includes(item.kind) || typeof item.enabled !== 'boolean' ||
        !['required', 'advisory'].includes(item.importance) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 2000 ||
        !positive(item.fromUnit) || (item.throughUnit !== undefined && (!positive(item.throughUnit) || item.throughUnit < item.fromUnit)) ||
        typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) ||
        typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))) fail();
    ids.add(item.id);
    const source = item.source;
    if (source !== undefined && (!source || source.clientId !== scope.clientId || source.projectId !== scope.projectId || source.mode !== scope.mode ||
        typeof source.resourceId !== 'string' || !source.resourceId || typeof source.acceptanceId !== 'string' || !source.acceptanceId ||
        !positive(source.unitNumber) || !Number.isSafeInteger(source.revision) || source.revision < 0 ||
        typeof source.contentHash !== 'string' || !/^[a-f\d]{64}$/u.test(source.contentHash))) fail();
    if (item.kind === 'fact_correction' && !source || item.kind === 'preference' && (source || item.thread)) fail();
    if (item.kind === 'thread') {
      const thread = item.thread;
      if (!thread || typeof thread.threadId !== 'string' || !thread.threadId.trim() || thread.threadId.length > 200 ||
          typeof thread.title !== 'string' || !thread.title.trim() || thread.title.length > 160 ||
          !['planted', 'echoed', 'resolved', 'dropped'].includes(thread.status) || !['low', 'medium', 'high'].includes(thread.urgency) ||
          (thread.deadlineUnit !== undefined && !positive(thread.deadlineUnit)) ||
          (thread.requiredAtUnit !== undefined && !positive(thread.requiredAtUnit))) fail();
    }
  }
}

export interface StoryControlContext {
  clientId: string;
  projectId: string;
  mode: SourceMemoryMode;
  activeAcceptances: readonly AcceptedMemoryInput[];
  now?: string;
}

function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw ServiceError.validation(`${label}不能为空且不能超过${maximum}字符。`);
  return value.trim();
}
function assertRevision(collection: StoryControlCollection, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw ServiceError.validation('缺少有效的作者记录版本。');
  if (collection.revision !== expectedRevision) throw ServiceError.conflict('作者记录已更新，请刷新后比较，当前编辑尚未覆盖。');
}

export function upsertStoryControlRecord(
  collection: StoryControlCollection,
  input: StoryControlInput,
  expectedRevision: number,
  context: StoryControlContext,
): { collection: StoryControlCollection; retractFromUnit?: number } {
  assertRevision(collection, expectedRevision);
  if (!input || !['preference', 'fact_correction', 'thread'].includes(input.kind) ||
      typeof input.enabled !== 'boolean' || !['required', 'advisory'].includes(input.importance) ||
      !positive(input.fromUnit) || (input.throughUnit !== undefined && (!positive(input.throughUnit) || input.throughUnit < input.fromUnit))) {
    throw ServiceError.validation('作者记录的类别、范围或重要性无效。');
  }
  const previous = input.id === undefined ? undefined : collection.items.find((item) => item.id === input.id);
  if (input.id !== undefined && !previous) throw ServiceError.notFound('作者记录不存在。');
  if (previous && previous.kind !== input.kind) throw ServiceError.validation('不能更改已有作者记录的类别。');
  if (!previous && collection.items.length >= 300) throw ServiceError.validation('作者记录达到300条上限，请先整理已有记录。');
  const now = context.now ?? new Date().toISOString();
  const id = previous?.id ?? randomUUID();
  const record: StoryControl = {
    id, revision: (previous?.revision ?? 0) + 1, kind: input.kind,
    text: text(input.text, 2000, '作者说明'), enabled: input.enabled, importance: input.importance,
    fromUnit: input.fromUnit, ...(input.throughUnit !== undefined ? { throughUnit: input.throughUnit } : {}),
    createdAt: previous?.createdAt ?? now, updatedAt: now,
  };
  if (input.source !== undefined) {
    const source = input.source;
    const matching = context.activeAcceptances.find((item) => item.source.acceptanceId === source?.acceptanceId);
    const original = previous?.source && hashWriteBriefValue(previous.source) === hashWriteBriefValue(source);
    if (!source || source.clientId !== context.clientId || source.projectId !== context.projectId || source.mode !== context.mode ||
        (!original && (!matching || hashWriteBriefValue(matching.source) !== hashWriteBriefValue(source)))) {
      throw ServiceError.conflict('所选来源已更新或不属于当前项目，请重新选择。');
    }
    record.source = structuredClone(source);
  }
  let retractFromUnit: number | undefined;
  if (record.kind === 'fact_correction') {
    if (!record.source) throw ServiceError.validation('事实订正必须选择一条已接受来源。');
    const changed = !previous || !previous.enabled || previous.text !== record.text || previous.fromUnit !== record.fromUnit ||
      previous.throughUnit !== record.throughUnit || hashWriteBriefValue(previous.source) !== hashWriteBriefValue(record.source);
    if (record.enabled && changed) {
      if (input.resolutionConfirmed !== true) throw ServiceError.validation('请明确确认作者裁决：撤回该来源及后继记忆，正文保留。');
      retractFromUnit = Math.min(record.fromUnit, record.source.unitNumber);
    }
  } else if (record.kind === 'thread') {
    const thread = input.thread;
    if (!thread || !['planted', 'echoed', 'resolved', 'dropped'].includes(thread.status) ||
        !['low', 'medium', 'high'].includes(thread.urgency) ||
        (thread.threadId !== undefined && typeof thread.threadId !== 'string') ||
        (thread.deadlineUnit !== undefined && !positive(thread.deadlineUnit)) ||
        (thread.requiredAtUnit !== undefined && !positive(thread.requiredAtUnit))) throw ServiceError.validation('伏笔状态或章集期限无效。');
    record.thread = {
      threadId: thread.threadId?.trim() || previous?.thread?.threadId || id,
      title: text(thread.title, 160, '伏笔标题'), status: thread.status, urgency: thread.urgency,
      ...(thread.deadlineUnit !== undefined ? { deadlineUnit: thread.deadlineUnit } : {}),
      ...(thread.requiredAtUnit !== undefined ? { requiredAtUnit: thread.requiredAtUnit } : {}),
    };
    if (record.thread.threadId.length > 200) throw ServiceError.validation('伏笔标识过长。');
  } else if (record.source || input.thread) throw ServiceError.validation('表达偏好不应冒充正文来源或伏笔。');
  const items = collection.items.filter((item) => item.id !== id).map((item) => structuredClone(item));
  items.push(record);
  return { collection: { schemaVersion: 1, revision: collection.revision + 1, items },
    ...(retractFromUnit !== undefined ? { retractFromUnit } : {}) };
}

export function deleteStoryControlRecord(collection: StoryControlCollection, id: string, expectedRevision: number): StoryControlCollection {
  assertRevision(collection, expectedRevision);
  if (!collection.items.some((item) => item.id === id)) throw ServiceError.notFound('作者记录不存在。');
  return { schemaVersion: 1, revision: collection.revision + 1,
    items: collection.items.filter((item) => item.id !== id).map((item) => structuredClone(item)) };
}

export function activeStoryControls(collection: StoryControlCollection | undefined, unit: number): StoryControl[] {
  return (collection?.items ?? []).filter((item) => item.enabled && item.fromUnit <= unit &&
    (item.throughUnit === undefined || item.throughUnit >= unit));
}

/** The same collection version is checked again inside the manuscript's atomic acceptance. */
export function applyStoryControlsToBrief(input: WriteBriefInput, collection?: StoryControlCollection, options: { hashOnly?: boolean } = {}): WriteBriefInput {
  if (!collection || (collection.revision === 0 && collection.items.length === 0)) return input;
  const next = structuredClone(input);
  const id = 'story-controls';
  const key = writeBriefSourceKey('author_constraints', id);
  next.sources.push({ key, kind: 'author_constraints', id, label: '作者订正与伏笔安排',
    contentHash: hashWriteBriefValue(collection), revision: collection.revision });
  if (options.hashOnly) return next;
  for (const control of activeStoryControls(collection, input.target.unitNumber)) {
    // Thread priority and deadlines are rendered by the shared thread function,
    // so the workspace and model receive the same order and required-payoff rule.
    if (control.kind === 'thread') continue;
    const item = { text: `${control.kind === 'fact_correction' ? '作者事实订正（原来源已撤回）' : '作者表达偏好'}：${control.text}`, sourceKeys: [key] };
    (control.importance === 'required' ? next.required : next.authorConstraints).push(item);
  }
  return next;
}
