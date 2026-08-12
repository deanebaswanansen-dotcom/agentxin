/**
 * Integration tests for分场景写作与整章生成 (task 8.5).
 *
 * Exercises {@link SceneWriter} and {@link ChapterWriter} (the latter wired with
 * a REAL {@link ChapterMerger}) end-to-end over a REAL {@link FileDataStore}
 * backed by a unique temp file, with a FAKE {@link ModelProxy} that yields
 * canned deltas and can be configured to throw a {@link ProxyError} mid-stream
 * on the k-th provider call. No network I/O is performed.
 *
 * Coverage:
 * - 单场景写作 + 持久化 (Req 6.5): consume `SceneWriter.streamScene`'s stream,
 *   then `finalizeDraft`; the target scene's draft holds the full body.
 * - 中途失败不持久化 (Req 6.8): the stream throws mid-way; the route-style
 *   consumer catches the error and does NOT call `finalizeDraft`, so the store
 *   still has no draft for that scene.
 * - 整章按 scene_id 升序逐场景持久化 + 合并 (Req 7.1/7.2): consume
 *   `ChapterWriter.streamChapter`; every scene's draft is persisted, `scene`
 *   events appear in ascending `scene_id` order, and `Chapter.content` ends up
 *   merged from all scene drafts.
 * - 整章中途失败保留已写场景 (Req 7.4): the k-th scene throws; `streamChapter`
 *   propagates the error, scenes before k stay persisted, scene k and later are
 *   not written, and `Chapter.content` is never merged/overwritten.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type { StreamDelta } from '../../proxy/sseParser.js';
import { ProxyError, isProxyError } from '../../proxy/ProxyError.js';
import type {
  ChapterBlueprint,
  ChatMessage,
  ModelConfig,
  Scene,
} from '../../types/index.js';
import { FileDataStore } from '../../store/FileDataStore.js';
import { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import { ChapterMerger } from './ChapterMerger.js';
import { ChapterWriter, type ChapterWriteEvent } from './ChapterWriter.js';
import { SceneWriter } from './SceneWriter.js';
import { compareSceneId } from './mergeScenes.js';

const VALID_CONFIG: ModelConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-secret-canary',
  modelName: 'gpt-4o-mini',
};

/** Scene ids seeded into every blueprint, in storage (non-sorted) declaration order. */
const SCENE_IDS = ['scene-1', 'scene-2', 'scene-3', 'scene-4', 'scene-5'];

interface FakeProxyOptions {
  /** 1-based provider-call index at which to throw mid-stream; omit to never fail. */
  failOnCall?: number;
  /** Number of deltas to emit before throwing on the failing call. */
  deltasBeforeFail?: number;
  /** Deltas to emit for the (1-based) provider call. */
  deltasForCall?: (callIndex: number) => string[];
}

/**
 * Fake {@link ModelProxy} recording each call and yielding canned deltas. When
 * `failOnCall` matches the current 1-based call index it emits
 * `deltasBeforeFail` deltas and then throws a {@link ProxyError} (simulating a
 * provider error / timeout mid-stream). Never performs any I/O.
 */
function makeFakeProxy(options: FakeProxyOptions = {}) {
  const {
    failOnCall,
    deltasBeforeFail = 1,
    deltasForCall = (i: number) => [
      `场景${i}正文A`,
      `场景${i}正文B`,
      `场景${i}正文C`,
    ],
  } = options;

  let callCount = 0;
  const calls: { config: ModelConfig; messages: ChatMessage[]; index: number }[] =
    [];

  const proxy: ModelProxy = {
    streamCompletion(config, messages) {
      callCount += 1;
      const index = callCount;
      calls.push({ config, messages, index });
      const deltas = deltasForCall(index);
      const fail = failOnCall === index;
      return (async function* () {
        const emit = fail ? Math.min(deltasBeforeFail, deltas.length) : deltas.length;
        for (let n = 0; n < emit; n += 1) {
          yield { kind: 'content' as const, text: deltas[n] };
        }
        if (fail) {
          throw new ProxyError('模型提供商返回错误状态 500', { status: 500 });
        }
      })();
    },
  };

  return { proxy, calls, deltasForCall };
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
    target_words: 600,
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
    scenes: SCENE_IDS.map(makeScene),
    ending_hook: '钩子',
  };
}

