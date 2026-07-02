/**
 * Property-based test for {@link ProjectService.create} name validation
 * (task 3.5).
 *
 * Covers design.md Correctness **Property 4: 空名称创建被拒绝且状态不变**
 * (Requirement 1.5): for any project name that is empty or consists solely of
 * whitespace characters, the create request is rejected with a
 * `VALIDATION_ERROR` and the project collection in the data store is left
 * unchanged.
 *
 * Method (design.md Testing Strategy): exercised end-to-end against a real
 * {@link FileDataStore} backed by a unique temp file per run (no mocks). Each
 * run pre-seeds the store with a few VALID projects, snapshots the project
 * list, attempts an invalid create, then asserts (a) the rejection carries
 * `VALIDATION_ERROR` and (b) the project list is byte-for-byte unchanged.
 *
 * Uses fast-check with 100 runs. The invalid-name generator only emits strings
 * that are empty after `trim()` — the empty string plus whitespace-only strings
 * built from a whitespace set ( ' ', '\t', '\n', NBSP, ... ) — so every
 * generated name is genuinely invalid per the service's `name.trim()` rule.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { FileDataStore } from '../../store/FileDataStore.js';
import { isServiceError } from '../ServiceError.js';
import { ProjectService } from './ProjectService.js';

const NUM_RUNS = 100;

/**
 * Whitespace code points that JavaScript `String.prototype.trim()` strips to
 * empty. Includes the ASCII set plus NBSP, ideographic space, line/paragraph
 * separators and BOM/ZWNBSP — verified to satisfy `c.trim().length === 0`.
 */
const WHITESPACE_CHARS = [
  ' ',
  '\t',
  '\n',
  '\r',
  '\f',
  '\v',
  '\u00A0', // NBSP
  '\u2003', // EM SPACE
  '\u2028', // LINE SEPARATOR
  '\u2029', // PARAGRAPH SEPARATOR
  '\u3000', // IDEOGRAPHIC SPACE
  '\uFEFF', // ZERO WIDTH NO-BREAK SPACE / BOM
] as const;

/**
 * Generates names that are invalid for {@link ProjectService.create}: either
 * the empty string or a non-empty string composed only of whitespace. All
 * outputs satisfy `name.trim().length === 0`.
 */
const emptyOrWhitespaceNameArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  fc.stringOf(fc.constantFrom(...WHITESPACE_CHARS), {
    minLength: 1,
    maxLength: 20,
  }),
);

/**
 * Generates a VALID project name (at least one non-whitespace character) by
 * appending a guaranteed non-whitespace character to arbitrary text, so the
 * pre-seed creations always succeed without filtering.
 */
const validNameArb: fc.Arbitrary<string> = fc
  .tuple(fc.string(), fc.constantFrom('A', '项', 'x', '9', '名', '私'))
  .map(([prefix, nonWs]) => prefix + nonWs);

/** A small set of valid projects used to assert state-invariance. */
const seedNamesArb: fc.Arbitrary<string[]> = fc.array(validNameArb, {
  maxLength: 4,
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pjt-empty-name-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ProjectService.create empty/whitespace name rejection', () => {
  it('Feature: novel-writing-agent, Property 4: 空名称创建被拒绝且状态不变', async () => {
    let counter = 0;
    await fc.assert(
      fc.asyncProperty(
        seedNamesArb,
        emptyOrWhitespaceNameArb,
        async (seedNames, invalidName) => {
          // Fresh store + unique temp file per run; cleaned up after the run.
          const file = join(dir, `store-${counter++}.json`);
          const store = await FileDataStore.create(file);
          const service = new ProjectService(store);

          // Pre-seed with a few valid projects to assert state-invariance.
          for (const name of seedNames) {
            await service.create(name);
          }
          const before = await service.list();

          // The invalid create must reject with a VALIDATION_ERROR.
          await expect(service.create(invalidName)).rejects.toSatisfy(
            (e: unknown) => isServiceError(e) && e.code === 'VALIDATION_ERROR',
          );

          // The project collection must be unchanged by the rejected create.
          const after = await service.list();
          expect(after).toEqual(before);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
