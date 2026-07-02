/**
 * Property-based test for {@link ModelConfigService} save-validation (task 6.4).
 *
 * Covers design.md Correctness **Property 16: 空字段模型配置被拒绝且已存配置不变**
 * (Requirement 4.4):
 *
 *   对任意 至少含一个空字符串字段（base URL、API Key 或模型名称之一）的模型配置，
 *   保存请求被拒绝并返回 VALIDATION_ERROR，且数据存储中已存的模型配置保持不变。
 *
 * **Validates: Requirements 4.4**
 *
 * Method (design.md Testing Strategy): exercised end-to-end through a REAL
 * {@link FileDataStore} backed by a unique temp file per run (no mocks). Each
 * run:
 *
 *   1. Pre-seeds the store with a VALID config (all three fields non-empty) and
 *      snapshots it via `service.getInternalConfig()`.
 *   2. Generates an INVALID config in which AT LEAST ONE of `baseUrl`/`apiKey`/
 *      `modelName` is empty or whitespace-only (the remaining fields may be
 *      valid or also invalid). A dedicated generator randomly chooses which
 *      field(s) are invalid while guaranteeing the at-least-one invariant.
 *   3. Asserts `service.save(invalidConfig)` rejects with a {@link ServiceError}
 *      whose `code === 'VALIDATION_ERROR'`.
 *   4. Asserts the previously stored config is UNCHANGED — `getInternalConfig()`
 *      still deep-equals the pre-seeded snapshot.
 *
 * Uses fast-check with 100 runs. A fresh store + temp file is created per run
 * for full isolation and cleaned up afterwards.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { FileDataStore } from '../../store/FileDataStore.js';
import type { ModelConfig } from '../../types/index.js';
import { isServiceError } from '../ServiceError.js';
import { ModelConfigService } from './ModelConfigService.js';

const NUM_RUNS = 100;

/** A VALID config (all fields non-empty) used to pre-seed and check invariance. */
const SEEDED_CONFIG: ModelConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-seeded-1234567890',
  modelName: 'gpt-4o-mini',
};

/**
 * Whitespace-only generator: builds strings (possibly empty) from a set of
 * whitespace characters that the service treats as "empty" via `String.trim()`
 * (spaces, tabs, newlines, NBSP, ...). The service rejects any field whose
 * trimmed length is zero (Requirement 4.4).
 */
const blankFieldArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v', '\u00A0', '\u2003'), {
    maxLength: 5,
  })
  .map((parts) => parts.join(''));

/** A VALID (non-whitespace) field value: guaranteed to survive `trim()`. */
const validFieldArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
  fc.constantFrom(
    'https://provider.example.com/v1',
    'sk-valid-key-abcdef',
    'gpt-4o',
    '模型-名称',
    'a',
  ),
);

/**
 * Per-field generator that yields either a VALID value or an INVALID
 * (empty/whitespace-only) value, tagged so the assembler can enforce the
 * "at least one invalid field" invariant.
 */
const fieldArb: fc.Arbitrary<{ value: string; invalid: boolean }> = fc.oneof(
  validFieldArb.map((value) => ({ value, invalid: false })),
  blankFieldArb.map((value) => ({ value, invalid: true })),
);

/**
 * Assemble a {@link ModelConfig} in which AT LEAST ONE field is invalid
 * (empty/whitespace-only). Each field is independently valid-or-invalid; if the
 * random draw happens to make all three valid, one field is forced invalid so
 * the generated config always violates the non-empty rule.
 */
const invalidConfigArb: fc.Arbitrary<ModelConfig> = fc
  .record({
    baseUrl: fieldArb,
    apiKey: fieldArb,
    modelName: fieldArb,
    forcedIndex: fc.constantFrom(0, 1, 2),
  })
  .map(({ baseUrl, apiKey, modelName, forcedIndex }) => {
    const fields = [baseUrl, apiKey, modelName];
    if (!fields.some((f) => f.invalid)) {
      // No field was invalid by chance — force one to be blank.
      fields[forcedIndex] = { value: '', invalid: true };
    }
    return {
      baseUrl: fields[0].value,
      apiKey: fields[1].value,
      modelName: fields[2].value,
    } satisfies ModelConfig;
  });

describe('ModelConfigService save validation (property)', () => {
  it(
    'Feature: novel-writing-agent, Property 16: 空字段模型配置被拒绝且已存配置不变',
    async () => {
      await fc.assert(
        fc.asyncProperty(invalidConfigArb, async (invalidConfig) => {
          const dir = await mkdtemp(join(tmpdir(), 'modelconfig-validation-prop-'));
          try {
            const store = await FileDataStore.create(join(dir, 'store.json'));
            const service = new ModelConfigService(store);

            // 1. Pre-seed a valid config and snapshot it.
            await service.save(SEEDED_CONFIG);
            const snapshot = await service.getInternalConfig();
            expect(snapshot).toEqual(SEEDED_CONFIG);

            // 2-3. The invalid save is rejected with VALIDATION_ERROR.
            await expect(service.save(invalidConfig)).rejects.toSatisfy(
              (e: unknown) => isServiceError(e) && e.code === 'VALIDATION_ERROR',
            );

            // 4. The previously stored config is unchanged.
            expect(await service.getInternalConfig()).toEqual(snapshot);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    // Each run performs real filesystem I/O (mkdtemp + atomic writes), so allow
    // a generous timeout beyond the 5s vitest default.
    30000,
  );
});