describe('SceneWriter / ChapterWriter integration', () => {
  let dir: string;
  let store: FileDataStore;
  let chapterId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chapter-writer-'));
    store = await FileDataStore.create(join(dir, 'store.json'));
    const project = await store.createProject('小说项目');
    const chapter = await store.createChapter(project.id, '第一章');
    chapterId = chapter.id;
    await store.saveChapterBlueprint(makeBlueprint(chapterId));
    await store.saveModelConfig(VALID_CONFIG);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const signal = () => new AbortController().signal;

  it('persists the full scene body after a single scene stream completes (Req 6.5)', async () => {
    const { proxy, calls, deltasForCall } = makeFakeProxy();
    const sceneWriter = new SceneWriter(
      store,
      new ModelConfigService(store),
      proxy,
    );

    const { scene, stream } = await sceneWriter.streamScene(
      chapterId,
      'scene-1',
      signal(),
    );
    expect(scene.scene_id).toBe('scene-1');

    // No draft is written while the stream is in flight (Req 6.5/6.8).
    expect(await store.getSceneDraft(chapterId, 'scene-1')).toBeUndefined();

    const fullText = await collect(stream);
    expect(fullText).toBe(deltasForCall(1).join(''));
    expect(calls).toHaveLength(1);
    expect(calls[0].config).toEqual(VALID_CONFIG);

    // The caller persists only after the stream completes normally (Req 6.5).
    await sceneWriter.finalizeDraft(chapterId, 'scene-1', fullText);

    const draft = await store.getSceneDraft(chapterId, 'scene-1');
    expect(draft?.content).toBe(fullText);
    // No other scene was written.
    const all = await store.listSceneDrafts(chapterId);
    expect(all.map((d) => d.sceneId)).toEqual(['scene-1']);
  });

  it('does not persist a draft when the scene stream fails mid-way (Req 6.8)', async () => {
    // Fail on the only provider call after emitting two deltas.
    const { proxy } = makeFakeProxy({ failOnCall: 1, deltasBeforeFail: 2 });
    const sceneWriter = new SceneWriter(
      store,
      new ModelConfigService(store),
      proxy,
    );

    const { stream } = await sceneWriter.streamScene(
      chapterId,
      'scene-1',
      signal(),
    );

    // Route-style consumer: accumulate deltas, but on error skip finalizeDraft.
    let caught: unknown;
    let fullText = '';
    try {
      for await (const delta of stream) {
        if (delta.kind === 'content') fullText += delta.text;
      }
      // Only reached on a normal end — NOT the case here.
      await sceneWriter.finalizeDraft(chapterId, 'scene-1', fullText);
    } catch (error) {
      caught = error;
    }

    expect(isProxyError(caught)).toBe(true);
    // Partial body was streamed but never persisted (Req 6.8).
    expect(fullText.length).toBeGreaterThan(0);
    expect(await store.getSceneDraft(chapterId, 'scene-1')).toBeUndefined();
    expect(await store.listSceneDrafts(chapterId)).toHaveLength(0);
  });

  it('generates scenes in ascending scene_id order, persists each, and merges the chapter (Req 7.1, 7.2)', async () => {
    const { proxy, calls, deltasForCall } = makeFakeProxy();
    const sceneWriter = new SceneWriter(
      store,
      new ModelConfigService(store),
      proxy,
    );
    const chapterWriter = new ChapterWriter(
      store,
      new ModelConfigService(store),
      sceneWriter,
      new ChapterMerger(store),
    );

    const events: ChapterWriteEvent[] = [];
    for await (const event of chapterWriter.streamChapter(chapterId, signal())) {
      events.push(event);
    }

    // One provider call per scene.
    expect(calls).toHaveLength(SCENE_IDS.length);

    // `scene` events appear once per scene, in ascending scene_id order (Req 7.1).
    const sceneEventIds = events
      .filter((e): e is { type: 'scene'; sceneId: string } => e.type === 'scene')
      .map((e) => e.sceneId);
    const ascending = [...SCENE_IDS].sort(compareSceneId);
    expect(sceneEventIds).toEqual(ascending);
    expect([...sceneEventIds].sort(compareSceneId)).toEqual(sceneEventIds);

    // Every scene's draft was persisted with its full streamed body (Req 7.2).
    for (let position = 0; position < ascending.length; position += 1) {
      const sceneId = ascending[position];
      const expected = deltasForCall(position + 1).join('');
      const draft = await store.getSceneDraft(chapterId, sceneId);
      expect(draft?.content).toBe(expected);

      // Reconstruct the body from delta events too — they must match the draft.
      const deltaText = events
        .filter(
          (e): e is { type: 'delta'; sceneId: string; text: string } =>
            e.type === 'delta' && e.sceneId === sceneId,
        )
        .map((e) => e.text)
        .join('');
      expect(deltaText).toBe(expected);
    }

    // The chapter content was merged from all scene drafts in ascending order (Req 7.3).
    const expectedMerged = ascending
      .map((_, position) => deltasForCall(position + 1).join(''))
      .join('\n\n');
    const chapter = await store.getChapter(chapterId);
    expect(chapter?.content).toBe(expectedMerged);
  });

  it('retries an empty scene and never persists an empty checkpoint', async () => {
    const { proxy, calls } = makeFakeProxy({
      // The first provider response is an empty stream. The second response
      // supplies the same scene, after which the remaining scenes are normal.
      deltasForCall: (call) => (call === 1 ? [] : deltasForCallForRetry(call)),
    });
    const sceneWriter = new SceneWriter(
      store,
      new ModelConfigService(store),
      proxy,
    );
    const chapterWriter = new ChapterWriter(
      store,
      new ModelConfigService(store),
      sceneWriter,
      new ChapterMerger(store),
    );

    const events: ChapterWriteEvent[] = [];
    for await (const event of chapterWriter.streamChapter(chapterId, signal())) {
      events.push(event);
    }

    expect(calls).toHaveLength(SCENE_IDS.length + 1);
    expect((await store.getSceneDraft(chapterId, 'scene-1'))?.content).toBe(
      deltasForCallForRetry(2).join(''),
    );
    expect((await store.getChapter(chapterId))?.content).toContain('场景2正文');
    expect(events.filter((event) => event.type === 'scene')).toHaveLength(SCENE_IDS.length);
  });

  it('resumes from the first missing scene after a provider failure', async () => {
    const first = makeFakeProxy({ failOnCall: 3, deltasBeforeFail: 1 });
    const firstWriter = new ChapterWriter(
      store,
      new ModelConfigService(store),
      new SceneWriter(store, new ModelConfigService(store), first.proxy),
      new ChapterMerger(store),
    );
    await expect((async () => {
      for await (const _event of firstWriter.streamChapter(chapterId, signal())) {
        // consume until the failing scene
      }
    })()).rejects.toBeInstanceOf(ProxyError);

    expect(await store.getSceneDraft(chapterId, 'scene-1')).toBeDefined();
    expect(await store.getSceneDraft(chapterId, 'scene-2')).toBeDefined();
    expect(await store.getSceneDraft(chapterId, 'scene-3')).toBeUndefined();

    const resumed = makeFakeProxy();
    const resumedWriter = new ChapterWriter(
      store,
      new ModelConfigService(store),
      new SceneWriter(store, new ModelConfigService(store), resumed.proxy),
      new ChapterMerger(store),
    );
    for await (const _event of resumedWriter.streamChapter(chapterId, signal())) {
      // Existing scene-1/scene-2 checkpoints are skipped.
    }
    expect(resumed.calls).toHaveLength(SCENE_IDS.length - 2);
    expect((await store.getChapter(chapterId))?.content).toContain('场景3正文');
  });

  it('does not merge whitespace-only scene drafts', async () => {
    for (const sceneId of SCENE_IDS) {
      await store.saveSceneDraft({
        chapterId,
        sceneId,
        content: '  \n\n',
        updatedAt: new Date().toISOString(),
      });
    }
    const merger = new ChapterMerger(store);
    await expect(merger.merge(chapterId)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect((await store.getChapter(chapterId))?.content).toBe('');
  });

  it('stops on a mid-chapter scene failure, keeping earlier scenes and leaving the chapter unmerged (Req 7.4)', async () => {
    const failOnScene = 3; // 1-based: fail while writing scene-3.
    const { proxy, deltasForCall } = makeFakeProxy({
      failOnCall: failOnScene,
      deltasBeforeFail: 1,
    });
    const sceneWriter = new SceneWriter(
      store,
      new ModelConfigService(store),
      proxy,
    );
    const chapterWriter = new ChapterWriter(
      store,
      new ModelConfigService(store),
      sceneWriter,
      new ChapterMerger(store),
    );

    const events: ChapterWriteEvent[] = [];
    let caught: unknown;
    try {
      for await (const event of chapterWriter.streamChapter(
        chapterId,
        signal(),
      )) {
        events.push(event);
      }
    } catch (error) {
      caught = error;
    }

    expect(isProxyError(caught)).toBe(true);

    const ascending = [...SCENE_IDS].sort(compareSceneId);

    // Scenes before the failing one are persisted (Req 7.4).
    for (let position = 0; position < failOnScene - 1; position += 1) {
      const sceneId = ascending[position];
      const draft = await store.getSceneDraft(chapterId, sceneId);
      expect(draft?.content).toBe(deltasForCall(position + 1).join(''));
    }

    // The failing scene and all later scenes are NOT persisted.
    for (let position = failOnScene - 1; position < ascending.length; position += 1) {
      expect(
        await store.getSceneDraft(chapterId, ascending[position]),
      ).toBeUndefined();
    }

    // Only the failing scene's predecessors plus the failing scene emitted a
    // `scene` event (its boundary frame precedes the mid-stream error).
    const sceneEventIds = events
      .filter((e): e is { type: 'scene'; sceneId: string } => e.type === 'scene')
      .map((e) => e.sceneId);
    expect(sceneEventIds).toEqual(ascending.slice(0, failOnScene));

    // The chapter content was never merged/overwritten (still empty).
    const chapter = await store.getChapter(chapterId);
    expect(chapter?.content).toBe('');
  });
});

function deltasForCallForRetry(call: number): string[] {
  return [`场景${call}正文A`, `场景${call}正文B`, `场景${call}正文C`];
}
