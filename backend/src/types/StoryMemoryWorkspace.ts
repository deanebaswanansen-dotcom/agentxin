import type { AcceptedMemoryEntry, MemoryEvidence, MemorySourceRef, MemorySyncStatusView, SourceMemoryEntry, SourceMemoryMode } from './SourceMemory.js';
import type { StoryControlCollection, StoryThreadStatus } from './StoryControl.js';

export interface StoryThreadView {
  id: string;
  threadId: string;
  title: string;
  text: string;
  status: StoryThreadStatus;
  urgency: 'low' | 'medium' | 'high';
  importance: 'required' | 'advisory';
  origin: 'accepted_source' | 'author';
  source?: MemorySourceRef;
  controlId?: string;
  effectiveFromUnit: number;
  deadlineUnit?: number;
  requiredAtUnit?: number;
  requiredNow: boolean;
  priority: 'overdue' | 'due_soon' | 'normal' | 'closed';
}

export interface StoryMemorySearchHit {
  id: string;
  kind: AcceptedMemoryEntry['kind'] | 'body';
  text: string;
  title: string;
  source: MemorySourceRef;
  evidence: MemoryEvidence[];
  evidenceStatus: 'matched' | 'unverified';
  evidenceReason?: string;
  score: number;
  matchedTerms: string[];
  /** ID/name matches aid lookup but are not body evidence. */
  matchedMetadata?: string[];
  explanation: string;
}

export interface StoryMemorySearchResult {
  query: string;
  method: 'keyword_zh_words_bigrams';
  hits: StoryMemorySearchHit[];
  authorMatches?: Array<{
    controlId: string;
    revision: number;
    kind: 'preference' | 'fact_correction' | 'thread';
    text: string;
    origin: 'author';
    score: number;
    matchedTerms: string[];
    explanation: string;
  }>;
  statistics: {
    elapsedMs: number;
    eligibleSources: number;
    scannedCandidates: number;
    scannedChars: number;
    matchedCandidates: number;
    returnedChars: number;
    topK: number;
    maxContextChars: number;
    maxScanChars: number;
    scanBudgetExhausted: boolean;
    outputBudgetExhausted: boolean;
  };
}

export interface StoryMemoryWorkspaceView {
  projectId: string;
  mode: SourceMemoryMode;
  beforeUnit: number;
  projectionRevision: number;
  origin: 'projection' | 'accepted_sources';
  memorySync: MemorySyncStatusView;
  entries: SourceMemoryEntry[];
  unverifiedReferences: SourceMemoryEntry[];
  /** Current accepted sources strictly before the requested writing boundary. */
  acceptedSources: Array<{ source: MemorySourceRef; title: string }>;
  controls: StoryControlCollection;
  threads: StoryThreadView[];
  retrieval?: StoryMemorySearchResult;
}

export interface StoryMemoryContextStatistics {
  maxChars: number;
  usedChars: number;
  /** Deterministic rough estimate (UTF-16 chars / 2), not provider token usage. */
  estimatedTokens: number;
  requiredChars: number;
  sourceChars: number;
  authorChars: number;
  threadChars: number;
  retrievalChars: number;
  omittedItems: number;
  truncated: boolean;
}

export interface StoryMemoryContext { text: string; statistics: StoryMemoryContextStatistics }
