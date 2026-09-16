import type { DataStore } from '../../store/DataStore.js';
import type { SourceMemoryMode } from '../../types/SourceMemory.js';
import type { StoryControlCollection, StoryControlInput, StoryControlStorePort } from '../../types/StoryControl.js';
import type { StoryMemoryWorkspaceView } from '../../types/StoryMemoryWorkspace.js';
import { getCurrentClientId, runWithStoredClientId } from '../client/clientScope.js';
import { ServiceError } from '../ServiceError.js';
import { emptyStoryControls } from '../story/StoryControls.js';
import { searchAcceptedMemory } from '../retrieval/KeywordMemoryRetrieval.js';
import type { MemorySyncRunner } from './MemorySyncRunner.js';
import { buildStoryThreads } from './StoryThreads.js';

export interface StoryMemoryQuery { beforeUnit?: number; q?: string; topK?: number; maxContextChars?: number }
export interface StoryMemoryOptions {
  fixedClientId?: string;
  nextUnit(projectId: string, mode: SourceMemoryMode): Promise<number>;
  entityAliases?(projectId: string, mode: SourceMemoryMode): Promise<Record<string, readonly string[]>>;
}

/** Reads derived memory, but author decisions always commit in the manuscript store. */
export class StoryMemoryService {
  constructor(
    private readonly projects: Pick<DataStore, 'getProject'>,
    private readonly runner: Pick<MemorySyncRunner, 'queryContext'>,
    private readonly novel: Partial<StoryControlStorePort>,
    private readonly script: Partial<StoryControlStorePort>,
    private readonly options: StoryMemoryOptions,
  ) {}

  private inScope<T>(operation: () => Promise<T>): Promise<T> {
    return runWithStoredClientId(this.options.fixedClientId ?? getCurrentClientId(), operation);
  }

  private async current(projectId: string): Promise<{ mode: SourceMemoryMode; store: Partial<StoryControlStorePort> }> {
    const project = await this.projects.getProject(projectId);
    if (!project) throw ServiceError.notFound('项目不存在。');
    const mode = project.kind === 'short_drama' ? 'short_drama' : 'novel';
    return { mode, store: mode === 'novel' ? this.novel : this.script };
  }

  query(projectId: string, options: StoryMemoryQuery = {}): Promise<StoryMemoryWorkspaceView> {
    return this.inScope(async () => {
      const { mode, store } = await this.current(projectId);
      const beforeUnit = options.beforeUnit ?? await this.options.nextUnit(projectId, mode);
      if (!Number.isSafeInteger(beforeUnit) || beforeUnit < 1) throw ServiceError.validation('beforeUnit必须是正整数。');
      let snapshot: Awaited<ReturnType<MemorySyncRunner['queryContext']>> | undefined;
      let controls: StoryControlCollection | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const first = await this.runner.queryContext(projectId, beforeUnit);
        const firstControls = await store.getStoryControls?.(projectId) ?? emptyStoryControls();
        const check = await this.runner.queryContext(projectId, beforeUnit);
        const checkControls = await store.getStoryControls?.(projectId) ?? emptyStoryControls();
        if (first.projectionRevision === check.projectionRevision && first.projection?.contentHash === check.projection?.contentHash &&
            first.mode === check.mode && firstControls.revision === checkControls.revision) {
          snapshot = check; controls = checkControls; break;
        }
      }
      if (!snapshot || !controls) throw ServiceError.conflict('故事记忆正在更新，请重新读取后再操作。');
      const { projection, ...view } = snapshot;
      const entityAliases = options.q !== undefined ? await this.options.entityAliases?.(projectId, mode) : undefined;
      return { ...view, controls, acceptedSources: (projection?.acceptances ?? [])
        .filter((input) => input.source.unitNumber < beforeUnit)
        .map((input) => ({ source: structuredClone(input.source), title: input.title })),
      threads: buildStoryThreads(view, controls, beforeUnit, projection?.acceptances.map((input) => input.source)),
      ...(options.q !== undefined ? { retrieval: searchAcceptedMemory({ projection, view, query: options.q,
        clientId: getCurrentClientId(), projectId, mode, beforeUnit, topK: options.topK, maxContextChars: options.maxContextChars,
        controls, entityAliases }) } : {}),
      };
    });
  }

  upsert(projectId: string, input: StoryControlInput, expectedRevision: number): Promise<StoryControlCollection> {
    return this.inScope(async () => {
      const { store } = await this.current(projectId);
      if (!store.upsertStoryControl) throw ServiceError.validation('当前存储不支持作者记录。');
      return store.upsertStoryControl(projectId, input, expectedRevision);
    });
  }

  remove(projectId: string, id: string, expectedRevision: number): Promise<StoryControlCollection> {
    return this.inScope(async () => {
      const { store } = await this.current(projectId);
      if (!store.deleteStoryControl) throw ServiceError.validation('当前存储不支持作者记录。');
      return store.deleteStoryControl(projectId, id, expectedRevision);
    });
  }
}
