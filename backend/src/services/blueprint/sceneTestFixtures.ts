import type { DataStore } from '../../store/DataStore.js';
import type { SceneDraft } from '../../types/index.js';
import { captureNovelWriteBrief } from '../../store/NovelWriteGuard.js';
import { hashWriteBriefValue } from '../writing/WriteBrief.js';

/** Seed a completed generated scene, including the provenance production now requires. */
export async function saveCurrentSceneDraft(store: DataStore, draft: SceneDraft): Promise<SceneDraft> {
  const brief = await captureNovelWriteBrief(store, draft.chapterId);
  return store.saveSceneDraft({ ...draft, writeBrief: brief, candidateHash: hashWriteBriefValue(draft.content), sceneDependencies: [] }, { brief });
}
