import { randomUUID } from 'node:crypto';
import type { Chapter, NovelChapterAcceptance, Project } from '../../types/index.js';
import type { AcceptedMemoryEntry, MemorySourceBlock } from '../../types/SourceMemory.js';
import { createFrozenMemoryProjection, hashSourceMemoryBlocks, hashSourceMemoryValue, validateFrozenMemoryProjection } from '../memory/sourceMemoryContract.js';
import { hashWriteBriefValue } from '../writing/WriteBrief.js';

export function novelMemoryBlocks(content: string): MemorySourceBlock[] {
  // Keep every code unit, including line endings, so replay never needs a parser/model.
  return content.split(/(?<=\n)/u).map((text, index) => ({ id: `paragraph-${index + 1}`, text }));
}

function ordered(chapters: Chapter[], projectId: string): Chapter[] {
  return chapters.filter((chapter) => chapter.projectId === projectId).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

function dependency(chapter: Chapter, index: number): NovelChapterAcceptance['dependencies'][number] {
  return { id: chapter.id, title: chapter.title, revision: chapter.revision ?? 0, contentHash: hashWriteBriefValue(chapter.content), unitNumber: index + 1 };
}

export function createNovelAcceptance(clientId: string, chapter: Chapter, chapters: Chapter[], candidates: AcceptedMemoryEntry[] = []): NovelChapterAcceptance {
  const sorted = ordered(chapters, chapter.projectId);
  const index = sorted.findIndex((item) => item.id === chapter.id);
  const blocks = novelMemoryBlocks(chapter.content);
  const entries = structuredClone(candidates);
  // A manual acceptance is an attributable passage, not an invented summary or fact.
  if (entries.length === 0) blocks.filter((block) => block.text.trim()).forEach((block) => entries.push({
    id: `passage:${block.id}`, kind: 'summary', text: block.text, evidence: [{ blockId: block.id, start: 0, end: block.text.length, quote: block.text }],
  }));
  const id = randomUUID();
  return {
    id, status: 'current', dependencies: sorted.slice(0, index).map(dependency),
    memoryInput: { schemaVersion: 1,
      source: { clientId, projectId: chapter.projectId, mode: 'novel', resourceId: chapter.id, unitNumber: index + 1,
        revision: chapter.revision ?? 0, contentHash: hashSourceMemoryBlocks(blocks), acceptanceId: id },
      title: chapter.title, acceptedAt: new Date().toISOString(), blocks, entries },
  };
}

/** Revoke edited/reordered/deleted sources and all manuscript-dependent successors; never revive history. */
export function refreshNovelMemoryIntent(project: Project, chapters: Chapter[], clientId: string): boolean {
  const original = hashSourceMemoryValue({ acceptances: project.novelAcceptances, intent: project.memorySync });
  const sorted = ordered(chapters, project.id);
  for (const acceptance of project.novelAcceptances ?? []) {
    if (acceptance.status !== 'current') continue;
    const source = acceptance.memoryInput?.source;
    const index = sorted.findIndex((chapter) => chapter.id === source?.resourceId);
    const chapter = sorted[index];
    let valid = Boolean(chapter && source && source.acceptanceId === acceptance.id && source.clientId === clientId &&
      source.projectId === project.id && source.mode === 'novel' && source.revision === (chapter.revision ?? 0) &&
      source.unitNumber === index + 1 && acceptance.memoryInput.title === chapter.title &&
      hashSourceMemoryValue(acceptance.dependencies) === hashSourceMemoryValue(sorted.slice(0, index).map(dependency)));
    try {
      valid = valid && source!.contentHash === hashSourceMemoryBlocks(acceptance.memoryInput.blocks) &&
        source!.contentHash === hashSourceMemoryBlocks(novelMemoryBlocks(chapter!.content));
    } catch { valid = false; }
    if (!valid) acceptance.status = 'stale';
  }
  for (const chapter of sorted) if (chapter.acceptance) {
    const record = project.novelAcceptances?.find((item) => item.id === chapter.acceptance!.id);
    if (!record || record.status !== 'current') chapter.acceptance.status = 'stale';
  }
  const acceptances = (project.novelAcceptances ?? []).filter((item) => item.status === 'current').map((item) => item.memoryInput)
    .sort((a, b) => a.source.unitNumber - b.source.unitNumber || a.source.resourceId.localeCompare(b.source.resourceId) || a.source.acceptanceId.localeCompare(b.source.acceptanceId));
  const previous = project.memorySync;
  if (previous) {
    validateFrozenMemoryProjection(previous.projection);
    if (previous.projection.clientId !== clientId || previous.projection.projectId !== project.id || previous.projection.mode !== 'novel') throw new Error('Novel memory projection scope mismatch');
  }
  if ((previous || acceptances.length > 0) && (!previous || hashSourceMemoryValue(previous.projection.acceptances) !== hashSourceMemoryValue(acceptances))) {
    const now = new Date().toISOString();
    project.memorySync = { projection: createFrozenMemoryProjection({ clientId, projectId: project.id, mode: 'novel',
      revision: (previous?.projection.revision ?? 0) + 1, acceptances }), status: 'pending', attempts: 0, createdAt: now, updatedAt: now };
  }
  return original !== hashSourceMemoryValue({ acceptances: project.novelAcceptances, intent: project.memorySync });
}

export function retractNovelSourcesFrom(project: Project, unitNumber: number): void {
  for (const acceptance of project.novelAcceptances ?? []) {
    if (acceptance.memoryInput.source.unitNumber >= unitNumber) acceptance.status = 'stale';
  }
}
