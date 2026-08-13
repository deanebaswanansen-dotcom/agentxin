/**
 * Backend entrypoint for the Novel Writing Agent (task 13.1 — 接线后端服务).
 *
 * Wires the persistence layer, domain services, model proxy and HTTP transport
 * into a single runnable Fastify application:
 *
 *   FileDataStore  ──►  ProjectService / ChapterService / SettingService /
 *                       ModelConfigService / WritingService  ──►  Routes
 *                                              │
 *                       OpenAiCompatibleModelProxy (writing flow)
 *
 * Design alignment (Requirements 7.1, 7.2, 7.3):
 * - 7.1 / 7.2: every CRUD/write and read flows through the injected
 *   {@link DataStore}, so writes are persisted before responding and reads
 *   return the latest persisted content. This is satisfied structurally by
 *   constructing the services from the real store and registering the routes.
 * - 7.3: {@link start} loads persisted data via {@link FileDataStore.create}
 *   before the server begins listening, restoring all prior project data on
 *   restart.
 *
 * Testability: {@link buildServer} takes an already-constructed
 * {@link DataStore} (and optionally a {@link ModelProxy}) rather than creating
 * them itself, so unit/integration tests can inject an in-memory or temp-file
 * store and a fake proxy via `app.inject` without touching the network.
 *
 * Notes:
 * - Fastify parses `application/json` request bodies by default, so no extra
 *   content-type parser is registered here.
 * - The SSE writing route hijacks the reply and writes directly to
 *   `reply.raw`; no special wiring is required for it here.
 * - No CORS handling is added: the frontend `apiClient` targets a relative
 *   `/api` base (same-origin / dev proxy — a frontend concern, task 13.2).
 */
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CORS_ALLOW_ORIGIN } from './cors.js';
import type { DataStore } from './store/DataStore.js';
import { FileDataStore } from './store/FileDataStore.js';
import { createClientScopedDataStore } from './store/ClientScopedDataStore.js';
import {
  createClientScopedLongNovelConfigStore,
  createClientScopedMemoryStore,
  createClientScopedPlanSessionStore,
  createClientScopedReferenceStore,
} from './store/ClientScopedAuxiliaryStores.js';
import { registerClientScope } from './services/client/clientScope.js';
import type { ModelProxy } from './proxy/ModelProxy.js';
import { OpenAiCompatibleModelProxy } from './proxy/ModelProxy.js';
import { CachingModelProxy } from './proxy/CachingModelProxy.js';
import { MemoryStore } from './services/memory/MemoryStore.js';
import { MemoryService } from './services/memory/MemoryService.js';
import { ProjectService } from './services/project/ProjectService.js';
import { ChapterService } from './services/chapter/ChapterService.js';
import { SettingService } from './services/setting/SettingService.js';
import { ModelConfigService } from './services/modelConfig/ModelConfigService.js';
import { WritingService } from './services/writing/WritingService.js';
import { AgentService } from './services/agent/AgentService.js';
import { BlueprintService } from './services/blueprint/BlueprintService.js';
import { SceneWriter } from './services/blueprint/SceneWriter.js';
import { ChapterMerger } from './services/blueprint/ChapterMerger.js';
import { ChapterWriter } from './services/blueprint/ChapterWriter.js';
import { WordCountChecker } from './services/blueprint/WordCountChecker.js';
import { PacingChecker } from './services/blueprint/PacingChecker.js';
import { SceneExpander } from './services/blueprint/SceneExpander.js';
import { SceneRewriter } from './services/blueprint/SceneRewriter.js';
import { NovelImportService } from './services/import/NovelImportService.js';
import { ReferenceStore, type ReferenceStorePort } from './services/reference/ReferenceStore.js';
import { ReferenceAnalysisService } from './services/reference/ReferenceAnalysisService.js';
import {
  LongNovelConfigStore,
  type LongNovelConfigStorePort,
} from './services/agent/longNovel/LongNovelConfigStore.js';
import { registerRequestModelConfig } from './services/modelConfig/requestModelConfig.js';
import { registerProjectRoutes } from './routes/projectRoutes.js';
import { registerChapterRoutes } from './routes/chapterRoutes.js';
import { registerSettingRoutes } from './routes/settingRoutes.js';
import { registerModelConfigRoutes } from './routes/modelConfigRoutes.js';
import { registerWritingRoutes } from './routes/writingRoutes.js';
import { registerBlueprintRoutes } from './routes/blueprintRoutes.js';
import { registerAgentRoutes } from './routes/agentRoutes.js';
import { registerAgentJobRoutes } from './routes/agentJobRoutes.js';
import { registerPlanRoutes } from './routes/planRoutes.js';
import { registerFreeChatRoutes } from './routes/freeChatRoutes.js';
import { registerImportRoutes } from './routes/importRoutes.js';
import { registerReferenceRoutes } from './routes/referenceRoutes.js';
import { FreeChatService } from './services/freeChat/FreeChatService.js';
import { NovelPlanService } from './services/agent/NovelPlanService.js';
import {
  PlanSessionStore,
  type PlanSessionStorePort,
} from './services/agent/plan/PlanSessionStore.js';
import { getCacheStatsSummary, resetCacheStats } from './proxy/cacheStats.js';
import { AgentRunStore } from './services/agent/jobs/AgentRunStore.js';
import { AgentJobRunner } from './services/agent/jobs/AgentJobRunner.js';

