/**
 * Property-based test for {@link ModelConfigService} outward-view masking
 * (task 6.3).
 *
 * Covers design.md Correctness **Property 15: 模型配置对外视图掩码 API Key**
 * (Requirements 4.2, 5.6):
 *
 *   For any 已保存的模型配置，对外返回的配置视图包含 base URL 与模型名称，
 *   且其完整序列化结果不包含 API Key 原文。
 *
 * **Validates: Requirements 4.2, 5.6**
 *
 * Method (design.md Testing Strategy / 安全): exercised end-to-end through a
 * REAL {@link FileDataStore} backed by a unique temp file per run (no mocks).
 * For each generated, fully non-empty {@link ModelConfig} we `service.save` it
 * then `service.getView()` and assert:
 *
 *   1. the view exposes `baseUrl` and `modelName` verbatim (Requirement 4.2);
 *   2. the masked key field never equals nor contains the raw API key — this is
 *      the core security guarantee, since `apiKeyMasked` is the only field
 *      derived from the secret (Requirements 4.2, 5.6 / Property 15);
 *   3. the FULL serialized view (`JSON.stringify(view)`) does not contain the
 *      raw API key as a substring (design.md: "对前端可见的全部输出做 API Key
 *      原文子串检查").
 *
 * Note on (3): `baseUrl` / `modelName` are returned IN THE CLEAR by design, so
 * if the raw key string happens to be a coincidental substring of one of those
 * cleartext fields, that is not a leak through the masked secret. To keep the
 * full-serialization check a clean security signal (no false failures), the API
 * key generator below produces keys with a distinctive `sk-` prefix that the
 * cleartext-field generators never emit, and the assertion is additionally
 * guarded against any such coincidental overlap.
 *
 * Uses fast-check with 100 runs. Generators cover ASCII, Unicode, emoji,
 * whitespace, special characters and long strings, plus API keys of varied
 * lengths (including 1-2 chars) and pathological keys such as runs of `*`. A
 * fresh store + temp file is created per run for full isolation and cleaned up
 * afterwards.
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
 * Cleartext field generator for `baseUrl` / `modelName`. These are stored and
 * returned verbatim, and the service rejects empty/whitespace-only values
 * (Requirement 4.4), so every generated value has at least one non-whitespace
 * character. Covers ASCII, Unicode, emoji, whitespace runs, special characters
 * and long strings. None of these emit the distinctive `sk-` API-key prefix.
 */
const clearFieldArb: fc.Arbitrary<string> = fc
  .oneof(
    fc.string(),
    fc.string({ unit: 'grapheme', maxLength: 40 }),
    fc.constantFrom(
      'https://api.openai.com/v1',
      'https://example.com/v1 ',
      ' https://x/v1',
      'gpt-4o-mini',
      'model name with spaces',
      '中文模型名称',
      '日本語モデル',
      '😀🎉 model 模型',
      '"quoted" \\ slash / & < > %',
      'a'.repeat(400),
    ),
  )
  .filter((s) => s.trim().length > 0);

/**
 * API key generator. The service rejects empty/whitespace-only keys, so every
 * value has a non-whitespace character. Coverage:
 *   - realistic distinctive keys (`sk-` + arbitrary ASCII/Unicode body), which
 *     guarantees non-emptiness and avoids coincidental overlap with the
 *     cleartext fields above;
 *   - very short keys (1-2 chars);
 *   - pathological keys made of runs of the mask character `*` (the masking
 *     implementation must not leak these either);
 *   - assorted edge keys (mask-like literals, emoji, padded).
 */
const apiKeyArb: fc.Arbitrary<string> = fc
  .oneof(
    fc.string({ minLength: 1 }).map((s) => `sk-${s}`),
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 40 }).map((s) => `sk-${s}`),
    fc.constantFrom('a', 'ab', 'x', '1', 'k'),
    fc.integer({ min: 1, max: 16 }).map((n) => '*'.repeat(n)),
    fc.constantFrom('****', '****abcd', '密钥🔑key', ' sk-padded-key '),
  )
  .filter((s) => s.trim().length > 0);

const modelConfigArb: fc.Arbitrary<ModelConfig> = fc.record({
  baseUrl: clearFieldArb,
  apiKey: apiKeyArb,
  modelName: clearFieldArb,
});

describe('ModelConfigService outward view masking (property)', () => {
  it(
    'Feature: novel-writing-agent, Property 15: 模型配置对外视图掩码 API Key',
    async () => {
      await fc.assert(
        fc.asyncProperty(modelConfigArb, async (config) => {
          const dir = await mkdtemp(join(tmpdir(), 'model-config-mask-prop-'));
          try {
            const store = await FileDataStore.create(join(dir, 'store.json'));
            const service = new ModelConfigService(store);

            await service.save(config);
            const view = await service.getView();

            // (1) Cleartext fields are exposed verbatim (Requirement 4.2).
            expect(view.baseUrl).toBe(config.baseUrl);
            expect(view.modelName).toBe(config.modelName);

            // (2) Core security guarantee: the masked field — the only field
            // derived from the secret — never equals nor contains the raw key
            // (Requirements 4.2, 5.6 / Property 15).
            expect(view.apiKeyMasked).not.toBe(config.apiKey);
            expect(view.apiKeyMasked.includes(config.apiKey)).toBe(false);

            // (3) The FULL serialized view must not contain the raw key, with
            // structural / cleartext occurrences correctly attributed so this
            // stays a clean leak signal. The raw key may legitimately appear in
            // the serialization via (a) the fixed JSON field-name skeleton
            // (e.g. the lowercase "k" in "apiKeyMasked") or (b) the
            // intentionally-cleartext baseUrl/modelName values (Requirement
            // 4.2). A genuine leak can only come through `apiKeyMasked`. So we
            // build a baseline serialization with the secret-derived field
            // neutralized: if the raw key already appears there it cannot be
            // distinguished from a leak, so we skip; otherwise its presence in
            // the full serialization necessarily means it leaked via
            // apiKeyMasked.
            const serialized = JSON.stringify(view);
            const baseline = JSON.stringify({ ...view, apiKeyMasked: '' });
            const keyExplainedByNonSecretParts = baseline.includes(config.apiKey);
            if (!keyExplainedByNonSecretParts) {
              expect(serialized.includes(config.apiKey)).toBe(false);
            }
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    // Each of the 100 runs performs real filesystem I/O (mkdtemp + atomic
    // write), so allow a generous timeout beyond the 5s vitest default.
    30000,
  );
});
