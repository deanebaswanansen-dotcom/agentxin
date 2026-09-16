/** Shared accepted-source/projection contract. This phase activates screenplay sources only. */
export type SourceMemoryMode = 'short_drama' | 'novel';

export interface MemorySourceRef {
  clientId: string;
  projectId: string;
  mode: SourceMemoryMode;
  resourceId: string;
  unitNumber: number;
  revision: number;
  /** Hash of the frozen ordered blocks, not of a later mutable document. */
  contentHash: string;
  acceptanceId: string;
}

export interface MemorySourceBlock {
  id: string;
  sceneId?: string;
  text: string;
}

/** Offsets use JavaScript UTF-16 code units within the referenced frozen block. */
export interface MemoryEvidence {
  blockId: string;
  start: number;
  end: number;
  quote: string;
}

export interface AcceptedMemoryEntry {
  id: string;
  kind: 'fact' | 'state' | 'thread' | 'summary' | 'learning';
  text: string;
  entity?: string;
  key?: string;
  value?: string;
  action?: 'set' | 'open' | 'close' | 'drop';
  evidence: MemoryEvidence[];
}

export interface AcceptedMemoryInput {
  schemaVersion: 1;
  source: MemorySourceRef;
  title: string;
  acceptedAt: string;
  blocks: MemorySourceBlock[];
  entries: AcceptedMemoryEntry[];
}

/** A complete replacement for one mode's current accepted-source set. */
export interface FrozenMemoryProjection {
  schemaVersion: 1;
  clientId: string;
  projectId: string;
  mode: SourceMemoryMode;
  revision: number;
  writer: { name: 'source-memory'; version: 1 };
  acceptances: AcceptedMemoryInput[];
  contentHash: string;
  idempotencyKey: string;
}

export type MemorySyncStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'stale';

export interface MemorySyncLease {
  token: string;
  owner: string;
  expiresAt: string;
}

export interface MemorySyncIntent {
  projection: FrozenMemoryProjection;
  status: MemorySyncStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lease?: MemorySyncLease;
  error?: { code: 'SOURCE_MEMORY_SYNC_FAILED'; message: string };
}

export interface MemorySyncClaim {
  clientId: string;
  projectId: string;
  revision: number;
  idempotencyKey: string;
  lease: MemorySyncLease;
}

export interface MemorySyncTarget { clientId: string; projectId: string }

export interface SourceMemoryEntry extends AcceptedMemoryEntry {
  source: MemorySourceRef;
  /** An exact citation match is not proof of semantic entailment. */
  evidenceStatus: 'matched' | 'unverified';
  evidenceReason?: string;
  status: 'active' | 'superseded' | 'stale';
  effectiveFromUnit: number;
  effectiveUntilUnit?: number;
}

export interface SourceMemoryView {
  mode: SourceMemoryMode;
  projectId: string;
  /** Inputs from this unit or later are excluded (writing-time boundary). */
  beforeUnit: number;
  projectionRevision: number;
  origin: 'projection' | 'accepted_sources';
  entries: SourceMemoryEntry[];
  unverifiedReferences: SourceMemoryEntry[];
}

export interface MemorySyncStatusView {
  mode: SourceMemoryMode;
  status: MemorySyncStatus | 'legacy_untracked';
  revision: number;
  attempts: number;
  acceptedSources: number;
  error?: MemorySyncIntent['error'];
}