/**
 * Build a fully wired Fastify application from an already-constructed
 * {@link DataStore}.
 *
 * Instantiates every domain service on top of the injected store, wires the
 * {@link WritingService} to the given {@link ModelProxy} (defaulting to the
 * real {@link OpenAiCompatibleModelProxy} when none is supplied), and registers
 * all five route groups plus the `/health` probe. The store and proxy are
 * injected so callers (production {@link start} and tests alike) control the
 * concrete implementations.
 *
 * @param store - persistence layer all services read/write through (Req 7.1, 7.2).
 * @param modelProxy - optional model proxy for the writing flow; defaults to a
 *   real OpenAI-compatible proxy. Tests inject a fake to avoid network calls.
 * @returns the configured Fastify instance (not yet listening).
 */
export function buildServer(
  store: DataStore,
  modelProxy?: ModelProxy,
  memoryService?: MemoryService,
  referenceStore?: ReferenceStorePort,
  longNovelConfigStore?: LongNovelConfigStorePort,
  planSessionStore?: PlanSessionStorePort,
  agentRunStore?: AgentRunStore,
): FastifyInstance {
  const app = Fastify({ logger: false });

  // CORS for cross-origin deployments (persistent backend host). The frontend is
  // a static SPA (e.g. on Netlify) that sends the per-session model config via
  // the `x-agentxin-model-config` request header, so preflight must allow it.
  // Local dev is same-origin (Vite proxy), so these headers are harmless there.
  // Hijacked SSE routes merge corsResponseHeaders() into their own writeHead.
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', CORS_ALLOW_ORIGIN);
    reply.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Accept, x-agentxin-model-config, x-agentxin-client-id',
    );
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (request.headers.origin && CORS_ALLOW_ORIGIN !== '*') {
      reply.header('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      // Short-circuit the CORS preflight.
      reply.code(204).send();
      return reply;
    }
  });

  registerClientScope(app);

  // Domain services — all built from the single shared store (Req 7.1, 7.2).
  // Shared model proxy: default to the real OpenAI-compatible proxy wrapped in a
  // local disk response cache (improves cache rate / cost). When a proxy is
  // injected (tests), use it as-is so caching never interferes with assertions.
  const proxy = modelProxy ?? new CachingModelProxy(new OpenAiCompatibleModelProxy());
  // Agent long-term memory: default to an ephemeral (no-disk) store unless a
  // loaded service is injected. Production start() injects a persistent one;
  // tests get isolated in-memory state with no repo file pollution.
  const memory = memoryService ?? new MemoryService(MemoryStore.ephemeral());
  const refs = referenceStore ?? ReferenceStore.ephemeral();
  const longNovelConfigs = longNovelConfigStore ?? LongNovelConfigStore.ephemeral();
  const planSessions = planSessionStore ?? PlanSessionStore.ephemeral();
  const projectService = new ProjectService(store);
  const chapterService = new ChapterService(store);
  const settingService = new SettingService(store);
  const modelConfigService = new ModelConfigService(store, { allowStoredConfig: false });
  const writingService = new WritingService(store, modelConfigService, proxy);
  const freeChatService = new FreeChatService(store, modelConfigService, proxy);
  const referenceService = new ReferenceAnalysisService(
    refs,
    store,
    modelConfigService,
    proxy,
    memory,
  );

  // Blueprint domain services — chapter blueprint generation, per-scene writing,
  // merging, checks, expansion and rewriting (task 13.1; Req 15.1, 15.2).
  const blueprintService = new BlueprintService(store, modelConfigService, proxy);
  const sceneWriter = new SceneWriter(store, modelConfigService, proxy);
  const chapterMerger = new ChapterMerger(store);
  const chapterWriter = new ChapterWriter(
    store,
    modelConfigService,
    sceneWriter,
    chapterMerger,
  );
  const agentService = new AgentService(
    store,
    modelConfigService,
    proxy,
    blueprintService,
    chapterWriter,
    memory,
    referenceService,
    longNovelConfigs,
  );
  const novelPlanService = new NovelPlanService(modelConfigService, proxy);
  const wordCountChecker = new WordCountChecker(store);
  const pacingChecker = new PacingChecker(store, modelConfigService, proxy);
  const sceneExpander = new SceneExpander(store, modelConfigService, proxy);
  const sceneRewriter = new SceneRewriter(store, modelConfigService, proxy);
  const importService = new NovelImportService(store);

  // Liveness probe (unchanged from the scaffold).
  app.get('/health', async () => {
    return { status: 'ok' };
  });

  registerRequestModelConfig(app);

  app.get('/api/cache-stats', async () => getCacheStatsSummary());
  app.post('/api/cache-stats/reset', async () => {
    resetCacheStats();
    return { ok: true };
  });

  // Transport layer — register every route group against its service.
  registerProjectRoutes(app, projectService);
  registerChapterRoutes(app, chapterService);
  registerSettingRoutes(app, settingService);
  registerModelConfigRoutes(app, modelConfigService, proxy);
  registerWritingRoutes(app, writingService);
  registerAgentRoutes(app, agentService);
  if (agentRunStore) {
    registerAgentJobRoutes(app, agentRunStore, new AgentJobRunner(agentRunStore, agentService));
  }
  registerPlanRoutes(app, novelPlanService, planSessions);
  registerFreeChatRoutes(app, freeChatService);
  registerImportRoutes(app, importService);
  registerReferenceRoutes(app, referenceService);
  registerBlueprintRoutes(app, {
    blueprintService,
    sceneWriter,
    chapterWriter,
    chapterMerger,
    wordCountChecker,
    pacingChecker,
    sceneExpander,
    sceneRewriter,
    store,
  });

  return app;
}

