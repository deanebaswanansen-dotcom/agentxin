/**
 * Property-based test for {@link WritingService} writing orchestration when no
 * model configuration has been saved (task 9.2).
 *
 * Covers design.md Correctness **Property 18: 未配置模型时写作返回提示错误**
 * (Requirement 5.4):
 *
 *   For any 写作请求体，在数据存储中不存在模型配置时，后端返回
 *   `MODEL_NOT_CONFIGURED` 错误。
 *
 * **Validates: Requirements 5.4**
 *
 * Method (design.md Testing Strategy): exercised end-to-end through a REAL
 * {@link FileDataStore} backed by a unique temp file per run (no mocks for the
 * store), with NO model config saved. A project + chapter are seeded so the
 * failure is specifically attributable to the missing model configuration —
 * note that {@link WritingService.streamWriting} checks the model config
 * BEFORE loading the chapter, so the result is `MODEL_NOT_CONFIGURED` either
 * way; we assert that code regardless.
 *
 * A MOCK {@link ModelProxy} whose `streamCompletion` throws if ever invoked
 * proves the provider is never reached when the model is unconfigured
 * (Requirement 5.4): the config check must short-circuit before any provider
 * call.
 *
 * For ANY arbitrary {@link WritingRequestBody} — operation ∈
 * {continue, rewrite, polish}, arbitrary instruction, optional selectedText,
 * optional attachedSettingIds (arbitrary id arrays) and optional sessionHistory
 * (arbitrary ChatTurn arrays) — `streamWriting` must reject with a
 * {@link ServiceError} whose `code === 'MODEL_NOT_CONFIGURED'`.
 *
 * Uses fast-check with 100 runs. Generators cover ASCII, Unicode, emoji,
 * whitespace, empty, special characters, long strings and empty collections. A
 * fresh store + temp file is created per run for full isolation and cleaned up
 * afterwards.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import type { ModelProxy } from '../../proxy/ModelProxy.js';
import type { ChatTurn, WritingRequestBody } from '../../types/index.js';
import { FileDataStore } from '../../store/FileDataStore.js';
import { isServiceError } from '../ServiceError.js';
import { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import { WritingService } from './WritingService.js';

const NUM_RUNS = 100;

/**
 * General-purpose text generator covering ASCII, Unicode, emoji, whitespace,
 * empty and special-character strings, plus a longer string. Used for free-form
 * fields (instruction, selectedText, history content) where no validation
 * applies.
 */
const textArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme', maxLength: 40 }),
  fc.constantFrom(
    '',
    ' ',
    '   ',
    '\t',
    '\n',
    'ascii instruction',
    '请接着往下写。',
    '日本語の指示',
    '😀🎉写作',
    '"quoted" \\ slash / & < > %',
    'x'.repeat(500),
  ),
);

/** Arbitrary entity id strings (the store holds none of these, by design). */
const idArb: fc.Arbitrary<string> = fc.oneof(
  fc.uuid(),
  fc.string(),
  fc.constantFrom('', 'unknown-id', '中文id', 'id with spaces'),
);

/** Arbitrary list of ids; includes the empty list to cover empty collections. */
const idListArb: fc.Arbitrary<string[]> = fc.array(idArb, { maxLength: 5 });

/** Arbitrary session-history turn. */
const chatTurnArb: fc.Arbitrary<ChatTurn> = fc.record({
  role: fc.constantFrom<ChatTurn['role']>('user', 'assistant'),
  content: textArb,
});

/**
 * Arbitrary {@link WritingRequestBody} spanning all three operations with
 * optional selectedText, optional attachedSettingIds (each sub-array optional)
 * and optional sessionHistory.
 */
const writingRequestBodyArb: fc.Arbitrary<WritingRequestBody> = fc.record(
  {
    operation: fc.constantFrom<WritingRequestBody['operation']>(
      'continue',
      'rewrite',
      'polish',
    ),
    instruction: textArb,
    selectedText: fc.option(textArb, { nil: undefined }),
    attachedSettingIds: fc.option(
      fc.record(
        {
          characterIds: fc.option(idListArb, { nil: undefined }),
          worldSettingIds: fc.option(idListArb, { nil: undefined }),
          outlineIds: fc.option(idListArb, { nil: undefined }),
        },
        { requiredKeys: [] },
      ),
      { nil: undefined },
    ),
    sessionHistory: fc.option(fc.array(chatTurnArb, { maxLength: 6 }), {
      nil: undefined,
    }),
  },
  { requiredKeys: ['operation', 'instruction'] },
);

/**
 * Mock {@link ModelProxy} that MUST never be reached when the model is
 * unconfigured. Both invoking the method and iterating the (lazy) result throw,
 * so any accidental provider call surfaces as a test failure rather than a
 * silently swallowed error.
 */
function makeThrowingProxy(): ModelProxy {
  return {
    streamCompletion() {
      throw new Error(
        'ModelProxy.streamCompletion must not be called when no model is configured',
      );
    },
  };
}

describe('WritingService model-not-configured (property)', () => {
  it(
    'Feature: novel-writing-agent, Property 18: 未配置模型时写作返回提示错误',
    async () => {
      await fc.assert(
        fc.asyncProperty(writingRequestBodyArb, async (body) => {
          const dir = await mkdtemp(join(tmpdir(), 'writing-no-config-prop-'));
          try {
            // Real store with NO model config saved.
            const store = await FileDataStore.create(join(dir, 'store.json'));
            // Seed a project + chapter so the only missing piece is the model
            // config (the check still precedes chapter loading either way).
            const project = await store.createProject('小说项目');
            const chapter = await store.createChapter(project.id, '第一章');

            const modelConfigService = new ModelConfigService(store);
            const proxy = makeThrowingProxy();
            const service = new WritingService(store, modelConfigService, proxy);

            await expect(
              service.streamWriting(
                project.id,
                chapter.id,
                body,
                new AbortController().signal,
              ),
            ).rejects.toSatisfy(
              (e: unknown) =>
                isServiceError(e) && e.code === 'MODEL_NOT_CONFIGURED',
            );
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    // Each of the 100 runs performs real filesystem I/O (mkdtemp + atomic
    // writes), so allow a generous timeout beyond the 5s vitest default.
    30000,
  );
});
