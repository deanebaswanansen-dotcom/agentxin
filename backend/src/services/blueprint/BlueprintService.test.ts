/**
 * Unit tests for {@link BlueprintService} (task 7.2).
 *
 * These tests exercise the blueprint-generation orchestration in isolation from
 * the HTTP and real-provider layers. They wire the REAL persistence engine
 * ({@link FileDataStore} over a temp file) together with the real
 * {@link ModelConfigService}, and drive generation through a FAKE
 * {@link ModelProxy} (no network) that:
 *
 * - implements the {@link ModelProxy} interface (`streamCompletion` returns an
 *   `AsyncIterable<string>`),
 * - yields a preset blueprint JSON text split into several chunks to simulate
 *   streaming,
 * - supports an "error" mode where the stream throws a {@link ProxyError},
 * - records every call so tests can assert the provider is (or is NOT) reached.
 *
 * Coverage (Requirements 2.5, 2.6, 5.4, 5.6, 15.3):
 * 1. Success path — valid blueprint JSON is parsed/validated/persisted and the
 *    returned `chapter_id` equals the requested chapterId (Req 5.1, 5.3).
 * 2. Model not configured — `MODEL_NOT_CONFIGURED` is thrown and the provider
 *    is never called (Req 2.5).
 * 3. Chapter not found — `NOT_FOUND` (Req 5.4).
 * 4. Request-body validation — out-of-range targetWords / empty requirement →
 *    `VALIDATION_ERROR` (Req 1.3, 1.4).
 * 5. Bad model output — unparseable text or a structurally invalid blueprint →
 *    `VALIDATION_ERROR` (Req 3.x / 4.x).
 * 6. Provider error — a `ProxyError` from the stream propagates upward (the
 *    route layer maps it to `PROVIDER_ERROR`, Req 2.6).
 * 7. `getByChapter` — `NOT_FOUND` when absent, returns the blueprint otherwise
 *    (Req 5.6).
 * 8. Security — the serialized returned blueprint never contains the raw API
 *    key (Req 15.3).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelProxy } from '../../proxy/ModelProxy.js';
import { ProxyError, isProxyError } from '../../proxy/ProxyError.js';
import { FileDataStore } from '../../store/FileDataStore.js';
import type {
  BlueprintCore,
  ChatMessage,
  GenerateBlueprintBody,
  Id,
  ModelConfig,
  Scene,
} from '../../types/index.js';
import { isServiceError } from '../ServiceError.js';
import { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import { serializeBlueprint } from './blueprintParser.js';
import { BlueprintService } from './BlueprintService.js';

/** A valid model config whose API key is a unique, easy-to-detect canary. */
const VALID_CONFIG: ModelConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-blueprint-canary-DO-NOT-LEAK-7c2e',
  modelName: 'gpt-4o-mini',
};

const VALID_BODY: GenerateBlueprintBody = {
  targetWords: 3000,
  requirement: '本章需要主角离开村庄，初遇神秘剑客，并在结尾收到一封信。',
};

// ---------------------------------------------------------------------------
// Fake ModelProxy: records calls; yields preset chunks; optional error mode.
// ---------------------------------------------------------------------------

interface FakeProxyOptions {
  /** Text chunks yielded in order to simulate streaming. */
  chunks?: string[];
  /** When set, the stream throws this error (after yielding `chunks`). */
  error?: ProxyError;
}

/**
 * Build a fake {@link ModelProxy} plus a `calls` recorder. `streamCompletion`
 * pushes `{config, messages}` on every invocation, then returns an async
 * generator that yields the preset chunks and optionally throws.
 */
function makeFakeProxy(options: FakeProxyOptions = {}) {
  const calls: { config: ModelConfig; messages: ChatMessage[] }[] = [];
  const { chunks = [], error } = options;
  const proxy: ModelProxy = {
    streamCompletion(config, messages) {
      calls.push({ config, messages });
      return (async function* () {
        for (const chunk of chunks) {
          yield { kind: 'content' as const, text: chunk };
        }
        if (error) {
          throw error;
        }
      })();
    },
  };
  return { proxy, calls };
}

