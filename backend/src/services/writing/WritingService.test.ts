/**
 * Example/edge-case unit tests for {@link WritingService} (task 9.1).
 *
 * The property test for `MODEL_NOT_CONFIGURED` (task 9.2) and the end-to-end
 * integration test (task 9.3) live elsewhere; these tests cover concrete
 * orchestration examples in isolation from the HTTP and provider layers:
 *
 * - `MODEL_NOT_CONFIGURED` is thrown (before any provider call) when no model
 *   config is saved (Req 5.4).
 * - `continue` puts the chapter content into the prompt (Req 6.1).
 * - `rewrite`/`polish` put the selected text into the prompt (Req 6.2).
 * - Attached setting ids are resolved into the writing context (Req 6.5).
 * - Session history is passed through in order (Req 6.6).
 * - The provider's streamed deltas are forwarded unchanged (Req 5.1, 5.3).
 *
 * A real {@link ModelConfigService} wraps the same in-memory fake store used
 * for chapters/settings (mirroring production wiring), and a MOCK
 * {@link ModelProxy} records the `config`/`messages` it received and yields
 * canned deltas.
 */
import { describe, expect, it } from 'vitest';

import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type { StreamDelta } from '../../proxy/sseParser.js';
import type { DataStore } from '../../store/DataStore.js';
import type {
  Chapter,
  ChatMessage,
  Character,
  ModelConfig,
  Outline,
  WorldSetting,
  WritingRequestBody,
} from '../../types/index.js';
import { isServiceError } from '../ServiceError.js';
import { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import { WritingService } from './WritingService.js';

const VALID_CONFIG: ModelConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-secret-canary',
  modelName: 'gpt-4o-mini',
};

interface FakeData {
  chapters?: Chapter[];
  characters?: Character[];
  worldSettings?: WorldSetting[];
  outlines?: Outline[];
  modelConfig?: ModelConfig;
}

/**
 * Minimal in-memory store covering only the surface WritingService +
 * ModelConfigService touch: chapter lookup, setting lists and the singleton
 * model config. Any other method throws to surface accidental usage.
 */
function makeFakeStore(data: FakeData): DataStore {
  let config = data.modelConfig;
  const fake: Partial<DataStore> = {
    async getChapter(id) {
      return (data.chapters ?? []).find((c) => c.id === id);
    },
    async listCharacters(projectId) {
      return (data.characters ?? []).filter((c) => c.projectId === projectId);
    },
    async listWorldSettings(projectId) {
      return (data.worldSettings ?? []).filter((w) => w.projectId === projectId);
    },
    async listOutlines(projectId) {
      return (data.outlines ?? []).filter((o) => o.projectId === projectId);
    },
    async saveModelConfig(next) {
      config = { ...next };
    },
    async getModelConfig() {
      return config ? { ...config } : undefined;
    },
  };
  return fake as DataStore;
}

/**
 * Mock {@link ModelProxy} that records the last call's `config`/`messages` and
 * yields the supplied canned deltas. Never performs any I/O.
 */
function makeMockProxy(deltas: string[] = ['hello', ' world']) {
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

async function collect(iterable: AsyncIterable<StreamDelta>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of iterable) { if (d.kind === 'content') out.push(d.text); }
  return out;
}

const chapter: Chapter = {
  id: 'chap-1',
  projectId: 'proj-1',
  title: '第一章',
  content: '从前有座山，山里有座庙。',
  position: 0,
};

function makeService(data: FakeData, deltas?: string[]) {
  const store = makeFakeStore(data);
  const modelConfigService = new ModelConfigService(store);
  const { proxy, calls } = makeMockProxy(deltas);
  const service = new WritingService(store, modelConfigService, proxy);
  return { service, calls };
}

describe('WritingService.streamWriting model config check', () => {
  it('throws MODEL_NOT_CONFIGURED when no config is saved, before any provider call (Req 5.4)', async () => {
    const { service, calls } = makeService({ chapters: [chapter] });

    const body: WritingRequestBody = { operation: 'continue', instruction: '继续' };

    await expect(
      service.streamWriting('proj-1', 'chap-1', body, new AbortController().signal),
    ).rejects.toSatisfy(
      (e: unknown) => isServiceError(e) && e.code === 'MODEL_NOT_CONFIGURED',
    );

    // Provider must NOT be reached when the model is unconfigured.
    expect(calls).toHaveLength(0);
  });

  it('throws NOT_FOUND when the chapter does not exist', async () => {
    const { service } = makeService({ chapters: [chapter], modelConfig: VALID_CONFIG });

    const body: WritingRequestBody = { operation: 'continue', instruction: '继续' };

    await expect(
      service.streamWriting('proj-1', 'missing', body, new AbortController().signal),
    ).rejects.toSatisfy((e: unknown) => isServiceError(e) && e.code === 'NOT_FOUND');
  });
});

