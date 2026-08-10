import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type { DataStore } from '../../store/DataStore.js';
import type { AgentProgressEvent, AgentRunRequest, AgentRunResult } from '../../types/index.js';
import type { BlueprintService } from '../blueprint/BlueprintService.js';
import type { ChapterWriter } from '../blueprint/ChapterWriter.js';
import type { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import type { MemoryService } from '../memory/MemoryService.js';
import type { ReferenceAnalysisService } from '../reference/ReferenceAnalysisService.js';
import type { LongNovelConfigStore } from './longNovel/LongNovelConfigStore.js';
import { AgentOrchestrator } from './AgentOrchestrator.js';

/** Facade: delegates to {@link AgentOrchestrator} (LangGraph-style multi sub-agent routing). */
export class AgentService {
  private readonly orchestrator: AgentOrchestrator;

  constructor(
    store: DataStore,
    modelConfigService: ModelConfigService,
    modelProxy: ModelProxy,
    blueprintService: BlueprintService,
    chapterWriter: ChapterWriter,
    memoryService: MemoryService,
    referenceService?: ReferenceAnalysisService,
    longNovelConfigStore?: LongNovelConfigStore,
  ) {
    this.orchestrator = new AgentOrchestrator(
      store,
      modelConfigService,
      modelProxy,
      blueprintService,
      chapterWriter,
      memoryService,
      referenceService,
      longNovelConfigStore,
    );
  }

  run(
    request: AgentRunRequest,
    signal: AbortSignal,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentRunResult> {
    return this.orchestrator.run(request, signal, onProgress);
  }
}