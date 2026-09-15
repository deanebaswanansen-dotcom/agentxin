import type { FrozenMemoryProjection, MemorySourceRef, SourceMemoryEntry, SourceMemoryMode } from '../../types/SourceMemory.js';
import { ServiceError } from '../ServiceError.js';
import { classifySourceMemoryEntries, hashSourceMemoryValue, sourceMemoryEntryHistory } from './sourceMemoryContract.js';

export type SourceMemoryFailure = 'SOURCE_MEMORY_STALE' | 'SOURCE_MEMORY_CONFLICT' | 'SOURCE_MEMORY_DELETED';

/** Transport retains CONFLICT; workers may distinguish stale input from I/O failure. */
export function sourceMemoryConflict(sourceMemoryCode: SourceMemoryFailure): ServiceError & { sourceMemoryCode: SourceMemoryFailure } {
  const message = sourceMemoryCode === 'SOURCE_MEMORY_DELETED' ? '项目已删除，记忆不能重新写入。'
    : sourceMemoryCode === 'SOURCE_MEMORY_STALE' ? '接受来源已过期，请重新读取当前来源。' : '接受来源版本冲突，未更新记忆。';
  return Object.assign(ServiceError.conflict(message), { sourceMemoryCode });
}

export interface SourceMemoryAuditSource {
  source: MemorySourceRef;
  title: string;
  acceptedAt: string;
  /** Covers the complete original input without retaining another body copy. */
  inputHash: string;
  status: 'active' | 'stale';
  firstProjectionRevision: number;
  withdrawnAtRevision?: number;
}

export interface SourceMemoryPartition {
  schemaVersion: 1;
  clientId: string;
  projectId: string;
  mode: SourceMemoryMode;
  revision: number;
  contentHash: string;
  idempotencyKey: string;
  sources: SourceMemoryAuditSource[];
  entries: SourceMemoryEntry[];
  /** Integrity of this derived cache and its withdrawal audit, not a body hash. */
  storageHash: string;
}

export function assertProjectionFollows(current: SourceMemoryPartition | undefined, projection: FrozenMemoryProjection): void {
  if (!current) return;
  if (current.clientId !== projection.clientId || current.projectId !== projection.projectId || current.mode !== projection.mode)
    throw ServiceError.validation('记忆来源与当前客户端或项目不匹配。');
  if (projection.revision < current.revision) throw sourceMemoryConflict('SOURCE_MEMORY_STALE');
  if (projection.revision === current.revision && projection.contentHash !== current.contentHash)
    throw sourceMemoryConflict('SOURCE_MEMORY_CONFLICT');
  const known = new Map(current.sources.map((item) => [item.source.acceptanceId, item]));
  const highWater = new Map<string, number>();
  for (const item of current.sources) highWater.set(item.source.resourceId,
    Math.max(highWater.get(item.source.resourceId) ?? 0, item.source.revision));
  for (const input of projection.acceptances) {
    const previous = known.get(input.source.acceptanceId);
    if (previous?.status === 'stale' || input.source.revision < (highWater.get(input.source.resourceId) ?? 0))
      throw sourceMemoryConflict('SOURCE_MEMORY_STALE');
    if (previous && previous.inputHash !== hashSourceMemoryValue(input)) throw sourceMemoryConflict('SOURCE_MEMORY_CONFLICT');
  }
}

export function replaceSourceMemoryPartition(current: SourceMemoryPartition | undefined, projection: FrozenMemoryProjection): SourceMemoryPartition {
  assertProjectionFollows(current, projection);
  if (current?.revision === projection.revision) return structuredClone(current);
  const incoming = new Set(projection.acceptances.map((input) => input.source.acceptanceId));
  const sources = structuredClone(current?.sources ?? []);
  for (const source of sources) if (source.status === 'active' && !incoming.has(source.source.acceptanceId)) {
    source.status = 'stale'; source.withdrawnAtRevision = projection.revision;
  }
  const knownIds = new Set(sources.map((source) => source.source.acceptanceId));
  for (const input of projection.acceptances) if (!knownIds.has(input.source.acceptanceId)) sources.push({
    source: structuredClone(input.source), title: input.title, acceptedAt: input.acceptedAt,
    inputHash: hashSourceMemoryValue(input), status: 'active', firstProjectionRevision: projection.revision,
  });
  const staleEntries = (current?.entries ?? []).filter((entry) => !incoming.has(entry.source.acceptanceId))
    .map((entry) => ({ ...structuredClone(entry), status: 'stale' as const }));
  const data = {
    schemaVersion: 1 as const, clientId: projection.clientId, projectId: projection.projectId, mode: projection.mode,
    revision: projection.revision, contentHash: projection.contentHash, idempotencyKey: projection.idempotencyKey,
    sources, entries: sourceMemoryEntryHistory([...staleEntries, ...classifySourceMemoryEntries(projection)]),
  };
  return { ...data, storageHash: hashSourceMemoryValue(data) };
}

/** Cache files with unknown versions or damaged audit are not silently treated as empty. */
export function validateSourceMemoryPartition(value: unknown, projectId: string, mode: string): asserts value is SourceMemoryPartition {
  const invalid = () => { throw new Error('Invalid source memory partition'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const partition = value as SourceMemoryPartition;
  if (partition.schemaVersion !== 1 || partition.projectId !== projectId || partition.mode !== mode ||
      (partition.clientId !== 'local' && !/^[a-f0-9]{64}$/u.test(partition.clientId)) ||
      !Number.isSafeInteger(partition.revision) || partition.revision < 0 || !Array.isArray(partition.sources) ||
      !Array.isArray(partition.entries) || !/^[a-f0-9]{64}$/u.test(partition.contentHash) ||
      partition.idempotencyKey !== `source-memory:v1:${partition.contentHash}`) invalid();
  const { storageHash, ...data } = partition;
  if (storageHash !== hashSourceMemoryValue(data)) invalid();
  const ids = new Set<string>();
  for (const item of partition.sources) {
    if (!item?.source || typeof item.source.acceptanceId !== 'string' || ids.has(item.source.acceptanceId) ||
        item.source.clientId !== partition.clientId || item.source.projectId !== projectId || item.source.mode !== mode ||
        !['active', 'stale'].includes(item.status) || !/^[a-f0-9]{64}$/u.test(item.inputHash)) invalid();
    ids.add(item.source.acceptanceId);
  }
  for (const entry of partition.entries) if (!entry?.source || !ids.has(entry.source.acceptanceId) ||
    !['active', 'superseded', 'stale'].includes(entry.status) || !['matched', 'unverified'].includes(entry.evidenceStatus)) invalid();
}
