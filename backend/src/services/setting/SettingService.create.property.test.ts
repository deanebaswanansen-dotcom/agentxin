/**
 * Property-based test for {@link SettingService} setting-entry creation (task 5.2).
 *
 * Covers design.md Correctness **Property 11: 设定条目创建后出现在对应列表且字段一致**
 * (Requirements 3.1, 3.2, 3.3, 3.4):
 *
 *   For any 项目下任意类型（人物、世界观、大纲）设定条目集合，逐个创建后，对应类型的
 *   列表恰好包含这些条目，且每个条目的字段与创建时所提交的值一致。
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
 *
 * Method (design.md Testing Strategy): exercised end-to-end through a REAL
 * {@link FileDataStore} backed by a unique temp file per run (no mocks), with a
 * project created first. For each of the three setting kinds we generate an
 * arbitrary-length array of entries and create them one by one:
 *
 *   - character    -> fields { name, description }       (Requirement 3.1)
 *   - worldSetting -> fields { title, content }          (Requirement 3.2)
 *   - outline      -> fields { title, content }          (Requirement 3.3)
 *
 * Then for each kind we read back via `service.<kind>.list(projectId)` and
 * assert the list contains EXACTLY the created entries (Requirement 3.4):
 *   1. the list length equals the number of created entries;
 *   2. every created entry (located by its returned id) is present with field
 *      values equal to those submitted at creation time.
 * Together these establish set equality (no missing and no extra entries), since
 * the store assigns unique ids. For outlines we additionally assert the list is
 * ordered by `position` ascending and that this order matches creation order.
 *
 * Uses fast-check with 100 runs. Field-value generators cover ASCII, Unicode,
 * emoji, whitespace, empty, special characters and longer strings, and the
 * entry arrays may be empty (covering the empty-collection edge case). A fresh
 * store + temp file is created per run for full isolation and cleaned up
 * afterwards.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { FileDataStore } from '../../store/FileDataStore.js';
import { SettingService } from './SettingService.js';

const NUM_RUNS = 100;

/**
 * General-purpose field-value generator: covers ASCII, Unicode, emoji,
 * whitespace, empty, special characters and longer strings. The service applies
 * no non-empty validation to setting fields (see SettingService docstring), so
 * empty strings are valid values to round-trip.
 */
const fieldValueArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme', maxLength: 40 }),
  fc.constantFrom(
    '',
    ' ',
    '   ',
    '\t',
    '\n',
    'line1\nline2\r\nline3',
    'ascii text',
    '中文设定内容',
    '日本語テキスト',
    '😀🎉👨‍👩‍👧‍👦',
    '"quoted" \\ slash / & < > %',
    'a'.repeat(500),
  ),
);

/** Each run creates real files per entry, so cap array sizes to keep I/O bounded. */
const ARRAY_CONSTRAINTS = { maxLength: 5 } as const;

const charactersArb = fc.array(
  fc.record({ name: fieldValueArb, description: fieldValueArb }),
  ARRAY_CONSTRAINTS,
);
const worldSettingsArb = fc.array(
  fc.record({ title: fieldValueArb, content: fieldValueArb }),
  ARRAY_CONSTRAINTS,
);
const outlinesArb = fc.array(
  fc.record({ title: fieldValueArb, content: fieldValueArb }),
  ARRAY_CONSTRAINTS,
);

/**
 * Assert that `listed` contains EXACTLY the created entries: same count, and
 * every created entry is present (located by id) with all submitted field
 * values preserved. `submitted` is the original input object whose keys in
 * `fieldKeys` were passed to `create`.
 */
function expectExactById<T extends { id: string }>(
  listed: T[],
  created: { id: string; submitted: Record<string, string> }[],
  fieldKeys: readonly string[],
): void {
  expect(listed.length).toBe(created.length);
  const byId = new Map(listed.map((entry) => [entry.id, entry]));
  for (const { id, submitted } of created) {
    const found = byId.get(id) as Record<string, unknown> | undefined;
    expect(found).toBeDefined();
    for (const key of fieldKeys) {
      expect(found?.[key]).toBe(submitted[key]);
    }
  }
}

describe('SettingService create field-consistency (property)', () => {
  it('Feature: novel-writing-agent, Property 11: 设定条目创建后出现在对应列表且字段一致', async () => {
    await fc.assert(
      fc.asyncProperty(
        charactersArb,
        worldSettingsArb,
        outlinesArb,
        async (characters, worldSettings, outlines) => {
          const dir = await mkdtemp(join(tmpdir(), 'setting-create-prop-'));
          try {
            const store = await FileDataStore.create(join(dir, 'store.json'));
            const service = new SettingService(store);
            const project = await store.createProject('小说项目');
            const projectId = project.id;

            // --- characters: { name, description } (Requirement 3.1) ---
            {
              const created: { id: string; submitted: Record<string, string> }[] = [];
              for (const c of characters) {
                const entry = await service.characters.create(
                  projectId,
                  c.name,
                  c.description,
                );
                created.push({ id: entry.id, submitted: c });
              }
              const list = await service.characters.list(projectId);
              expectExactById(list, created, ['name', 'description']);
            }

            // --- worldSettings: { title, content } (Requirement 3.2) ---
            {
              const created: { id: string; submitted: Record<string, string> }[] = [];
              for (const w of worldSettings) {
                const entry = await service.worldSettings.create(
                  projectId,
                  w.title,
                  w.content,
                );
                created.push({ id: entry.id, submitted: w });
              }
              const list = await service.worldSettings.list(projectId);
              expectExactById(list, created, ['title', 'content']);
            }

            // --- outlines: { title, content }, position ascending (Requirement 3.3) ---
            {
              const created: { id: string; submitted: Record<string, string> }[] = [];
              for (const o of outlines) {
                const entry = await service.outlines.create(
                  projectId,
                  o.title,
                  o.content,
                );
                created.push({ id: entry.id, submitted: o });
              }
              const list = await service.outlines.list(projectId);
              expectExactById(list, created, ['title', 'content']);

              // Outlines list is ordered by position ascending, and that order
              // matches creation order.
              for (let i = 1; i < list.length; i += 1) {
                expect(list[i].position).toBeGreaterThan(list[i - 1].position);
              }
              expect(list.map((o) => o.id)).toEqual(created.map((c) => c.id));
            }
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  },
  // Each of the 100 runs performs real filesystem I/O (mkdtemp + an atomic write
  // per created entry) across all three setting kinds, so allow a generous
  // timeout well beyond the 5s vitest default.
  30000);
});
