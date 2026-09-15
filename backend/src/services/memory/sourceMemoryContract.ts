import { createHash } from 'node:crypto';
import type {
  AcceptedMemoryInput, FrozenMemoryProjection, MemorySourceBlock, SourceMemoryEntry,
  SourceMemoryView,
} from '../../types/SourceMemory.js';
import { ServiceError } from '../ServiceError.js';
import { isValidClientId } from '../client/clientScope.js';

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => compare(a, b)).map(([key, item]) => [key, canonical(item)]));
}

export function hashSourceMemoryValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}

/** Preserve block order and exact text: evidence positions address these UTF-16 strings. */
export function hashSourceMemoryBlocks(blocks: readonly MemorySourceBlock[]): string {
  validateBlocks(blocks);
  return hashSourceMemoryValue(blocks.map(({ id, sceneId, text }) => ({ id, ...(sceneId !== undefined ? { sceneId } : {}), text })));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function integer(value: unknown, minimum = 0): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum; }
function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f\d]{64}$/u.test(value); }
function invalid(): never { throw ServiceError.validation('接受来源记忆快照无效，未更新投影。'); }

function validateBlocks(blocks: unknown): asserts blocks is MemorySourceBlock[] {
  if (!Array.isArray(blocks)) invalid();
  const ids = new Set<string>();
  for (const block of blocks) {
    if (!record(block) || !nonempty(block.id) || typeof block.text !== 'string' ||
        (block.sceneId !== undefined && !nonempty(block.sceneId)) || ids.has(block.id)) invalid();
    ids.add(block.id);
  }
}

function validateAcceptance(value: unknown, projection: Pick<FrozenMemoryProjection, 'clientId' | 'projectId' | 'mode'>): asserts value is AcceptedMemoryInput {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.source) || !nonempty(value.title) ||
      typeof value.acceptedAt !== 'string' || !Number.isFinite(Date.parse(value.acceptedAt))) invalid();
  const source = value.source;
  if (source.clientId !== projection.clientId || source.projectId !== projection.projectId || source.mode !== projection.mode ||
      !nonempty(source.resourceId) || !nonempty(source.acceptanceId) || !integer(source.unitNumber, 1) || !integer(source.revision) || !hash(source.contentHash)) invalid();
  validateBlocks(value.blocks);
  if (hashSourceMemoryBlocks(value.blocks) !== source.contentHash || !Array.isArray(value.entries)) invalid();
  const ids = new Set<string>();
  for (const entry of value.entries) {
    if (!record(entry) || !nonempty(entry.id) || ids.has(entry.id) || !nonempty(entry.text) ||
        !['fact', 'state', 'thread', 'summary', 'learning'].includes(String(entry.kind)) || !Array.isArray(entry.evidence)) invalid();
    for (const key of ['entity', 'key', 'value'] as const) if (entry[key] !== undefined && typeof entry[key] !== 'string') invalid();
    if (entry.action !== undefined && !['set', 'open', 'close', 'drop'].includes(String(entry.action))) invalid();
    for (const evidence of entry.evidence) {
      if (!record(evidence) || typeof evidence.blockId !== 'string' || typeof evidence.quote !== 'string' ||
          typeof evidence.start !== 'number' || !Number.isFinite(evidence.start) || typeof evidence.end !== 'number' || !Number.isFinite(evidence.end)) invalid();
    }
    ids.add(entry.id);
  }
}

type ProjectionInput = Pick<FrozenMemoryProjection, 'clientId' | 'projectId' | 'mode' | 'revision' | 'acceptances'>;

function projectionPayload(input: ProjectionInput) {
  return {
    schemaVersion: 1 as const, clientId: input.clientId, projectId: input.projectId, mode: input.mode,
    revision: input.revision, writer: { name: 'source-memory' as const, version: 1 as const },
    acceptances: structuredClone(input.acceptances).sort((a, b) => a.source.unitNumber - b.source.unitNumber ||
      compare(a.source.resourceId, b.source.resourceId) || compare(a.source.acceptanceId, b.source.acceptanceId)),
  };
}

export function createFrozenMemoryProjection(input: ProjectionInput): FrozenMemoryProjection {
  const value = projectionPayload(input);
  const contentHash = hashSourceMemoryValue(value);
  const projection = { ...value, contentHash, idempotencyKey: `source-memory:v1:${contentHash}` };
  validateFrozenMemoryProjection(projection);
  return projection;
}

export function validateFrozenMemoryProjection(value: unknown): asserts value is FrozenMemoryProjection {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.clientId !== 'string' ||
      (value.clientId !== 'local' && !isValidClientId(value.clientId)) || !nonempty(value.projectId) ||
      !['short_drama', 'novel'].includes(String(value.mode)) || !integer(value.revision) || !Array.isArray(value.acceptances) ||
      !record(value.writer) || value.writer.name !== 'source-memory' || value.writer.version !== 1 || !hash(value.contentHash)) invalid();
  const projection = value as unknown as FrozenMemoryProjection;
  const acceptanceIds = new Set<string>(); const resourceIds = new Set<string>(); const units = new Set<number>();
  for (const acceptance of value.acceptances) {
    validateAcceptance(acceptance, projection);
    if (acceptanceIds.has(acceptance.source.acceptanceId) || resourceIds.has(acceptance.source.resourceId) || units.has(acceptance.source.unitNumber)) invalid();
    acceptanceIds.add(acceptance.source.acceptanceId); resourceIds.add(acceptance.source.resourceId); units.add(acceptance.source.unitNumber);
  }
  const expectedHash = hashSourceMemoryValue(projectionPayload(projection));
  if (value.contentHash !== expectedHash || value.idempotencyKey !== `source-memory:v1:${expectedHash}`) invalid();
}

