/**
 * Example/edge-case unit tests for {@link SceneExpander} (task 9.5).
 *
 * Covers the局部扩写 orchestration in isolation from the HTTP and provider
 * layers, using a REAL {@link FileDataStore} over a unique temp file plus a
 * FAKE {@link ModelProxy}:
 *
 * - `addWords` out of the 1–100000 range (0 / negative / non-integer / too
 *   large) throws `VALIDATION_ERROR` before any provider call (Req 11.2).
 * - `MODEL_NOT_CONFIGURED` is thrown before any provider call when no model
 *   config is saved (the fake proxy records zero calls) (Req 11.8).
 * - A scene id not present in the blueprint throws `NOT_FOUND` (Req 11.6).
 * - A target scene with no persisted draft throws `VALIDATION_ERROR`
 *   mentioning "尚未写作" (Req 11.7).
 * - Success path: `streamExpand` returns `{ scene, stream }`; consuming the
 *   stream yields the canned deltas, and `finalizeDraft` then writes ONLY the
 *   target scene's draft, leaving other scenes' drafts unchanged (Req 11.5).
 *
 * The fake {@link ModelProxy} records each call and yields canned deltas; it
 * never performs network I/O.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type { StreamDelta } from '../../proxy/sseParser.js';
import type {
  ChapterBlueprint,
  ChatMessage,
  ModelConfig,
  Scene,
} from '../../types/index.js';
import { FileDataStore } from '../../store/FileDataStore.js';
import { isServiceError } from '../ServiceError.js';
import { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import { SceneExpander } from './SceneExpander.js';

const VALID_CONFIG: ModelConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-secret-canary',
  modelName: 'gpt-4o-mini',
};

const DELTAS = ['扩写正文第一段。', '扩写正文第二段。', '收尾。'];

/**
 * Fake {@link ModelProxy} recording each call and yielding the supplied canned
 * deltas. Never performs any I/O.
 */
function makeFakeProxy(deltas: string[] = DELTAS) {
  const calls: { config: ModelConfig; messages: ChatMessage[] }[] = [];
  const proxy: ModelProxy = {
    streamCompletion(config, messages) {
      calls.push({ config, messages });
      return (async function* () {
        for (const d of deltas) yield { kind: 'content' as const, text: d };
      })();
    },
  };
  return { proxy, calls };
}

async function collect(iterable: AsyncIterable<StreamDelta>): Promise<string> {
  let full = '';
  for await (const d of iterable) { if (d.kind === 'content') full += d.text; }
  return full;
}

function makeScene(sceneId: string): Scene {
  return {
    scene_id: sceneId,
    name: `场景 ${sceneId}`,
    target_words: 1000,
    location: '地点',
    characters: [],
    purpose: '目的',
    emotion: '情绪',
    pacing: '节奏',
    must_include: [],
    ending_state: '结束状态',
  };
}

function makeBlueprint(chapterId: string): ChapterBlueprint {
  return {
    chapter_id: chapterId,
    title: '章节标题',
    target_words: 3000,
    main_goal: '主目标',
    tone: '基调',
    pacing: '节奏',
    required_plot_points: [],
    forbidden_points: [],
    emotional_curve: '情绪曲线',
    scenes: [makeScene('scene-0'), makeScene('scene-1'), makeScene('scene-2')],
    ending_hook: '钩子',
  };
}

