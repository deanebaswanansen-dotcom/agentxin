/**
 * Property-based test for {@link SettingService} deletion (task 5.4).
 *
 * Covers design.md Correctness **Property 13: 删除设定条目仅影响目标条目**
 * (Requirement 3.6):
 *
 *   For any 项目某类型的设定条目集合与其中任一条目，删除该条目后其不再存在，
 *   且同类型其余条目保持不变。
 *
 * **Validates: Requirements 3.6**
 *
 * Method (design.md Testing Strategy): exercised end-to-end through a REAL
 * {@link FileDataStore} backed by a unique temp file per run (no mocks), with a
 * project created first. The property is checked independently for each of the
 * three setting kinds (characters / worldSettings / outlines). For each run we
 * create N (>= 1) entries with arbitrary field values, snapshot the survivors'
 * identity + fields, delete one randomly chosen entry via the service, then
 * assert:
 *   1. the deleted entry is gone from the kind's list;
 *   2. the list shrank by exactly one;
 *   3. every surviving entry of the SAME kind is unchanged (id + all fields).
 *
 * Uses fast-check with >= 100 runs. Generators cover ASCII, Unicode, emoji,
 * whitespace, empty and long strings for every field (no non-empty constraint
 * applies to setting fields — see SettingService docs).
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
 * Each kind runs NUM_RUNS iterations of real temp-file I/O, so the default 5s
 * vitest timeout is too tight (the first kind also pays cold-start cost). Give
 * each property a generous ceiling well above observed run times.
 */
const TEST_TIMEOUT_MS = 30_000;

/**
 * Generator for an arbitrary setting field value. Exercises empty, whitespace,
 * special characters, Unicode, emoji and longer strings — the service applies
 * no non-empty validation, so any string is a valid field value.
 */
const fieldArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme', maxLength: 40 }),
  fc.constantFrom(
    '',
    ' ',
    '\t',
    '\n',
    '林夜',
    '沉默的剑客',
    '以星辰为源',
    'line1\nline2\r\nline3',
    '"quoted" \\ slash',
    '😀🎉👨‍👩‍👧‍👦',
    '日本語',
  ),
  fc.string({ minLength: 100, maxLength: 300 }),
);

/** A pair of arbitrary field values (each kind's create takes two fields). */
interface EntrySpec {
  a: string;
  b: string;
}

const entrySpecArb: fc.Arbitrary<EntrySpec> = fc.record({
  a: fieldArb,
  b: fieldArb,
});

/** At least one entry so there is always a deletion target. */
const specsArb: fc.Arbitrary<EntrySpec[]> = fc.array(entrySpecArb, {
  minLength: 1,
  maxLength: 8,
});

/**
 * Describes one setting kind so the property can be run uniformly across
 * characters / worldSettings / outlines. `api` selects the sub-namespace,
 * `fieldKeys` lists the user-supplied field names to compare for equality.
 */
interface KindConfig {
  label: string;
  api: (
    service: SettingService,
  ) => {
    create: (projectId: string, a: string, b: string) => Promise<{ id: string }>;
    list: (projectId: string) => Promise<Array<{ id: string }>>;
    remove: (id: string) => Promise<void>;
  };
  /** Fields (besides id) whose values must remain unchanged for survivors. */
  fieldKeys: string[];
}

const KINDS: KindConfig[] = [
  {
    label: 'characters',
    api: (service) => service.characters,
    fieldKeys: ['projectId', 'name', 'description'],
  },
  {
    label: 'worldSettings',
    api: (service) => service.worldSettings,
    fieldKeys: ['projectId', 'title', 'content'],
  },
  {
    label: 'outlines',
    api: (service) => service.outlines,
    fieldKeys: ['projectId', 'title', 'content', 'position'],
  },
];

describe('SettingService delete (property)', () => {
  for (const kind of KINDS) {
    it(`Feature: novel-writing-agent, Property 13: 删除设定条目仅影响目标条目 [${kind.label}]`, async () => {
      await fc.assert(
        fc.asyncProperty(specsArb, fc.nat(), async (specs, selector) => {
          // Fresh store + temp file per run for full isolation.
          const dir = await mkdtemp(join(tmpdir(), 'setting-delete-prop-'));
          try {
            const store = await FileDataStore.create(join(dir, 'store.json'));
            const service = new SettingService(store);
            const project = await store.createProject('小说项目');
            const projectId = project.id;
            const api = kind.api(service);

            // Create the entries with arbitrary field values.
            for (const spec of specs) {
              await api.create(projectId, spec.a, spec.b);
            }

            // Snapshot the full set before deletion.
            const before = await api.list(projectId);
            expect(before.length).toBe(specs.length);

            // Pick a random entry to delete.
            const targetIndex = selector % before.length;
            const target = before[targetIndex];

            // Capture the survivors' full identity + fields before deletion.
            const survivors = before.filter((e) => e.id !== target.id);

            await api.remove(target.id);

            const after = await api.list(projectId);

            // 1. The deleted entry no longer exists in the kind's list.
            expect(after.some((e) => e.id === target.id)).toBe(false);

            // 2. The list shrank by exactly one.
            expect(after.length).toBe(before.length - 1);

            // 3. Every surviving entry of the SAME kind is unchanged
            //    (id + all fields), and nothing else was removed/added.
            expect(new Set(after.map((e) => e.id))).toEqual(
              new Set(survivors.map((e) => e.id)),
            );
            for (const expected of survivors) {
              const found = after.find((e) => e.id === expected.id);
              expect(found).toBeDefined();
              for (const key of kind.fieldKeys) {
                expect((found as Record<string, unknown>)[key]).toBe(
                  (expected as Record<string, unknown>)[key],
                );
              }
            }
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }),
        { numRuns: NUM_RUNS },
      );
    }, TEST_TIMEOUT_MS);
  }
});
