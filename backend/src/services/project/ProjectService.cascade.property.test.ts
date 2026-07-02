/**
 * Property-based test for project cascade deletion.
 *
 * Covers design.md Correctness **Property 2: 删除项目级联清除全部关联实体**
 * (task 3.3; Requirement 1.3): for ANY project plus an arbitrary number of
 * chapters, characters, world settings and outlines, deleting the project
 * removes the project itself AND all of its associated entities from the data
 * store — while leaving a second, unrelated ("survivor") project and ALL of its
 * entities completely intact.
 *
 * Method (design.md Testing Strategy):
 * - Real persistence: a {@link FileDataStore} over a UNIQUE temp file per run,
 *   exercising the actual cascade against loaded-from-state data rather than a
 *   fake. The project create/delete go through {@link ProjectService}
 *   (Requirements 1.1 / 1.3); the associated entities are seeded directly via
 *   the {@link DataStore} create* methods (no service wrappers for those yet).
 * - Two projects per run — a "target" (to be deleted) and a "survivor" (must
 *   remain). Both receive arbitrary counts (0..N) of every entity type so the
 *   empty-collection boundary is covered alongside non-empty ones.
 *
 * Generators cover ASCII, full Unicode, graphemes/emoji, whitespace, structural
 * markers, empty strings and long strings, per the property-testing config.
 * Runs >= 100 iterations. Fresh store/temp file per run, cleaned up afterwards.
 *
 * **Validates: Requirements 1.3**
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import type { DataStore } from '../../store/DataStore.js';
import type { Id } from '../../types/index.js';
import { FileDataStore } from '../../store/FileDataStore.js';
import { ProjectService } from './ProjectService.js';

const NUM_RUNS = 100;

/**
 * Field-value generator spanning the required edge classes: empty / whitespace,
 * ASCII, full Unicode, graphemes/emoji, structural markers and long strings.
 */
const fieldTextArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.constantFrom(
    '',
    ' ',
    '   ',
    '\n',
    '\t',
    'Hello world',
    '世界',
    '日本語のテキスト',
    '😀🎉👨‍👩‍👧‍👦',
    'line1\nline2\r\nline3',
    '<>&"\u0000\\',
  ),
  fc.string({ minLength: 200, maxLength: 400 }),
);

/**
 * Project name generator: always yields a name with at least one
 * non-whitespace character so {@link ProjectService.create} accepts it
 * (Requirement 1.5 is out of scope here). Prefixing with a Unicode literal
 * keeps the arbitrary suffix free to explore whitespace/Unicode without being
 * rejected as empty.
 */
const projectNameArb: fc.Arbitrary<string> = fc
  .string({ maxLength: 40 })
  .map((s) => `项目-${s}`);

interface EntitySeeds {
  chapters: string[]; // titles (content defaults to '' on create)
  characters: { name: string; description: string }[];
  worldSettings: { title: string; content: string }[];
  outlines: { title: string; content: string }[];
}

/** Arbitrary count (0..5) of each entity type, with arbitrary field values. */
const seedsArb: fc.Arbitrary<EntitySeeds> = fc.record({
  chapters: fc.array(fieldTextArb, { maxLength: 5 }),
  characters: fc.array(
    fc.record({ name: fieldTextArb, description: fieldTextArb }),
    { maxLength: 5 },
  ),
  worldSettings: fc.array(
    fc.record({ title: fieldTextArb, content: fieldTextArb }),
    { maxLength: 5 },
  ),
  outlines: fc.array(
    fc.record({ title: fieldTextArb, content: fieldTextArb }),
    { maxLength: 5 },
  ),
});

/** Seed all entity types for a project directly through the store. */
async function seedEntities(
  store: DataStore,
  projectId: Id,
  seeds: EntitySeeds,
): Promise<void> {
  for (const title of seeds.chapters) {
    await store.createChapter(projectId, title);
  }
  for (const c of seeds.characters) {
    await store.createCharacter(projectId, c.name, c.description);
  }
  for (const w of seeds.worldSettings) {
    await store.createWorldSetting(projectId, w.title, w.content);
  }
  for (const o of seeds.outlines) {
    await store.createOutline(projectId, o.title, o.content);
  }
}

/** Snapshot of every entity collection for a project (for unchanged checks). */
async function snapshot(store: DataStore, projectId: Id) {
  return {
    project: await store.getProject(projectId),
    chapters: await store.listChapters(projectId),
    characters: await store.listCharacters(projectId),
    worldSettings: await store.listWorldSettings(projectId),
    outlines: await store.listOutlines(projectId),
  };
}

describe('ProjectService cascade delete', () => {
  it('Feature: novel-writing-agent, Property 2: 删除项目级联清除全部关联实体', async () => {
    await fc.assert(
      fc.asyncProperty(
        projectNameArb,
        projectNameArb,
        seedsArb,
        seedsArb,
        async (targetName, survivorName, targetSeeds, survivorSeeds) => {
          // Fresh store backed by a unique temp file for this run.
          const dir = await mkdtemp(join(tmpdir(), 'pbt-cascade-'));
          const file = join(dir, 'store.json');
          try {
            const store = await FileDataStore.create(file);
            const service = new ProjectService(store);

            // Create both projects via the service (Requirement 1.1) and seed
            // each with arbitrary numbers of associated entities.
            const target = await service.create(targetName);
            const survivor = await service.create(survivorName);
            await seedEntities(store, target.id, targetSeeds);
            await seedEntities(store, survivor.id, survivorSeeds);

            // Capture the survivor's full state before the deletion.
            const survivorBefore = await snapshot(store, survivor.id);

            // Delete the target project (Requirement 1.3 — cascade).
            await service.remove(target.id);

            // --- Target project and ALL its entities are gone. ---
            expect(await store.getProject(target.id)).toBeUndefined();
            const projects = await store.listProjects();
            expect(projects.some((p) => p.id === target.id)).toBe(false);
            expect(await store.listChapters(target.id)).toEqual([]);
            expect(await store.listCharacters(target.id)).toEqual([]);
            expect(await store.listWorldSettings(target.id)).toEqual([]);
            expect(await store.listOutlines(target.id)).toEqual([]);

            // --- Survivor project and ALL its entities are untouched. ---
            expect(projects.some((p) => p.id === survivor.id)).toBe(true);
            const survivorAfter = await snapshot(store, survivor.id);
            expect(survivorAfter).toEqual(survivorBefore);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  },
  // Each of the 100 runs performs real filesystem I/O (mkdtemp + many atomic
  // writes seeding two projects' entities + recursive cleanup); under full-suite
  // parallel load this comfortably exceeds vitest's 5s default, so allow a
  // generous ceiling matching the other I/O-heavy property tests.
  30000);
});
