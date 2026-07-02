import type { BuildContextOptions } from '../../memory/MemoryService.js';

export interface CanonLock {
  id: string;
  keyword: string;
  introducedBy: number;
  rule: string;
}

export interface InspectorCharacterStatus {
  id: string;
  consistent: boolean;
  note: string;
}

export interface InspectorReport {
  score0to100: number;
  verdict: string;
  plotCoherence: string;
  fatalIssues: string[];
  earlyCharacterStatus: InspectorCharacterStatus[];
  recommendRevision: boolean;
  revisionHints: string[];
  structuralChecks: Array<{
    id: string;
    keyword: string;
    inInjectedMemory: boolean;
    inEarlyChapters: boolean;
    inRecentChapters: boolean;
    pass: boolean;
  }>;
  injectedMemoryChars: number;
  injectedMemoryOptions: BuildContextOptions;
}

export interface InspectChapterInput {
  projectId: string;
  atChapter: number;
  chapterTitle: string;
  chapterContent: string;
  canonLocks?: CanonLock[];
  earlyChapterSamples: Array<{ title: string; excerpt: string }>;
  recentChapterSamples: Array<{ title: string; excerpt: string }>;
  injectedMemory: string;
  injectedMemoryOptions: BuildContextOptions;
}