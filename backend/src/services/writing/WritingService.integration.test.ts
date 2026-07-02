/**
 * End-to-end integration tests for the writing orchestration flow (task 9.3).
 *
 * Unlike {@link WritingService.test.ts} (which isolates orchestration with an
 * in-memory fake store), these tests wire the REAL persistence engine
 * ({@link FileDataStore} over a temp file) together with the real
 * {@link ModelConfigService} and {@link WritingService}, and exercise the full
 * continue / rewrite / polish flows against a MOCK {@link ModelProxy} (no real
 * network). This mirrors production wiring end-to-end:
 *
 *   seed store (project + chapter + character/world/outline + model config)
 *     -> WritingService.streamWriting
 *       -> ModelConfigService.getInternalConfig (full config, raw key)
 *       -> FileDataStore.getChapter / list{Characters,WorldSettings,Outlines}
 *       -> buildPromptMessages
 *       -> ModelProxy.streamCompletion (mock: records config + messages,
 *          yields canned deltas)
 *
 * Coverage:
 * - continue: assembled messages include the chapter content + instruction;
 *   streamed deltas are forwarded in order and join to the expected text
 *   (Req 5.1, 5.2 — proxy receives saved config; generated text returned).
 * - rewrite & polish: assembled messages include the selected text +
 *   instruction; deltas forwarded correctly (Req 5.1, 5.2).
 * - attached settings: character/world/outline bodies appear in the assembled
 *   system message when their ids are attached.
 * - security (Req 5.6): the FULL config (with raw apiKey) reaches the proxy,
 *   yet none of the streamed deltas contain the apiKey.
 * - provider error (Req 5.5): a mock proxy whose async iterable throws a
 *   ProxyError mid-stream propagates that ProxyError when the caller iterates
 *   the returned iterable.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProxyError, isProxyError } from '../../proxy/ProxyError.js';
import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type { StreamDelta } from '../../proxy/sseParser.js';
import { FileDataStore } from '../../store/FileDataStore.js';
import type {
  ChatMessage,
  Id,
  ModelConfig,
  WritingRequestBody,
} from '../../types/index.js';
import { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import { WritingService } from './WritingService.js';

/** A valid model config whose API key is a unique, easy-to-detect canary. */
const VALID_CONFIG: ModelConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-integration-canary-DO-NOT-LEAK-9f3a',
  modelName: 'gpt-4o-mini',
};

const CHAPTER_CONTENT = '从前有座山，山里有座庙，庙里有个老和尚在讲故事。';
const CHARACTER_DESC = '沉默寡言的剑客，背负着家族的宿命。';
const WORLD_CONTENT = '一个剑与灵气并存的九州大陆，门派林立。';
const OUTLINE_CONTENT = '第一卷：主角离开家乡，踏上寻找传说之剑的旅途。';

/**
 * Mock {@link ModelProxy} that records the `config`/`messages` of each call and
 * yields the supplied canned deltas. Performs no I/O. The recorded `config` lets
 * tests assert the FULL config (raw key) reached the proxy (Req 5.1, 5.6).
 */
function makeRecordingProxy(deltas: string[]) {
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

/**
 * Mock {@link ModelProxy} whose stream yields a few deltas and then throws a
 * {@link ProxyError} mid-stream, simulating a provider error/timeout surfaced
 * during iteration (Req 5.5).
 */
function makeFailingProxy(deltasBeforeError: string[], error: ProxyError) {
  const proxy: ModelProxy = {
    streamCompletion() {
      return (async function* () {
        for (const d of deltasBeforeError) yield { kind: 'content' as const, text: d };
        throw error;
      })();
    },
  };
  return { proxy };
}

/** Drain an async iterable of StreamDelta into an array of content strings. */
async function collect(iterable: AsyncIterable<StreamDelta>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of iterable) { if (d.kind === 'content') out.push(d.text); }
  return out;
}

