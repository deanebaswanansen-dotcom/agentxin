import type { MemorySourceRef, StoryMemoryWorkspaceView } from '../types/storyMemory.js';
export const memorySource: MemorySourceRef = { clientId: 'private-client-id', projectId: 'p-1', mode: 'novel', resourceId: 'ch-1', unitNumber: 1, revision: 2, contentHash: 'private-body-hash', acceptanceId: 'accepted-1' };
export function makeStoryMemory(overrides: Partial<StoryMemoryWorkspaceView> = {}): StoryMemoryWorkspaceView {
  return { projectId: 'p-1', mode: 'novel', beforeUnit: 3, projectionRevision: 1, origin: 'projection',
    memorySync: { mode: 'novel', status: 'succeeded', revision: 1, attempts: 1, acceptedSources: 1 },
    entries: [{ id: 'key', kind: 'fact', text: '钥匙在门外。', source: memorySource,
      evidence: [{ blockId: 'body', start: 0, end: 2, quote: '钥匙' }], evidenceStatus: 'matched', status: 'active', effectiveFromUnit: 1 }],
    unverifiedReferences: [{ id: 'unknown', kind: 'fact', text: '门后有陌生人。', source: memorySource,
      evidence: [], evidenceStatus: 'unverified', evidenceReason: 'missing_evidence', status: 'active', effectiveFromUnit: 1 }],
    acceptedSources: [{ source: memorySource, title: '失踪的钥匙' }], controls: { schemaVersion: 1, revision: 2, items: [] }, threads: [], ...overrides };
}
