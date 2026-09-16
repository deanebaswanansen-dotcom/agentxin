import type { Chapter, ChapterBlueprint, Character, Outline, Project, SceneDraft, WorldSetting } from '../types/index.js';
import type { WriteBrief, WriteBriefSource } from '../types/WriteBrief.js';
import { createWriteBrief, hashWriteBriefValue, writeBriefSourceKey } from '../services/writing/WriteBrief.js';
import { ServiceError } from '../services/ServiceError.js';
import type { DataStore } from './DataStore.js';

export interface NovelWriteGuard {
  brief: WriteBrief;
  signal?: AbortSignal;
  /** Extra scene dependencies, including an absent draft when a scene starts. */
  sceneDrafts?: Array<{ sceneId: string; contentHash: string }>;
}

export interface NovelWriteSnapshot {
  project?: Project;
  chapter?: Chapter;
  chapters: Chapter[];
  characters: Character[];
  worldSettings: WorldSetting[];
  outlines: Outline[];
  blueprint?: ChapterBlueprint;
  sceneDrafts: SceneDraft[];
}

export function novelBlueprintContent(blueprint?: ChapterBlueprint): unknown {
  if (!blueprint) return null;
  const { writeBrief: _brief, ...content } = blueprint;
  return content;
}

export function buildNovelWriteBrief(snapshot: NovelWriteSnapshot, options: { requirement?: string; targetWords?: number } = {}): WriteBrief {
  const { chapter, project, blueprint } = snapshot;
  options = { ...blueprint?.authorRequirements, ...options };
  if (!chapter || !project) throw ServiceError.notFound('写作目标章节或项目不存在。');
  const ordered = [...snapshot.chapters].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const index = ordered.findIndex((item) => item.id === chapter.id);
  const sources: WriteBriefSource[] = [];
  const add = (kind: WriteBriefSource['kind'], id: string, label: string, content: unknown, excerpt?: string): string => {
    const key = writeBriefSourceKey(kind, id);
    sources.push({ key, kind, id, label, contentHash: hashWriteBriefValue(content), ...(excerpt ? { excerpt: excerpt.slice(0, 500) } : {}) });
    return key;
  };
  add('collection', 'project', '项目', { id: project.id, name: project.name, kind: project.kind });
  add('collection', 'chapters', '章节集合与顺序', ordered.map(({ id, title, position }) => ({ id, title, position })));
  const groups = [
    ['character', snapshot.characters, '人物'],
    ['world', snapshot.worldSettings, '世界观'],
    ['outline', snapshot.outlines, '大纲'],
  ] as const;
  for (const [kind, entities, label] of groups) {
    const sorted = [...entities].sort((a, b) => a.id.localeCompare(b.id));
    add('collection', kind, `${label}资料集合`, sorted.map((entity) => entity.id));
    for (const entity of sorted) add(kind, entity.id, 'name' in entity ? entity.name : entity.title, entity, 'description' in entity ? entity.description : entity.content);
  }
  for (const [precedingIndex, preceding] of ordered.slice(0, index).entries()) {
    add('chapter', preceding.id, preceding.title, { id: preceding.id, title: preceding.title, content: preceding.content, position: preceding.position }, preceding.content.slice(-500));
    sources[sources.length - 1]!.unitNumber = precedingIndex + 1;
    sources[sources.length - 1]!.revision = preceding.revision ?? 0;
  }
  const blueprintKey = add('blueprint', chapter.id, '当前场景蓝图', novelBlueprintContent(blueprint));
  const requestKey = options.requirement ? add('request', 'requirement', '本次写作要求', options.requirement, options.requirement) : undefined;
  const wordKey = options.targetWords ? add('request', 'targetWords', '本次目标字数', options.targetWords) : undefined;
  const item = (text: string) => ({ text, sourceKeys: [blueprintKey] });
  return createWriteBrief({
    mode: 'novel', projectId: chapter.projectId,
    target: { id: chapter.id, title: chapter.title, revision: chapter.revision ?? 0, unitNumber: index + 1 },
    objective: [item(blueprint?.main_goal || `完成「${chapter.title}」正文。`)],
    required: (blueprint?.required_plot_points ?? []).map(item),
    forbidden: (blueprint?.forbidden_points ?? []).map(item),
    authorConstraints: [
      ...(requestKey ? [{ text: options.requirement!, sourceKeys: [requestKey] }] : []),
      ...(wordKey ? [{ text: `目标约 ${options.targetWords} 字。`, sourceKeys: [wordKey] }] : []),
    ], sources,
  });
}