/**
 * Production startup: load persisted data, build the server and listen.
 *
 * Loads the JSON data file via {@link FileDataStore.create} BEFORE listening so
 * all previously persisted projects/chapters/settings/model-config are restored
 * on restart (Requirement 7.3). The data file location may be overridden with
 * the `DATA_FILE` env var; otherwise the store's default
 * (`data/store.json`) is used. The HTTP port defaults to 3000 (`PORT` env var).
 *
 * @returns the listening Fastify instance (useful for programmatic shutdown).
 */
export async function start(): Promise<FastifyInstance> {
  // Startup recovery: load persisted data before serving requests (Req 7.3).
  const clientRoot = process.env.CLIENT_DATA_DIR;
  const store = clientRoot
    ? createClientScopedDataStore(join(clientRoot, 'projects'))
    : await FileDataStore.create(process.env.DATA_FILE ?? undefined);
  const memoryStore = clientRoot
    ? await createClientScopedMemoryStore(join(clientRoot, 'memory'))
    : await MemoryStore.create(process.env.AGENT_MEMORY_FILE ?? undefined);
  const memory = new MemoryService(memoryStore);
  const referenceStore = clientRoot
    ? await createClientScopedReferenceStore(join(clientRoot, 'references'))
    : await ReferenceStore.create(process.env.REFERENCE_FILE ?? undefined);
  const longNovelConfigStore = clientRoot
    ? await createClientScopedLongNovelConfigStore(join(clientRoot, 'long-novel'))
    : await LongNovelConfigStore.create(process.env.LONG_NOVEL_CONFIG_FILE ?? undefined);
  const planSessionStore = clientRoot
    ? await createClientScopedPlanSessionStore(join(clientRoot, 'plan-sessions'))
    : await PlanSessionStore.create(process.env.PLAN_SESSION_FILE ?? undefined);
  const agentRunStore = await AgentRunStore.create(
    process.env.AGENT_RUN_FILE ?? join(clientRoot ?? 'data', 'agent-runs.json'),
  );
  const app = buildServer(
    store,
    undefined,
    memory,
    referenceStore,
    longNovelConfigStore,
    planSessionStore,
    agentRunStore,
  );

  const port = Number(process.env.PORT ?? 3000);
  const address = await app.listen({ port, host: '0.0.0.0' });
  // eslint-disable-next-line no-console
  console.log(`Backend listening at ${address}`);
  return app;
}

// Only start the server when this module is run directly.
// Use pathToFileURL so the comparison is correct on Windows (drive-letter
// paths) and POSIX alike — a hand-built `file://` string does not match
// `import.meta.url` on Windows (which uses `file:///C:/...`).
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start backend:', err);
    process.exit(1);
  });
}