interface Seeded {
  store: FileDataStore;
  modelConfigService: ModelConfigService;
  projectId: Id;
  chapterId: Id;
  characterId: Id;
  worldSettingId: Id;
  outlineId: Id;
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'writing-int-'));
  file = join(dir, 'store.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Seed a real {@link FileDataStore} over the temp file with a project, a
 * chapter (with content), one character/world/outline, and a saved model
 * config (persisted through the real {@link ModelConfigService}).
 */
async function seed(): Promise<Seeded> {
  const store = await FileDataStore.create(file);
  const modelConfigService = new ModelConfigService(store);

  const project = await store.createProject('集成测试项目');
  const chapter = await store.createChapter(project.id, '第一章');
  await store.updateChapterContent(chapter.id, CHAPTER_CONTENT);

  const character = await store.createCharacter(project.id, '林夜', CHARACTER_DESC);
  const world = await store.createWorldSetting(project.id, '九州大陆', WORLD_CONTENT);
  const outline = await store.createOutline(project.id, '第一卷', OUTLINE_CONTENT);

  // Persist the model config through the real service (validates + stores raw).
  await modelConfigService.save(VALID_CONFIG);

  return {
    store,
    modelConfigService,
    projectId: project.id,
    chapterId: chapter.id,
    characterId: character.id,
    worldSettingId: world.id,
    outlineId: outline.id,
  };
}

describe('WritingService integration — continue (Req 5.1, 5.2)', () => {
  it('assembles chapter content + instruction and forwards deltas in order', async () => {
    const seeded = await seed();
    const deltas = ['老', '和尚', '继续', '讲道'];
    const { proxy, calls } = makeRecordingProxy(deltas);
    const service = new WritingService(seeded.store, seeded.modelConfigService, proxy);

    const body: WritingRequestBody = {
      operation: 'continue',
      instruction: '请接着往下写下一段。',
    };

    const collected = await collect(
      await service.streamWriting(
        seeded.projectId,
        seeded.chapterId,
        body,
        new AbortController().signal,
      ),
    );

    // The provider was invoked exactly once with the assembled messages.
    expect(calls).toHaveLength(1);
    const joinedMessages = calls[0].messages.map((m) => m.content).join('\n');
    expect(joinedMessages).toContain(CHAPTER_CONTENT);
    expect(joinedMessages).toContain('请接着往下写下一段。');

    // Streamed deltas are forwarded in order and join to the expected text.
    expect(collected).toEqual(deltas);
    expect(collected.join('')).toBe('老和尚继续讲道');
  });
});

describe('WritingService integration — rewrite & polish (Req 5.1, 5.2)', () => {
  it.each<WritingRequestBody['operation']>(['rewrite', 'polish'])(
    '%s: assembles selected text + instruction and forwards deltas',
    async (operation) => {
      const seeded = await seed();
      const deltas = ['更', '生动', '的', '版本'];
      const { proxy, calls } = makeRecordingProxy(deltas);
      const service = new WritingService(
        seeded.store,
        seeded.modelConfigService,
        proxy,
      );

      const selectedText = '山里有座庙';
      const body: WritingRequestBody = {
        operation,
        instruction: '让这句话更有画面感。',
        selectedText,
      };

      const collected = await collect(
        await service.streamWriting(
          seeded.projectId,
          seeded.chapterId,
          body,
          new AbortController().signal,
        ),
      );

      expect(calls).toHaveLength(1);
      const joinedMessages = calls[0].messages.map((m) => m.content).join('\n');
      expect(joinedMessages).toContain(selectedText);
      expect(joinedMessages).toContain('让这句话更有画面感。');

      expect(collected).toEqual(deltas);
      expect(collected.join('')).toBe('更生动的版本');
    },
  );
});

describe('WritingService integration — attached settings', () => {
  it('includes character/world/outline bodies in the assembled system message', async () => {
    const seeded = await seed();
    const { proxy, calls } = makeRecordingProxy(['ok']);
    const service = new WritingService(seeded.store, seeded.modelConfigService, proxy);

    const body: WritingRequestBody = {
      operation: 'continue',
      instruction: '继续写。',
      attachedSettingIds: {
        characterIds: [seeded.characterId],
        worldSettingIds: [seeded.worldSettingId],
        outlineIds: [seeded.outlineId],
      },
    };

    await collect(
      await service.streamWriting(
        seeded.projectId,
        seeded.chapterId,
        body,
        new AbortController().signal,
      ),
    );

    const systemMsg = calls[0].messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    const content = systemMsg!.content;
    expect(content).toContain(CHARACTER_DESC);
    expect(content).toContain(WORLD_CONTENT);
    expect(content).toContain(OUTLINE_CONTENT);
  });
});

describe('WritingService integration — security (Req 5.6)', () => {
  it('forwards the full config (raw apiKey) to the proxy but leaks no key in deltas', async () => {
    const seeded = await seed();
    // Canned deltas deliberately do NOT contain the API key.
    const deltas = ['生成', '的', '文本', '内容'];
    const { proxy, calls } = makeRecordingProxy(deltas);
    const service = new WritingService(seeded.store, seeded.modelConfigService, proxy);

    const body: WritingRequestBody = {
      operation: 'continue',
      instruction: '继续',
    };

    const collected = await collect(
      await service.streamWriting(
        seeded.projectId,
        seeded.chapterId,
        body,
        new AbortController().signal,
      ),
    );

    // The FULL config (with the raw API key) reaches the proxy server-side.
    expect(calls).toHaveLength(1);
    expect(calls[0].config).toEqual(VALID_CONFIG);
    expect(calls[0].config.apiKey).toBe(VALID_CONFIG.apiKey);

    // None of the assembled messages contain the raw API key either.
    const joinedMessages = calls[0].messages.map((m) => m.content).join('\n');
    expect(joinedMessages).not.toContain(VALID_CONFIG.apiKey);

    // The frontend-visible stream (deltas) never contains the raw API key.
    for (const delta of collected) {
      expect(delta).not.toContain(VALID_CONFIG.apiKey);
    }
    expect(collected.join('')).not.toContain(VALID_CONFIG.apiKey);
  });
});

describe('WritingService integration — provider error (Req 5.5)', () => {
  it('propagates a ProxyError thrown mid-stream when the iterable is consumed', async () => {
    const seeded = await seed();
    const error = new ProxyError('模型提供商返回错误状态 502', { status: 502 });
    const { proxy } = makeFailingProxy(['前半段'], error);
    const service = new WritingService(seeded.store, seeded.modelConfigService, proxy);

    const body: WritingRequestBody = {
      operation: 'continue',
      instruction: '继续',
    };

    // streamWriting itself resolves (it only returns the iterable); the error
    // surfaces while iterating the stream.
    const iterable = await service.streamWriting(
      seeded.projectId,
      seeded.chapterId,
      body,
      new AbortController().signal,
    );

    await expect(collect(iterable)).rejects.toSatisfy(
      (e: unknown) => isProxyError(e) && e.status === 502,
    );
  });
});