/** Split a string into `parts` roughly equal slices (safe for BMP chars). */
function chunkString(text: string, parts = 3): string[] {
  if (parts <= 1 || text.length <= parts) return [text];
  const size = Math.ceil(text.length / parts);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Blueprint fixtures.
// ---------------------------------------------------------------------------

function makeScene(sceneId: string, targetWords: number): Scene {
  return {
    scene_id: sceneId,
    name: `场景 ${sceneId}`,
    target_words: targetWords,
    location: '青石村口',
    characters: ['林夜'],
    purpose: '推动主角离开村庄',
    emotion: '不舍与决心',
    pacing: '中速',
    must_include: ['告别母亲', '看一眼老屋'],
    ending_state: '主角踏上山道',
  };
}

/**
 * Build a structurally valid blueprint core: 3 scenes summing exactly to the
 * chapter target (deviation 0, well within the ≤0.1 limit). The `chapter_id`
 * carried here is arbitrary — the service overwrites it with the request's
 * chapterId.
 */
function makeValidBlueprintCore(targetWords = VALID_BODY.targetWords): BlueprintCore {
  const per = Math.round(targetWords / 3);
  return {
    chapter_id: 'model-supplied-chapter-id',
    title: '风起青石村',
    target_words: targetWords,
    main_goal: '主角离开村庄踏上旅途',
    tone: '苍凉而坚定',
    pacing: '由缓入急',
    required_plot_points: ['告别家人', '初遇剑客', '收到神秘信件'],
    forbidden_points: ['提前暴露幕后反派'],
    emotional_curve: '平静 → 不舍 → 决心',
    scenes: [
      makeScene('scene-1', per),
      makeScene('scene-2', per),
      makeScene('scene-3', targetWords - 2 * per),
    ],
    ending_hook: '一封没有署名的信悄然出现在行囊里',
  };
}

/** Wrap a blueprint core's JSON with extra prose to exercise extraction. */
function blueprintAsModelOutput(core: BlueprintCore): string {
  return `好的，这是我为本章设计的蓝图：\n\n${serializeBlueprint(core)}\n\n以上即为完整蓝图。`;
}

// ---------------------------------------------------------------------------
// Temp store setup.
// ---------------------------------------------------------------------------

interface Seeded {
  store: FileDataStore;
  modelConfigService: ModelConfigService;
  projectId: Id;
  chapterId: Id;
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blueprint-svc-'));
  file = join(dir, 'store.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Seed a real {@link FileDataStore} with a project + chapter, and (when
 * `withConfig`) persist the model config through the real service.
 */
async function seed(withConfig = true): Promise<Seeded> {
  const store = await FileDataStore.create(file);
  const modelConfigService = new ModelConfigService(store);

  const project = await store.createProject('蓝图测试项目');
  const chapter = await store.createChapter(project.id, '第一章');

  if (withConfig) {
    await modelConfigService.save(VALID_CONFIG);
  }

  return {
    store,
    modelConfigService,
    projectId: project.id,
    chapterId: chapter.id,
  };
}

const signal = () => new AbortController().signal;

// ---------------------------------------------------------------------------
// 1) Success path (Req 5.1, 5.3, 2.1, 2.2).
// ---------------------------------------------------------------------------

describe('BlueprintService.generate — success path', () => {
  it('normalizes rounded scene targets to the confirmed short-chapter target without retrying', async () => {
    const seeded = await seed();
    const rounded = {
      ...makeValidBlueprintCore(900),
      scenes: [
        makeScene('scene-1', 250),
        makeScene('scene-2', 250),
        makeScene('scene-3', 250),
      ],
    };
    const { proxy, calls } = makeFakeProxy({ chunks: [blueprintAsModelOutput(rounded)] });
    const service = new BlueprintService(seeded.store, seeded.modelConfigService, proxy);

    const result = await service.generate(
      seeded.chapterId,
      { ...VALID_BODY, targetWords: 900 },
      signal(),
    );

    expect(calls).toHaveLength(1);
    expect(result.target_words).toBe(900);
    expect(result.scenes.reduce((sum, scene) => sum + scene.target_words, 0)).toBe(900);
  });

  it('parses, validates and persists a valid blueprint; returned chapter_id equals the requested chapterId', async () => {
    const seeded = await seed();
    const core = makeValidBlueprintCore();
    const { proxy, calls } = makeFakeProxy({
      chunks: chunkString(blueprintAsModelOutput(core), 4),
    });
    const service = new BlueprintService(
      seeded.store,
      seeded.modelConfigService,
      proxy,
    );

    const result = await service.generate(seeded.chapterId, VALID_BODY, signal());

    // Provider was reached exactly once with the full (raw-key) config.
    expect(calls).toHaveLength(1);
    expect(calls[0].config).toEqual(VALID_CONFIG);
    // The requirement text is injected into the prompt (Req 2.2).
    const joined = calls[0].messages.map((m) => m.content).join('\n');
    expect(joined).toContain(VALID_BODY.requirement);

    // Returned blueprint is bound to the requested chapter and fully formed.
    expect(result.chapter_id).toBe(seeded.chapterId);
    expect(result.scenes).toHaveLength(3);
    expect(result.title).toBe(core.title);
    expect(result.required_plot_points).toEqual(core.required_plot_points);

    // It was persisted and can be read back (Req 5.1, 5.2).
    const persisted = await seeded.store.getChapterBlueprintByChapter(
      seeded.chapterId,
    );
    expect(persisted).toBeDefined();
    expect(persisted!.chapter_id).toBe(seeded.chapterId);
    expect(persisted!.scenes).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 2) Model not configured (Req 2.5).
// ---------------------------------------------------------------------------

describe('BlueprintService.generate — model not configured (Req 2.5)', () => {
  it('throws MODEL_NOT_CONFIGURED and never calls the provider', async () => {
    const seeded = await seed(false); // no model config saved
    const core = makeValidBlueprintCore();
    const { proxy, calls } = makeFakeProxy({
      chunks: chunkString(blueprintAsModelOutput(core), 4),
    });
    const service = new BlueprintService(
      seeded.store,
      seeded.modelConfigService,
      proxy,
    );

    await expect(
      service.generate(seeded.chapterId, VALID_BODY, signal()),
    ).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'MODEL_NOT_CONFIGURED',
    );

    // The provider must NOT be reached when the model is unconfigured.
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3) Chapter not found (Req 5.4).
// ---------------------------------------------------------------------------

describe('BlueprintService.generate — chapter not found (Req 5.4)', () => {
  it('throws NOT_FOUND for an unknown chapterId', async () => {
    const seeded = await seed();
    const { proxy } = makeFakeProxy({
      chunks: chunkString(blueprintAsModelOutput(makeValidBlueprintCore()), 4),
    });
    const service = new BlueprintService(
      seeded.store,
      seeded.modelConfigService,
      proxy,
    );

    await expect(
      service.generate('non-existent-chapter', VALID_BODY, signal()),
    ).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'NOT_FOUND',
    );
  });
});

// ---------------------------------------------------------------------------
// 4) Request-body validation (Req 1.3, 1.4).
// ---------------------------------------------------------------------------

describe('BlueprintService.generate — request-body validation', () => {
  it.each([50, 200000])(
    'rejects out-of-range targetWords=%i with VALIDATION_ERROR (Req 1.3)',
    async (targetWords) => {
      const seeded = await seed();
      const { proxy, calls } = makeFakeProxy({
        chunks: chunkString(blueprintAsModelOutput(makeValidBlueprintCore()), 4),
      });
      const service = new BlueprintService(
        seeded.store,
        seeded.modelConfigService,
        proxy,
      );

      await expect(
        service.generate(
          seeded.chapterId,
          { ...VALID_BODY, targetWords },
          signal(),
        ),
      ).rejects.toSatisfy(
        (e: unknown) => isServiceError(e) && e.code === 'VALIDATION_ERROR',
      );
      // Body validation precedes any provider call.
      expect(calls).toHaveLength(0);
    },
  );

  it('rejects an empty requirement with VALIDATION_ERROR (Req 1.4)', async () => {
    const seeded = await seed();
    const { proxy, calls } = makeFakeProxy({
      chunks: chunkString(blueprintAsModelOutput(makeValidBlueprintCore()), 4),
    });
    const service = new BlueprintService(
      seeded.store,
      seeded.modelConfigService,
      proxy,
    );

    await expect(
      service.generate(seeded.chapterId, { ...VALID_BODY, requirement: '' }, signal()),
    ).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'VALIDATION_ERROR',
    );
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5) Bad model output (Req 3.x / 4.x → VALIDATION_ERROR).
// ---------------------------------------------------------------------------

describe('BlueprintService.generate — invalid model output', () => {
  it('retries one truncated JSON response with a concise schema-only request', async () => {
    const seeded = await seed();
    const responses = ['{"chapter_id":"truncated"', blueprintAsModelOutput(makeValidBlueprintCore())];
    const calls: ChatMessage[][] = [];
    const proxy: ModelProxy = {
      streamCompletion(_config, messages) {
        calls.push(messages);
        const response = responses.shift() ?? '';
        return (async function* () {
          yield { kind: 'content' as const, text: response };
        })();
      },
    };
    const service = new BlueprintService(seeded.store, seeded.modelConfigService, proxy);

    const result = await service.generate(seeded.chapterId, VALID_BODY, signal());

    expect(calls).toHaveLength(2);
    expect(calls[1]?.at(-1)?.content).toContain('更精简的完整 JSON');
    expect(result.scenes).toHaveLength(3);
  });

  it('throws VALIDATION_ERROR when the model output has no parseable JSON (Req 3.4)', async () => {
    const seeded = await seed();
    const { proxy } = makeFakeProxy({
      chunks: ['抱歉，', '我无法', '生成蓝图。'], // no JSON object at all
    });
    const service = new BlueprintService(
      seeded.store,
      seeded.modelConfigService,
      proxy,
    );

    await expect(
      service.generate(seeded.chapterId, VALID_BODY, signal()),
    ).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'VALIDATION_ERROR',
    );

    // Nothing was persisted on failure.
    expect(
      await seeded.store.getChapterBlueprintByChapter(seeded.chapterId),
    ).toBeUndefined();
  });

  it('throws VALIDATION_ERROR when the blueprint has fewer than 3 scenes (Req 4.2)', async () => {
    const seeded = await seed();
    const twoSceneCore: BlueprintCore = {
      ...makeValidBlueprintCore(2000),
      scenes: [makeScene('scene-1', 1000), makeScene('scene-2', 1000)],
    };
    const { proxy } = makeFakeProxy({
      chunks: chunkString(blueprintAsModelOutput(twoSceneCore), 4),
    });
    const service = new BlueprintService(
      seeded.store,
      seeded.modelConfigService,
      proxy,
    );

    await expect(
      service.generate(seeded.chapterId, { ...VALID_BODY, targetWords: 2000 }, signal()),
    ).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'VALIDATION_ERROR',
    );
    expect(
      await seeded.store.getChapterBlueprintByChapter(seeded.chapterId),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6) Provider error propagation (Req 2.6).
// ---------------------------------------------------------------------------

describe('BlueprintService.generate — provider error (Req 2.6)', () => {
  it('propagates a ProxyError thrown by the stream (mapped to PROVIDER_ERROR by routes)', async () => {
    const seeded = await seed();
    const error = new ProxyError('模型提供商返回错误状态 502', { status: 502 });
    const { proxy } = makeFakeProxy({ error });
    const service = new BlueprintService(
      seeded.store,
      seeded.modelConfigService,
      proxy,
    );

    await expect(
      service.generate(seeded.chapterId, VALID_BODY, signal()),
    ).rejects.toSatisfy((e: unknown) => isProxyError(e) && e.status === 502);

    expect(
      await seeded.store.getChapterBlueprintByChapter(seeded.chapterId),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7) getByChapter (Req 5.6).
// ---------------------------------------------------------------------------

describe('BlueprintService.getByChapter', () => {
  it('throws NOT_FOUND when the chapter has no persisted blueprint (Req 5.6)', async () => {
    const seeded = await seed();
    const { proxy } = makeFakeProxy();
    const service = new BlueprintService(
      seeded.store,
      seeded.modelConfigService,
      proxy,
    );

    await expect(service.getByChapter(seeded.chapterId)).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'NOT_FOUND',
    );
  });

  it('returns the persisted blueprint when present', async () => {
    const seeded = await seed();
    const core = makeValidBlueprintCore();
    const { proxy } = makeFakeProxy({
      chunks: chunkString(blueprintAsModelOutput(core), 4),
    });
    const service = new BlueprintService(
      seeded.store,
      seeded.modelConfigService,
      proxy,
    );

    await service.generate(seeded.chapterId, VALID_BODY, signal());

    const got = await service.getByChapter(seeded.chapterId);
    expect(got.chapter_id).toBe(seeded.chapterId);
    expect(got.scenes).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 8) Security — no raw API key in the returned blueprint (Req 15.3).
// ---------------------------------------------------------------------------

describe('BlueprintService — security (Req 15.3)', () => {
  it('the serialized returned blueprint never contains the raw API key', async () => {
    const seeded = await seed();
    const core = makeValidBlueprintCore();
    const { proxy } = makeFakeProxy({
      chunks: chunkString(blueprintAsModelOutput(core), 4),
    });
    const service = new BlueprintService(
      seeded.store,
      seeded.modelConfigService,
      proxy,
    );

    const result = await service.generate(seeded.chapterId, VALID_BODY, signal());

    expect(JSON.stringify(result)).not.toContain(VALID_CONFIG.apiKey);

    // The persisted record likewise carries no key.
    const persisted = await seeded.store.getChapterBlueprintByChapter(
      seeded.chapterId,
    );
    expect(JSON.stringify(persisted)).not.toContain(VALID_CONFIG.apiKey);
  });
});
