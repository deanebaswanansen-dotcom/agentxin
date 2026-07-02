/**
 * Property-based test for {@link ModelConfigService} save -> internal read-back
 * (task 6.2).
 *
 * Covers design.md Correctness **Property 14: 模型配置保存-读回往返**
 * (Requirements 4.1, 4.3):
 *
 *   For any 由非空 base URL、API Key 与模型名称组成的模型配置，保存后内部读回的
 *   各字段与所提交的值一致。
 *
 * **Validates: Requirements 4.1, 4.3**
 *
 * Method (design.md Testing Strategy): exercised end-to-end through a REAL
 * {@link FileDataStore} backed by a unique temp file per run (no mocks). For
 * each run we generate a {@link ModelConfig} whose `baseUrl`, `apiKey` and
 * `modelName` are each NON-EMPTY (at least one non-whitespace character, so the
 * service's non-empty validation accepts them), call `service.save(config)`,
 * then `service.getInternalConfig()` and assert each returned field equals the
 * submitted value EXACTLY — verbatim, NOT trimmed (Requirement 4.3: persisted
 * as provided). We additionally reload through a fresh store over the same file
 * to confirm the values survive a persistence round-trip.
 *
 * Field generators cover ASCII, Unicode, emoji, surrounding whitespace and long
 * strings, while always guaranteeing a non-whitespace character so the value is
 * non-empty after trim. A fresh store + temp file is created per run for full
 * isolation and cleaned up afterwards.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { FileDataStore } from '../../store/FileDataStore.js';
import type { ModelConfig } from '../../types/index.js';
import { ModelConfigService } from './ModelConfigService.js';

const NUM_RUNS = 100;

/**
 * A single non-whitespace code point. Guaranteeing one of these is present in
 * every generated field value ensures the value is non-empty after `trim()` —
 * exactly the precondition the property states for the model configuration.
 */
const nonWhitespaceChar: fc.Arbitrary<string> = fc.constantFrom(
  'a',
  'Z',
  '7',
  '-',
  '_',
  '/',
  '.',
  ':',
  '中',
  '模',
  'é',
  'ñ',
  'Ω',
  '🔑',
  '😀',
);

/**
 * Filler text placed around the guaranteed non-whitespace char. Includes
 * arbitrary strings, graphemes (emoji/combined), and constants covering
 * surrounding whitespace so the combined value exercises padded inputs that
 * MUST be stored verbatim (no trimming).
 */
const filler: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme', maxLength: 30 }),
  fc.constantFrom('', ' ', '   ', '\t', '\n', '  ', '\t ', ' '),
);

/**
 * Non-empty (after trim) field value generator. The middle non-whitespace char
 * guarantees `value.trim().length > 0`; the surrounding fillers cover ASCII,
 * Unicode, emoji and whitespace-around cases. A few explicit constants add
 * realistic configs, whitespace-padded values and a long string.
 */
const nonEmptyFieldArb: fc.Arbitrary<string> = fc.oneof(
  fc
    .tuple(filler, nonWhitespaceChar, filler)
    .map(([before, core, after]) => `${before}${core}${after}`),
  fc.constantFrom(
    'https://api.openai.com/v1',
    ' https://api.example.com/v1 ',
    'sk-1234567890abcd',
    ' sk-padded-key ',
    'gpt-4o-mini',
    ' my-model ',
    '中文模型名称',
    '日本語モデル',
    '🔑密钥-key',
    '"quoted" \\ slash / & < > %',
    'a'.repeat(500),
  ),
);

const modelConfigArb: fc.Arbitrary<ModelConfig> = fc.record({
  baseUrl: nonEmptyFieldArb,
  apiKey: nonEmptyFieldArb,
  modelName: nonEmptyFieldArb,
});

describe('ModelConfigService save/read-back round-trip (property)', () => {
  it(
    'Feature: novel-writing-agent, Property 14: 模型配置保存-读回往返',
    async () => {
      await fc.assert(
        fc.asyncProperty(modelConfigArb, async (config) => {
          // Sanity: the generator must only emit non-empty (after trim) fields,
          // matching the property's precondition.
          expect(config.baseUrl.trim().length).toBeGreaterThan(0);
          expect(config.apiKey.trim().length).toBeGreaterThan(0);
          expect(config.modelName.trim().length).toBeGreaterThan(0);

          const dir = await mkdtemp(join(tmpdir(), 'modelconfig-roundtrip-prop-'));
          const filePath = join(dir, 'store.json');
          try {
            const store = await FileDataStore.create(filePath);
            const service = new ModelConfigService(store);

            await service.save(config);

            // Internal read-back equals the submitted values EXACTLY (verbatim,
            // not trimmed) — Requirements 4.1, 4.3.
            const readBack = await service.getInternalConfig();
            expect(readBack).toBeDefined();
            expect(readBack?.baseUrl).toBe(config.baseUrl);
            expect(readBack?.apiKey).toBe(config.apiKey);
            expect(readBack?.modelName).toBe(config.modelName);
            expect(readBack).toEqual(config);

            // Persistence round-trip: a fresh store over the same file yields
            // the identical config (values survive disk serialization).
            const reloaded = await FileDataStore.create(filePath);
            const reloadedService = new ModelConfigService(reloaded);
            const reloadedConfig = await reloadedService.getInternalConfig();
            expect(reloadedConfig).toEqual(config);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    // Each of the 100 runs performs real filesystem I/O (mkdtemp + atomic
    // writes + a reload), so allow a generous timeout beyond the 5s default.
    30000,
  );
});
