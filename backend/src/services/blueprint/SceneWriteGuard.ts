import type { DataStore } from '../../store/DataStore.js';
import { assertNovelWriteGuard, buildNovelWriteBrief, captureNovelWriteSnapshot, rebaseNovelWriteBrief, sceneDraftDependency, type NovelWriteGuard, type NovelWriteSnapshot } from '../../store/NovelWriteGuard.js';
import type { SceneDraft } from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';
import { hashWriteBriefValue } from '../writing/WriteBrief.js';
import { assertNovelBlueprintCurrent as assertCurrentBlueprint } from '../../store/NovelWriteGuard.js';
export { assertNovelBlueprintCurrent as assertCurrentBlueprint } from '../../store/NovelWriteGuard.js';

export async function captureSceneWriteGuard(store: DataStore, chapterId: string, sceneId: string): Promise<NovelWriteGuard> {
  const snapshot = await captureNovelWriteSnapshot(store, chapterId);
  assertCurrentBlueprint(snapshot);
  const sceneIndex = snapshot.blueprint?.scenes.findIndex((scene) => scene.scene_id === sceneId) ?? -1;
  if (sceneIndex < 0) throw ServiceError.notFound(`场景不存在：${sceneId}`);
  const previousId = snapshot.blueprint?.scenes[sceneIndex - 1]?.scene_id;
  const previousDraft = snapshot.sceneDrafts.find((draft) => draft.sceneId === previousId);
  if (previousDraft) assertReusableSceneDraft(snapshot, previousDraft);
  const sceneIds = [sceneId, ...(previousId ? [previousId] : [])];
  return { brief: buildNovelWriteBrief(snapshot), sceneDrafts: sceneIds.map((id) => sceneDraftDependency(id, snapshot.sceneDrafts.find((draft) => draft.sceneId === id))) };
}

export function assertReusableSceneDraft(snapshot: NovelWriteSnapshot, draft: SceneDraft, ancestors = new Set<string>()): void {
  if (!draft.writeBrief || !draft.sceneDependencies || draft.candidateHash !== hashWriteBriefValue(draft.content) || ancestors.has(draft.sceneId)) throw ServiceError.conflict('场景草稿缺少有效来源，请重新生成场景。');
  let brief = draft.writeBrief;
  const chapter = snapshot.chapter;
  if (chapter && chapter.generatedCandidate?.candidateHash === hashWriteBriefValue(chapter.content) &&
      chapter.generatedCandidate.brief.sourceFingerprint === brief.sourceFingerprint &&
      chapter.generatedCandidate.brief.target.revision === brief.target.revision &&
      (chapter.revision ?? 0) === brief.target.revision + 1) {
    brief = rebaseNovelWriteBrief(brief, chapter.revision ?? 0);
  }
  assertNovelWriteGuard(snapshot, { brief });
  for (const dependency of draft.sceneDependencies) {
    const preceding = snapshot.sceneDrafts.find((item) => item.sceneId === dependency.sceneId);
    if (hashWriteBriefValue(preceding?.content ?? null) !== dependency.contentHash) throw ServiceError.conflict('前序场景已修改，后续草稿需要重新生成。');
    if (preceding) assertReusableSceneDraft(snapshot, preceding, new Set([...ancestors, draft.sceneId]));
  }
}

export async function persistSceneCandidate(store: DataStore, chapterId: string, sceneId: string, content: string, guard?: NovelWriteGuard): Promise<void> {
  if (!guard || guard.brief.target.id !== chapterId || !guard.sceneDrafts?.some((item) => item.sceneId === sceneId)) throw ServiceError.conflict('场景生成缺少原始写前依据，请重新生成。');
  if (!content.trim()) throw ServiceError.validation('场景正文为空，未写入草稿。');
  await store.saveSceneDraft({ chapterId, sceneId, content, updatedAt: new Date().toISOString(), writeBrief: guard.brief, candidateHash: hashWriteBriefValue(content), sceneDependencies: guard.sceneDrafts.filter((item) => item.sceneId !== sceneId) }, guard);
}

export async function assertSceneWriteGuardCurrent(store: DataStore, guard: NovelWriteGuard): Promise<void> {
  assertNovelWriteGuard(await captureNovelWriteSnapshot(store, guard.brief.target.id), guard);
}
