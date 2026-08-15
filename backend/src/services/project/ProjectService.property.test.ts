/**
 * Property-based test for {@link ProjectService} (task 3.2).
 *
 * Covers design.md Correctness **Property 1: 项目创建-读回往返与唯一性**
 * (Requirements 1.1, 1.2):
 *
 *   For any sequence of projects with non-empty names, after creating them in
 *   order, every returned identifier is unique, and the project list contains
 *   exactly those created projects' identifiers and names.
 *
 * Method (design.md Testing Strategy): exercised end-to-end against the real
 * {@link FileDataStore} that {@link ProjectService} wraps. Each fast-check run
 * gets its OWN fresh store backed by a unique file inside a single shared temp
 * directory; the directory is created once (`beforeAll`) and removed once
 * (`afterAll`) with `rm({ recursive: true, force: true })`. Creating the
 * directory once — rather than `mkdtemp` + `rm -r` on every run — avoids heavy
 * per-run directory churn that is sensitive to transient `EPERM`/`EBUSY`
 * rename failures on Windows (e.g. antivirus scanning freshly created files),
 * while still giving every run an isolated, fresh store file. Using the
 * file-backed store rather than an in-memory fake verifies the round-trip
 * survives JSON serialization and disk persistence.
 *
 * Insertion order: `FileDataStore.listProjects` maps its backing array in push
 * order and `ProjectService.list` forwards it unchanged, so the list order
 * equals creation order; the assertion therefore compares the ordered list.
 *
 * Uses fast-check with 100 runs. The name generator covers ASCII, full
 * Unicode, graphemes/emoji, surrounding whitespace and long strings, always
 * keeping at least one non-whitespace character so the name is valid
 * (non-empty after trim) per Requirement 1.5.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';

import { FileDataStore } from '../../store/FileDataStore.js';
import { ProjectService } from './ProjectService.js';

const NUM_RUNS = 100;

/**
 * A non-whitespace "core" fragment: guarantees the generated name has at least
 * one non-whitespace character (so it is valid, i.e. non-empty after trim).
 * Covers ASCII, full Unicode, graphemes/emoji, structural markers and long
 * strings.
 */
const nonWhitespaceCore: fc.Arbitrary<string> = fc.oneof(
  fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
  fc.string({ unit: 'grapheme', minLength: 1 }).filter((s) => s.trim().length > 0),
  fc.constantFrom(
    'a',
    '我的小说',
    '世界',
    '日本語のタイトル',
    '😀🎉',
    '👨‍👩‍👧‍👦',
    '"quoted"',
    'back\\slash',
    'line1\nline2',
    'タブ\tタブ',
  ),
  fc
    .string({ minLength: 100, maxLength: 300 })
    .filter((s) => s.trim().length > 0),
);

/** Optional surrounding whitespace, to exercise whitespace-around names. */
const whitespacePad: fc.Arbitrary<string> = fc.constantFrom(
  '',
  ' ',
  '  ',
  '\t',
  '\n',
  '\u00A0',
  ' \t ',
);

/**
 * A valid (non-empty-after-trim) project name: a non-whitespace core with
 * optional whitespace padding on either side. Padding is preserved verbatim by
 * the service/store, so the round-trip must return the exact same string.
 */
const projectNameArb: fc.Arbitrary<string> = fc
  .tuple(whitespacePad, nonWhitespaceCore, whitespacePad)
  .map(([left, core, right]) => `${left}${core}${right}`);

/** A sequence of project names (may include duplicates — ids must still differ). */
const projectNamesArb: fc.Arbitrary<string[]> = fc.array(projectNameArb, {
  minLength: 0,
  maxLength: 8,
});

describe('ProjectService create/list', () => {
  // Single shared temp directory for the whole property run (created once,
  // removed once) — see file header for the rationale.
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'project-prop-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('Feature: novel-writing-agent, Property 1: 项目创建-读回往返与唯一性', async () => {
    await fc.assert(
      fc.asyncProperty(projectNamesArb, async (names) => {
        // Fresh store backed by a unique file (within the shared dir) per run.
        const store = await FileDataStore.create(
          join(dir, `${randomUUID()}.json`),
        );
        const service = new ProjectService(store);

        // Create each project in order, recording what was returned.
        const created = [];
        for (const name of names) {
          const project = await service.create(name);
          created.push(project);
        }

        // (1) All returned identifiers are unique.
        const ids = created.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);

        // Each created project must round-trip its name exactly as provided.
        for (let i = 0; i < names.length; i += 1) {
          expect(created[i].name).toBe(names[i]);
        }

        // (2) The list contains exactly the created {id, name} pairs, in
        // creation order (which the store preserves). The ordered deep-equal
        // simultaneously checks count, id→name mapping and order.
        const list = await service.list();
        expect(list).toEqual(created.map((p) => ({ id: p.id, name: p.name, kind: 'novel' })));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
