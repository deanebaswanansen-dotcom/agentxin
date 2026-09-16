export type SourceMemoryMode = 'novel' | 'short_drama';
export interface MemorySourceRef {
  clientId: string; projectId: string; mode: SourceMemoryMode; resourceId: string;
  unitNumber: number; revision: number; contentHash: string; acceptanceId: string;
}
export interface MemoryEvidence { blockId: string; start: number; end: number; quote: string }
export interface SourceMemoryEntry {
  id: string; kind: 'fact' | 'state' | 'thread' | 'summary' | 'learning'; text: string;
  entity?: string; key?: string; value?: string; action?: 'set' | 'open' | 'close' | 'drop';
  evidence: MemoryEvidence[]; source: MemorySourceRef; evidenceStatus: 'matched' | 'unverified';
  evidenceReason?: string; status: 'active' | 'superseded' | 'stale';
  effectiveFromUnit: number; effectiveUntilUnit?: number;
}
export interface MemorySyncStatusView {
  mode: SourceMemoryMode; status: 'pending' | 'running' | 'succeeded' | 'failed' | 'stale' | 'legacy_untracked';
  revision: number; attempts: number; acceptedSources: number;
  error?: { code: 'SOURCE_MEMORY_SYNC_FAILED'; message: string };
}
export interface SourceMemoryView {
  mode: SourceMemoryMode; projectId: string; beforeUnit: number; projectionRevision: number;
  origin: 'projection' | 'accepted_sources'; entries: SourceMemoryEntry[]; unverifiedReferences: SourceMemoryEntry[];
  memorySync: MemorySyncStatusView;
}
export interface StoryControl {
  id: string; revision: number; kind: 'preference' | 'fact_correction' | 'thread'; text: string;
  enabled: boolean; importance: 'required' | 'advisory'; fromUnit: number; throughUnit?: number;
  source?: MemorySourceRef;
  thread?: { threadId: string; title: string; status: 'planted' | 'echoed' | 'resolved' | 'dropped';
    urgency: 'low' | 'medium' | 'high'; deadlineUnit?: number; requiredAtUnit?: number };
  createdAt: string; updatedAt: string;
}
export type StoryControlInput = Omit<StoryControl, 'id' | 'revision' | 'createdAt' | 'updatedAt'> & { id?: string; resolutionConfirmed?: boolean };
export interface StoryControlCollection { schemaVersion: 1; revision: number; items: StoryControl[] }
export interface ChapterSourcePreview { chapterId: string; title: string; content: string; revision: number; contentHash: string }
export interface MemorySourceNavigation { source: MemorySourceRef; evidence?: MemoryEvidence }
export interface StoryThreadView {
  id: string; threadId: string; title: string; text: string;
  status: 'planted' | 'echoed' | 'resolved' | 'dropped'; urgency: 'low' | 'medium' | 'high';
  importance: 'required' | 'advisory'; origin: 'accepted_source' | 'author';
  source?: MemorySourceRef; controlId?: string; effectiveFromUnit: number;
  deadlineUnit?: number; requiredAtUnit?: number; requiredNow: boolean;
  priority: 'overdue' | 'due_soon' | 'normal' | 'closed';
}
export interface StoryMemorySearchResult {
  query: string; method: 'keyword_zh_words_bigrams';
  hits: Array<{ id: string; kind: SourceMemoryEntry['kind'] | 'body'; text: string; title: string;
    source: MemorySourceRef; evidence: MemoryEvidence[]; evidenceStatus: 'matched' | 'unverified';
    evidenceReason?: string; score: number; matchedTerms: string[]; matchedMetadata?: string[]; explanation: string }>;
  authorMatches?: Array<{ controlId: string; revision: number; kind: StoryControl['kind']; text: string;
    origin: 'author'; score: number; matchedTerms: string[]; explanation: string }>;
  statistics: { elapsedMs: number; eligibleSources: number; scannedCandidates: number; scannedChars: number;
    matchedCandidates: number; returnedChars: number; topK: number; maxContextChars: number; maxScanChars: number;
    scanBudgetExhausted: boolean; outputBudgetExhausted: boolean };
}
export interface StoryMemoryWorkspaceView extends SourceMemoryView {
  acceptedSources: Array<{ source: MemorySourceRef; title: string }>;
  controls: StoryControlCollection; threads: StoryThreadView[]; retrieval?: StoryMemorySearchResult;
}
export interface StoryMemoryQuery { beforeUnit?: number; q?: string; topK?: number; maxContextChars?: number }
