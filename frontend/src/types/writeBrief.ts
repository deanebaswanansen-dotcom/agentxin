/** Versioned writing inputs supplied by the server; never reconstructed from UI labels. */
export interface WriteBriefItem {
  text: string;
  sourceKeys: string[];
}

export interface WriteBriefSource {
  key: string;
  kind: 'plan' | 'outline' | 'character' | 'world' | 'chapter' | 'episode' | 'continuity' | 'author_constraints' | 'blueprint' | 'collection' | 'request';
  id: string;
  label: string;
  contentHash: string;
  revision?: number;
  unitNumber?: number;
  excerpt?: string;
}

export interface WriteBrief {
  schemaVersion: 1;
  mode: 'short_drama' | 'novel';
  projectId: string;
  target: { id: string; unitNumber: number; revision: number; title: string };
  objective: WriteBriefItem[];
  required: WriteBriefItem[];
  forbidden: WriteBriefItem[];
  authorConstraints: WriteBriefItem[];
  sources: WriteBriefSource[];
  sourceFingerprint: string;
  fingerprint: string;
}

export interface WriteBriefView {
  status: 'current' | 'stale' | 'unavailable';
  origin: 'preview' | 'generation';
  brief?: WriteBrief;
  reason?: string;
  candidateHash?: string;
}
