/**
 * Property-based test for {@link SettingService} setting-entry updates (task 5.3).
 *
 * Covers design.md Correctness **Property 12: 设定条目更新往返** (Requirement 3.5):
 *
 *   For any 已存在的设定条目与任意新字段值，更新后读回的对应字段等于所提交的值。
 *
 * **Validates: Requirements 3.5**
 *
 * Method (design.md Testing Strategy): exercised end-to-end through a REAL
 * {@link FileDataStore} backed by a unique temp file per run (no mocks), with a
 * project created first. For each of the three setting kinds:
 *
 *   - character    -> mutable fields { name, description }
 *   - worldSetting -> mutable fields { title, content }
 *   - outline      -> mutable fields { title, content }
 *
 * we create an entry with arbitrary initial field values, then apply an update
 * carrying arbitrary NEW values. The update may be *full* (both fields) or
 * *partial* (only one field present). We read the entry back via
 * `service.<kind>.list(projectId)` (locating it by id) and assert:
 *   1. every field included in the update equals the submitted value;
 *   2. every field omitted from a partial update is unchanged from its initial
 *      value.
 *
 * Uses fast-check with 100 runs. Field-value generators cover ASCII, Unicode,
 * emoji, whitespace, empty, special characters and long strings. A fresh store
 * + temp file is created per run for full isolation and cleaned up afterwards.
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

/**
 * Build an update payload over the two mutable fields of a kind. At least one
 * field is always present (an empty update would be a no-op and is out of scope
 * for a "round-trip the submitted value" property). Each field is independently
 * present, exercising both full updates and partial (single-field) updates.
 */
function updateArb<K1 extends string, K2 extends string>(
  key1: K1,
  key2: K2,
): fc.Arbitrary<Partial<Record<K1 | K2, string>>> {
  return fc
    .record({
      includeFirst: fc.boolean(),
      includeSecond: fc.boolean(),
      first: fieldValueArb,
      second: fieldValueArb,
    })
    .map(({ includeFirst, includeSecond, first, second }) => {
      // Guarantee at least one field is present.
      const useFirst = includeFirst || !includeSecond;
      const useSecond = includeSecond;
      const update: Partial<Record<K1 | K2, string>> = {};
      if (useFirst) {
        update[key1] = first;
      }
      if (useSecond) {
        update[key2] = second;
      }
      return update;
    });
}

describe('SettingService update round-trip (property)', () => {
  it('Feature: novel-writing-agent, Property 12: 设定条目更新往返', async () => {
    await fc.assert(
      fc.asyncProperty(
        // character initial fields
        fc.record({ name: fieldValueArb, description: fieldValueArb }),
        updateArb('name', 'description'),
        // worldSetting initial fields
        fc.record({ title: fieldValueArb, content: fieldValueArb }),
        updateArb('title', 'content'),
        // outline initial fields
        fc.record({ title: fieldValueArb, content: fieldValueArb }),
        updateArb('title', 'content'),
        async (charInit, charUpdate, worldInit, worldUpdate, outlineInit, outlineUpdate) => {
          const dir = await mkdtemp(join(tmpdir(), 'setting-update-prop-'));
          try {
            const store = await FileDataStore.create(join(dir, 'store.json'));
            const service = new SettingService(store);
            const project = await store.createProject('小说项目');
            const projectId = project.id;

            // --- character: { name, description } ---
            {
              const created = await service.characters.create(
                projectId,
                charInit.name,
                charInit.description,
              );
              await service.characters.update(created.id, charUpdate);

              const list = await service.characters.list(projectId);
              const persisted = list.find((c) => c.id === created.id);
              expect(persisted).toBeDefined();

              const expectedName =
                'name' in charUpdate ? (charUpdate.name as string) : charInit.name;
              const expectedDescription =
                'description' in charUpdate
                  ? (charUpdate.description as string)
                  : charInit.description;
              expect(persisted?.name).toBe(expectedName);
              expect(persisted?.description).toBe(expectedDescription);
            }

            // --- worldSetting: { title, content } ---
            {
              const created = await service.worldSettings.create(
                projectId,
                worldInit.title,
                worldInit.content,
              );
              await service.worldSettings.update(created.id, worldUpdate);

              const list = await service.worldSettings.list(projectId);
              const persisted = list.find((w) => w.id === created.id);
              expect(persisted).toBeDefined();

              const expectedTitle =
                'title' in worldUpdate ? (worldUpdate.title as string) : worldInit.title;
              const expectedContent =
                'content' in worldUpdate
                  ? (worldUpdate.content as string)
                  : worldInit.content;
              expect(persisted?.title).toBe(expectedTitle);
              expect(persisted?.content).toBe(expectedContent);
            }

            // --- outline: { title, content } ---
            {
              const created = await service.outlines.create(
                projectId,
                outlineInit.title,
                outlineInit.content,
              );
              await service.outlines.update(created.id, outlineUpdate);

              const list = await service.outlines.list(projectId);
              const persisted = list.find((o) => o.id === created.id);
              expect(persisted).toBeDefined();

              const expectedTitle =
                'title' in outlineUpdate
                  ? (outlineUpdate.title as string)
                  : outlineInit.title;
              const expectedContent =
                'content' in outlineUpdate
                  ? (outlineUpdate.content as string)
                  : outlineInit.content;
              expect(persisted?.title).toBe(expectedTitle);
              expect(persisted?.content).toBe(expectedContent);
            }
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  },
  // Each of the 100 runs performs real filesystem I/O (mkdtemp + atomic writes)
  // across all three setting kinds, so allow a generous timeout beyond the 5s
  // vitest default.
  30000);
});
