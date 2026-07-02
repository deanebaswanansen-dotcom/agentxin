import type { Chapter, Id } from '../types/index.js';

export interface ChapterSnapshot {
  id: string;
  chapterId: Id;
  title: string;
  content: string;
  createdAt: string;
  reason: string;
}

const STORAGE_KEY = 'nwa:chapter-snapshots:v1';
const MAX_SNAPSHOTS_PER_CHAPTER = 20;

function readAllSnapshots(): ChapterSnapshot[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ChapterSnapshot => (
      typeof item?.id === 'string' &&
      typeof item.chapterId === 'string' &&
      typeof item.title === 'string' &&
      typeof item.content === 'string' &&
      typeof item.createdAt === 'string' &&
      typeof item.reason === 'string'
    ));
  } catch {
    return [];
  }
}

function writeAllSnapshots(snapshots: ChapterSnapshot[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots));
  } catch {
    // Snapshot history is a local safety net; storage failures must not block saving.
  }
}

export function listChapterSnapshots(chapterId: Id): ChapterSnapshot[] {
  return readAllSnapshots()
    .filter((snapshot) => snapshot.chapterId === chapterId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function saveChapterSnapshot(
  chapter: Pick<Chapter, 'id' | 'title' | 'content'>,
  reason: string,
  createdAt = new Date().toISOString(),
): ChapterSnapshot | null {
  const existing = readAllSnapshots();
  const chapterSnapshots = existing
    .filter((snapshot) => snapshot.chapterId === chapter.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (chapterSnapshots[0]?.content === chapter.content) {
    return null;
  }

  const snapshot: ChapterSnapshot = {
    id: `${chapter.id}-${createdAt}`,
    chapterId: chapter.id,
    title: chapter.title,
    content: chapter.content,
    createdAt,
    reason,
  };

  const retainedForChapter = [snapshot, ...chapterSnapshots].slice(0, MAX_SNAPSHOTS_PER_CHAPTER);
  const retainedIds = new Set(retainedForChapter.map((item) => item.id));
  const next = [
    ...existing.filter(
      (item) => item.chapterId !== chapter.id || retainedIds.has(item.id),
    ),
    snapshot,
  ];
  writeAllSnapshots(next);
  return snapshot;
}