/** Classification proves citation identity only; it never infers that the quote entails the claim. */
export function classifySourceMemoryEntries(projection: FrozenMemoryProjection): SourceMemoryEntry[] {
  const entries = projection.acceptances.flatMap((acceptance) => acceptance.entries.map((entry): SourceMemoryEntry => {
    let reason: string | undefined;
    if (entry.evidence.length === 0) reason = 'missing_evidence';
    else if (entry.evidence.some((evidence) => {
      const block = acceptance.blocks.find((candidate) => candidate.id === evidence.blockId);
      return !block || !integer(evidence.start) || !integer(evidence.end) || evidence.end <= evidence.start || evidence.end > block.text.length ||
        !evidence.quote || block.text.slice(evidence.start, evidence.end) !== evidence.quote;
    })) reason = 'citation_mismatch';
    if ((entry.kind === 'state' || entry.kind === 'thread') && (!nonempty(entry.entity) || !nonempty(entry.key))) reason = 'missing_state_identity';
    if (entry.kind === 'state' && (!nonempty(entry.value) || (entry.action !== undefined && entry.action !== 'set'))) reason = 'missing_state_value';
    if (entry.kind === 'thread' && !['open', 'close', 'drop'].includes(entry.action ?? '')) reason = 'missing_thread_action';
    return { ...structuredClone(entry), source: structuredClone(acceptance.source), evidenceStatus: reason ? 'unverified' : 'matched',
      ...(reason ? { evidenceReason: reason } : {}), status: 'active', effectiveFromUnit: acceptance.source.unitNumber };
  }));
  // No event order exists within one accepted unit. Conflicting claims cannot
  // select a hard state merely by their array position (even with exact quotes).
  const claims = new Map<string, SourceMemoryEntry[]>();
  for (const entry of entries) {
    const identity = stateKey(entry);
    if (!identity) continue;
    const key = JSON.stringify([entry.source.acceptanceId, identity]);
    const group = claims.get(key) ?? [];
    group.push(entry); claims.set(key, group);
  }
  for (const group of claims.values()) {
    const values = new Set(group.map((entry) => JSON.stringify([entry.value, entry.action ?? (entry.kind === 'state' ? 'set' : undefined)])));
    if (values.size > 1) for (const entry of group) {
      entry.evidenceStatus = 'unverified'; entry.evidenceReason = 'conflicting_state_claims';
    }
  }
  return entries;
}

function stateKey(entry: SourceMemoryEntry): string | undefined {
  if (entry.kind !== 'state' && entry.kind !== 'thread') return undefined;
  return JSON.stringify([entry.kind, entry.entity, entry.key]);
}

/** No future source, even its interval end, is exposed in a writing-time view. */
export function sourceMemoryEntriesAt(entries: readonly SourceMemoryEntry[], beforeUnit: number): Pick<SourceMemoryView, 'entries' | 'unverifiedReferences'> {
  if (!integer(beforeUnit, 1)) throw ServiceError.validation('记忆查询单元必须是正整数。');
  const eligible = entries.filter((entry) => entry.status !== 'stale' && entry.source.unitNumber < beforeUnit)
    .map((entry) => { const copy = structuredClone(entry); copy.status = 'active'; delete copy.effectiveUntilUnit; return copy; })
    .sort((a, b) => a.source.unitNumber - b.source.unitNumber || compare(a.source.acceptanceId, b.source.acceptanceId));
  const latest = new Map<string, SourceMemoryEntry>();
  for (const entry of eligible) {
    if (entry.evidenceStatus !== 'matched') continue;
    const key = stateKey(entry);
    if (!key) continue;
    const previous = latest.get(key);
    if (previous) { previous.status = 'superseded'; previous.effectiveUntilUnit = entry.source.unitNumber; }
    latest.set(key, entry);
  }
  return { entries: eligible.filter((entry) => entry.evidenceStatus === 'matched' && entry.status === 'active'),
    unverifiedReferences: eligible.filter((entry) => entry.evidenceStatus === 'unverified') };
}

/** Full intervals are retained for audit; writing queries rebuild them using past inputs only. */
export function sourceMemoryEntryHistory(entries: readonly SourceMemoryEntry[]): SourceMemoryEntry[] {
  const result = structuredClone([...entries]).sort((a, b) => a.source.unitNumber - b.source.unitNumber || compare(a.source.acceptanceId, b.source.acceptanceId));
  const latest = new Map<string, SourceMemoryEntry>();
  for (const entry of result) {
    if (entry.status === 'stale') continue;
    entry.status = 'active'; delete entry.effectiveUntilUnit;
    if (entry.evidenceStatus !== 'matched') continue;
    const key = stateKey(entry); if (!key) continue;
    const previous = latest.get(key);
    if (previous) { previous.status = 'superseded'; previous.effectiveUntilUnit = entry.source.unitNumber; }
    latest.set(key, entry);
  }
  return result;
}

export function projectSourceMemory(projection: FrozenMemoryProjection, beforeUnit: number, origin: SourceMemoryView['origin'] = 'accepted_sources'): SourceMemoryView {
  validateFrozenMemoryProjection(projection);
  return { mode: projection.mode, projectId: projection.projectId, beforeUnit, projectionRevision: projection.revision,
    origin, ...sourceMemoryEntriesAt(classifySourceMemoryEntries(projection), beforeUnit) };
}