export async function captureNovelWriteSnapshot(store: DataStore, chapterId: string): Promise<NovelWriteSnapshot> {
  const chapter = await store.getChapter(chapterId);
  if (!chapter) throw ServiceError.notFound(`章节不存在：${chapterId}`);
  const [project, chapters, characters, worldSettings, outlines, blueprint, sceneDrafts] = await Promise.all([
    store.getProject(chapter.projectId), store.listChapters(chapter.projectId), store.listCharacters(chapter.projectId),
    store.listWorldSettings(chapter.projectId), store.listOutlines(chapter.projectId),
    store.getChapterBlueprintByChapter(chapterId), store.listSceneDrafts(chapterId),
  ]);
  return { project, chapter, chapters, characters, worldSettings, outlines, blueprint, sceneDrafts };
}

export async function captureNovelWriteBrief(store: DataStore, chapterId: string, options: { requirement?: string; targetWords?: number } = {}): Promise<WriteBrief> {
  const snapshot = await captureNovelWriteSnapshot(store, chapterId);
  assertNovelBlueprintCurrent(snapshot);
  return buildNovelWriteBrief(snapshot, options);
}

export function assertNovelBlueprintCurrent(snapshot: NovelWriteSnapshot): void {
  const brief = snapshot.blueprint?.writeBrief;
  if (!brief) return;
  const chapter = snapshot.chapter;
  const candidate = chapter?.generatedCandidate;
  const mayRebase = chapter && candidate && candidate.candidateHash === hashWriteBriefValue(chapter.content) &&
    candidate.brief.sourceFingerprint === brief.sourceFingerprint && (chapter.revision ?? 0) === candidate.brief.target.revision + 1;
  assertNovelWriteGuard(snapshot, { brief: mayRebase ? rebaseNovelWriteBrief(brief, chapter.revision ?? 0) : brief });
}

export function assertNovelWriteGuard(snapshot: NovelWriteSnapshot, guard: NovelWriteGuard): void {
  guard.signal?.throwIfAborted();
  const current = buildNovelWriteBrief(snapshot);
  const expected = guard.brief;
  try {
    const { schemaVersion, fingerprint, sourceFingerprint, ...input } = expected;
    const verified = createWriteBrief(input);
    if (schemaVersion !== 1 || verified.fingerprint !== fingerprint || verified.sourceFingerprint !== sourceFingerprint) throw new Error('invalid');
  } catch { throw ServiceError.validation('写前任务书无效，请重新生成。'); }
  const sourceIdentity = (brief: WriteBrief) => brief.sources.filter((source) => source.kind !== 'request').map(({ key, contentHash }) => ({ key, contentHash })).sort((a, b) => a.key.localeCompare(b.key));
  if (expected.mode !== 'novel' || expected.projectId !== current.projectId || expected.target.id !== current.target.id ||
      expected.target.revision !== current.target.revision || expected.target.unitNumber !== current.target.unitNumber || expected.target.title !== current.target.title ||
      hashWriteBriefValue(sourceIdentity(expected)) !== hashWriteBriefValue(sourceIdentity(current))) {
    throw ServiceError.conflict('写作所依据的正文、蓝图或项目资料已更新，请重新生成；迟到候选未写入。');
  }
  for (const dependency of guard.sceneDrafts ?? []) {
    const draft = snapshot.sceneDrafts.find((item) => item.sceneId === dependency.sceneId);
    if (hashWriteBriefValue(draft?.content ?? null) !== dependency.contentHash) throw ServiceError.conflict('场景正文已更新，请重新生成；迟到候选未写入。');
  }
}

export async function assertNovelWriteBriefCurrent(store: DataStore, brief: WriteBrief): Promise<void> {
  assertNovelWriteGuard(await captureNovelWriteSnapshot(store, brief.target.id), { brief });
}

export function rebaseNovelWriteBrief(brief: WriteBrief, revision: number): WriteBrief {
  const { schemaVersion: _version, fingerprint: _fingerprint, sourceFingerprint: _sources, ...input } = brief;
  return createWriteBrief({ ...input, target: { ...input.target, revision } });
}

export function sceneDraftDependency(sceneId: string, draft?: SceneDraft): { sceneId: string; contentHash: string } {
  return { sceneId, contentHash: hashWriteBriefValue(draft?.content ?? null) };
}

export function isNovelWriteConflict(error: unknown): boolean {
  return error instanceof Error && ('code' in error && error.code === 'CONFLICT' || error.name === 'ChapterRevisionConflictError');
}
