/** Frozen, deterministic writing inputs shared by the novel and screenplay modes. */
export type WriteBriefSourceKind =
  | 'plan' | 'outline' | 'character' | 'world' | 'chapter' | 'episode'
  | 'continuity' | 'author_constraints' | 'blueprint' | 'collection' | 'request';

export interface WriteBriefSource {
  key: string;
  kind: WriteBriefSourceKind;
  id: string;
  label: string;
  contentHash: string;
  revision?: number;
  unitNumber?: number;
  excerpt?: string;
}

export interface WriteBriefItem {
  text: string;
  sourceKeys: string[];
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
  /** Source identity excluding the target body's own revision (checked by CAS). */
  sourceFingerprint: string;
  /** Full frozen brief, including its target revision and writing instructions. */
  fingerprint: string;
}

export interface WriteBriefView {
  status: 'current' | 'stale' | 'unavailable';
  origin: 'preview' | 'generation';
  brief?: WriteBrief;
  reason?: string;
  candidateHash?: string;
}

export type WriteBriefInput = Omit<WriteBrief, 'schemaVersion' | 'sourceFingerprint' | 'fingerprint'>;