describe('SceneExpander.streamExpand', () => {
  let dir: string;
  let store: FileDataStore;
  let chapterId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scene-expander-'));
    store = await FileDataStore.create(join(dir, 'store.json'));
    const project = await store.createProject('小说项目');
    const chapter = await store.createChapter(project.id, '第一章');
    chapterId = chapter.id;
    await store.saveChapterBlueprint(makeBlueprint(chapterId));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const signal = () => new AbortController().signal;

  it.each([0, -1, 1.5, 100001])(
    'throws VALIDATION_ERROR for out-of-range addWords %p before any provider call (Req 11.2)',
    async (addWords) => {
      await store.saveModelConfig(VALID_CONFIG);
      await store.saveSceneDraft({
        chapterId,
        sceneId: 'scene-0',
        content: '原始正文',
        updatedAt: new Date().toISOString(),
      });
      const { proxy, calls } = makeFakeProxy();
      const expander = new SceneExpander(
        store,
        new ModelConfigService(store),
        proxy,
      );

      await expect(
        expander.streamExpand(chapterId, 'scene-0', { addWords }, signal()),
      ).rejects.toSatisfy(
        (e: unknown) => isServiceError(e) && e.code === 'VALIDATION_ERROR',
      );
      expect(calls).toHaveLength(0);
    },
  );

  it('throws MODEL_NOT_CONFIGURED before any provider call when no config is saved (Req 11.8)', async () => {
    await store.saveSceneDraft({
      chapterId,
      sceneId: 'scene-0',
      content: '原始正文',
      updatedAt: new Date().toISOString(),
    });
    const { proxy, calls } = makeFakeProxy();
    const expander = new SceneExpander(
      store,
      new ModelConfigService(store),
      proxy,
    );

    await expect(
      expander.streamExpand(chapterId, 'scene-0', { addWords: 500 }, signal()),
    ).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'MODEL_NOT_CONFIGURED',
    );
    expect(calls).toHaveLength(0);
  });

  it('throws NOT_FOUND when the scene id is not in the blueprint (Req 11.6)', async () => {
    await store.saveModelConfig(VALID_CONFIG);
    const { proxy, calls } = makeFakeProxy();
    const expander = new SceneExpander(
      store,
      new ModelConfigService(store),
      proxy,
    );

    await expect(
      expander.streamExpand(chapterId, 'missing-scene', { addWords: 500 }, signal()),
    ).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'NOT_FOUND',
    );
    expect(calls).toHaveLength(0);
  });

  it('throws VALIDATION_ERROR ("尚未写作") when the target scene has no draft (Req 11.7)', async () => {
    await store.saveModelConfig(VALID_CONFIG);
    const { proxy, calls } = makeFakeProxy();
    const expander = new SceneExpander(
      store,
      new ModelConfigService(store),
      proxy,
    );

    await expect(
      expander.streamExpand(chapterId, 'scene-0', { addWords: 500 }, signal()),
    ).rejects.toSatisfy(
      (e: unknown) =>
        isServiceError(e) &&
        e.code === 'VALIDATION_ERROR' &&
        e.message.includes('尚未写作'),
    );
    expect(calls).toHaveLength(0);
  });

  it('streams deltas and finalizeDraft updates ONLY the target scene (Req 11.5)', async () => {
    await store.saveModelConfig(VALID_CONFIG);
    // Two scenes already written.
    await store.saveSceneDraft({
      chapterId,
      sceneId: 'scene-0',
      content: '场景0原始正文',
      updatedAt: new Date().toISOString(),
    });
    await store.saveSceneDraft({
      chapterId,
      sceneId: 'scene-1',
      content: '场景1原始正文',
      updatedAt: new Date().toISOString(),
    });

    const { proxy, calls } = makeFakeProxy();
    const expander = new SceneExpander(
      store,
      new ModelConfigService(store),
      proxy,
    );

    const { scene, stream } = await expander.streamExpand(
      chapterId,
      'scene-0',
      { addWords: 500 },
      signal(),
    );

    expect(scene.scene_id).toBe('scene-0');
    expect(calls).toHaveLength(1);
    expect(calls[0].config).toEqual(VALID_CONFIG);

    const fullText = await collect(stream);
    expect(fullText).toBe(DELTAS.join(''));

    // Persist only after the stream completes (Req 11.5).
    await expander.finalizeDraft(chapterId, 'scene-0', fullText);

    const updated = await store.getSceneDraft(chapterId, 'scene-0');
    expect(updated?.content).toBe(fullText);

    // Other scene's draft is untouched.
    const other = await store.getSceneDraft(chapterId, 'scene-1');
    expect(other?.content).toBe('场景1原始正文');

    // Only the two seeded scenes exist as drafts (no accidental extra writes).
    const all = await store.listSceneDrafts(chapterId);
    expect(all.map((d) => d.sceneId).sort()).toEqual(['scene-0', 'scene-1']);
  });
});
