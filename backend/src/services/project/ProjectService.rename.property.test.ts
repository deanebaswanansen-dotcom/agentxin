/**
 * Property-based test for {@link ProjectService.rename} (task 3.4).
 *
 * Covers design.md Correctness **Property 3: 项目重命名往返** (Requirement 1.4):
 * for any already-existing project and any non-empty new name, after renaming
 * the project, the name read back equals that new name EXACTLY — including any
 * surrounding whitespace, since the service persists the name as provided and
 * does not trim it.
 *
 * Method (design.md Testing Strategy): exercised end-to-end against a REAL
 * {@link FileDataStore} backed by a unique temp file per run (no mocks), so the
 * round-trip goes through the same persistence layer used in production. The
 * value is read back two independent ways — `store.getProject` and
 * `service.list` — and both must report the new name verbatim.
 *
 * Uses fast-check with 100 runs. The name generator guarantees a non-whitespace
 * core (so the name passes the service's non-empty validation) while covering
 * Unicode/CJK/emoji, special characters, surrounding whitespace and long
 * strings.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { FileDataStore } from '../../store/FileDataStore.js';
import { ProjectService } from './ProjectService.js';

const NUM_RUNS = 100;

/** Track every temp dir created so we can clean them all up at the end. */
const createdDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    createdDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** At least one guaranteed-visible (non-whitespace) character. */
const visibleCharArb: fc.Arbitrary<string> = fc.constantFrom(
  'a',
  'Z',
  '9',
  '字',
  '界',
  '😀',
  '★',
  '#',
  '_',
  '-',
);

/** Body text covering the required edge classes (may be empty / whitespace). */
const bodyArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.string({ unit: 'binary' }),
  fc.constantFrom(
    '',
    'Hello',
    '我的小说',
    '日本語のテキスト',
    '😀🎉👨‍👩‍👧‍👦',
    'a"b\\c',
    'line1\nline2\r\nline3',
    '<tag>&amp;',
  ),
  fc.string({ minLength: 100, maxLength: 300 }),
);

/** Optional surrounding whitespace, to exercise the "not trimmed" guarantee. */
const surroundingWsArb: fc.Arbitrary<string> = fc.constantFrom(
  '',
  ' ',
  '  ',
  '\t',
  '\n',
  ' \t ',
  '   ',
);

/**
 * A non-empty project name (passes `ProjectService` validation because it
 * always contains at least one visible character), with optional leading and
 * trailing whitespace so the round-trip is checked verbatim, not trimmed.
 */
const nameArb: fc.Arbitrary<string> = fc
  .tuple(surroundingWsArb, visibleCharArb, bodyArb, surroundingWsArb)
  .map(([lead, core, body, trail]) => lead + core + body + trail);

describe('ProjectService.rename property tests', () => {
  it('Feature: novel-writing-agent, Property 3: 项目重命名往返', async () => {
    await fc.assert(
      fc.asyncProperty(nameArb, nameArb, async (initialName, newName) => {
        // Fresh store over a unique temp file per run (real persistence layer).
        const dir = await mkdtemp(join(tmpdir(), 'project-rename-prop-'));
        createdDirs.push(dir);
        const file = join(dir, 'store.json');

        try {
          const store = await FileDataStore.create(file);
          const service = new ProjectService(store);

          // Arrange: create the project under an initial non-empty name.
          const created = await service.create(initialName);

          // Act: rename it to the new non-empty name.
          await service.rename(created.id, newName);

          // Assert: the name read back equals the new name EXACTLY (not trimmed),
          // verified independently via the store and via the service list.
          const readBack = await store.getProject(created.id);
          expect(readBack?.name).toBe(newName);

          const listed = (await service.list()).find((p) => p.id === created.id);
          expect(listed?.name).toBe(newName);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
