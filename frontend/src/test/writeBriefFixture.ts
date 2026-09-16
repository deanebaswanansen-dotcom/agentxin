import type { WriteBrief } from '../types/writeBrief.js';

export function makeWriteBrief(overrides: Partial<WriteBrief> = {}): WriteBrief {
  return {
    schemaVersion: 1,
    mode: 'novel',
    projectId: 'p-1',
    target: { id: 'ch-1', unitNumber: 2, revision: 3, title: '第二章' },
    objective: [{ text: '寻找失踪同伴', sourceKeys: ['outline-1'] }],
    required: [{ text: '承接上一章留下的信件', sourceKeys: ['chapter-1'] }],
    forbidden: [{ text: '不能提前揭晓幕后主使', sourceKeys: ['outline-1'] }],
    authorConstraints: [{ text: '保持第三人称', sourceKeys: ['author-1'] }],
    sources: [{ key: 'chapter-1', id: 'previous', kind: 'chapter', label: '第 1 章：失踪', revision: 2, contentHash: 'private-source-hash' }],
    sourceFingerprint: 'private-source-fingerprint',
    fingerprint: 'private-brief-fingerprint',
    ...overrides,
  };
}