describe('WritingService.streamWriting context assembly', () => {
  it('continue: prompt includes the chapter content and instruction (Req 6.1)', async () => {
    const { service, calls } = makeService({
      chapters: [chapter],
      modelConfig: VALID_CONFIG,
    });

    const body: WritingRequestBody = {
      operation: 'continue',
      instruction: '请接着往下写。',
    };
    await collect(
      await service.streamWriting('proj-1', 'chap-1', body, new AbortController().signal),
    );

    expect(calls).toHaveLength(1);
    const joined = calls[0].messages.map((m) => m.content).join('\n');
    expect(joined).toContain(chapter.content);
    expect(joined).toContain('请接着往下写。');
    // The internal config (with raw key) is what reaches the proxy.
    expect(calls[0].config).toEqual(VALID_CONFIG);
  });

  it.each<WritingRequestBody['operation']>(['rewrite', 'polish'])(
    '%s: prompt includes the selected text and instruction (Req 6.2)',
    async (operation) => {
      const { service, calls } = makeService({
        chapters: [chapter],
        modelConfig: VALID_CONFIG,
      });

      const body: WritingRequestBody = {
        operation,
        instruction: '让它更生动。',
        selectedText: '山里有座庙',
      };
      await collect(
        await service.streamWriting('proj-1', 'chap-1', body, new AbortController().signal),
      );

      const joined = calls[0].messages.map((m) => m.content).join('\n');
      expect(joined).toContain('山里有座庙');
      expect(joined).toContain('让它更生动。');
    },
  );

  it('resolves attached setting ids into the writing context (Req 6.5)', async () => {
    const character: Character = {
      id: 'char-1',
      projectId: 'proj-1',
      name: '李雷',
      description: '沉默寡言的剑客。',
    };
    const world: WorldSetting = {
      id: 'world-1',
      projectId: 'proj-1',
      title: '九州大陆',
      content: '一个剑与灵气并存的世界。',
    };
    const outline: Outline = {
      id: 'outline-1',
      projectId: 'proj-1',
      title: '第一卷',
      content: '主角离开家乡踏上旅途。',
      position: 0,
    };

    const { service, calls } = makeService({
      chapters: [chapter],
      characters: [character],
      worldSettings: [world],
      outlines: [outline],
      modelConfig: VALID_CONFIG,
    });

    const body: WritingRequestBody = {
      operation: 'continue',
      instruction: '继续',
      attachedSettingIds: {
        characterIds: ['char-1', 'unknown-id'],
        worldSettingIds: ['world-1'],
        outlineIds: ['outline-1'],
      },
    };
    await collect(
      await service.streamWriting('proj-1', 'chap-1', body, new AbortController().signal),
    );

    const systemMsg = calls[0].messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    const content = systemMsg!.content;
    // Each attached setting's body appears in the context.
    expect(content).toContain(character.description);
    expect(content).toContain(world.content);
    expect(content).toContain(outline.content);
    // Unknown ids are silently ignored (no throw, no extra content).
  });

  it('emits a base system message even when no settings are attached (cache prefix)', async () => {
    const { service, calls } = makeService({
      chapters: [chapter],
      modelConfig: VALID_CONFIG,
    });
    const body: WritingRequestBody = { operation: 'continue', instruction: '继续' };
    await collect(
      await service.streamWriting('proj-1', 'chap-1', body, new AbortController().signal),
    );
    // Cache optimization: system message is ALWAYS present for stable prefix
    expect(calls[0].messages.some((m) => m.role === 'system')).toBe(true);
    // When no settings, system content should not contain setting markers
    expect(calls[0].messages[0].content).not.toContain('以下是本项目的稳定设定');
  });

  it('passes session history through in order (Req 6.6)', async () => {
    const { service, calls } = makeService({
      chapters: [chapter],
      modelConfig: VALID_CONFIG,
    });

    const body: WritingRequestBody = {
      operation: 'continue',
      instruction: '继续',
      sessionHistory: [
        { role: 'user', content: '第一轮提问' },
        { role: 'assistant', content: '第一轮回答' },
        { role: 'user', content: '第二轮提问' },
      ],
    };
    await collect(
      await service.streamWriting('proj-1', 'chap-1', body, new AbortController().signal),
    );

    const historyContents = calls[0].messages
      .filter((m) => m.role !== 'system')
      .map((m) => m.content);
    // History appears in order, ahead of the final user prompt.
    expect(historyContents.slice(0, 3)).toEqual([
      '第一轮提问',
      '第一轮回答',
      '第二轮提问',
    ]);
  });
});

describe('WritingService.streamWriting streaming', () => {
  it('forwards the provider deltas unchanged and in order (Req 5.1, 5.3)', async () => {
    const deltas = ['从', '前', '有', '座', '山'];
    const { service } = makeService(
      { chapters: [chapter], modelConfig: VALID_CONFIG },
      deltas,
    );

    const body: WritingRequestBody = { operation: 'continue', instruction: '继续' };
    const collected = await collect(
      await service.streamWriting('proj-1', 'chap-1', body, new AbortController().signal),
    );

    expect(collected).toEqual(deltas);
    expect(collected.join('')).toBe('从前有座山');
  });
});
