/**
 * Property-based test for {@link parseBlueprintFromText} on JSON objects that
 * are missing a required chapter-level or scene-level field.
 *
 * Covers design.md Correctness **Property 4: 缺失字段解析报错** (task 3.5;
 * Validates: Requirements 3.5): *For any* valid blueprint object, deleting any
 * single required chapter-level field, or any single required scene-level field
 * of any scene, then `JSON.stringify`-ing the result, makes
 * `parseBlueprintFromText` throw a {@link ServiceError} with
 * `code === 'VALIDATION_ERROR'`.
 *
 * Uses fast-check with >= 100 runs. Generators cover special characters,
 * whitespace, Unicode, empty arrays, longer strings and positive-integer word
 * counts.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { parseBlueprintFromText } from './blueprintParser.js';
import { isServiceError } from '../ServiceError.js';
import { ERROR_CODES } from '../../types/index.js';
import type { BlueprintCore, Scene } from '../../types/index.js';

const NUM_RUNS = 200;

/** All required chapter-level field names (需求 2.3). */
const CHAPTER_FIELDS: ReadonlyArray<keyof BlueprintCore> = [
  'chapter_id',
  'title',
  'target_words',
  'main_goal',
  'tone',
  'pacing',
  'required_plot_points',
  'forbidden_points',
  'emotional_curve',
  'scenes',
  'ending_hook',
];

/** All required scene-level field names (需求 2.4). */
const SCENE_FIELDS: ReadonlyArray<keyof Scene> = [
  'scene_id',
  'name',
  'target_words',
  'location',
  'characters',
  'purpose',
  'emotion',
  'pacing',
  'must_include',
  'ending_state',
];

/** Text generator covering ASCII/Unicode/whitespace/emoji/long edge classes. */
const textArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.constantFrom(
    '',
    ' ',
    '\n',
    '第一章',
    '日本語のテキスト',
    '😀🎉👨‍👩‍👧‍👦',
    'line1\nline2',
  ),
  fc.string({ minLength: 200, maxLength: 400 }),
);

const stringArrayArb: fc.Arbitrary<string[]> = fc.array(textArb, {
  maxLength: 5,
});

const positiveIntArb: fc.Arbitrary<number> = fc.integer({
  min: 1,
  max: 1_000_000,
});

const sceneArb: fc.Arbitrary<Scene> = fc.record({
  scene_id: textArb,
  name: textArb,
  target_words: positiveIntArb,
  location: textArb,
  characters: stringArrayArb,
  purpose: textArb,
  emotion: textArb,
  pacing: textArb,
  must_include: stringArrayArb,
  ending_state: textArb,
});

const blueprintCoreArb: fc.Arbitrary<BlueprintCore> = fc.record({
  chapter_id: textArb,
  title: textArb,
  target_words: positiveIntArb,
  main_goal: textArb,
  tone: textArb,
  pacing: textArb,
  required_plot_points: stringArrayArb,
  forbidden_points: stringArrayArb,
  emotional_curve: textArb,
  scenes: fc.array(sceneArb, { minLength: 1, maxLength: 7 }),
  ending_hook: textArb,
});

/** Assert that parsing `value` rejects with a VALIDATION_ERROR. */
function expectValidationError(value: unknown): void {
  let thrown: unknown;
  try {
    parseBlueprintFromText(JSON.stringify(value));
  } catch (error) {
    thrown = error;
  }
  expect(isServiceError(thrown)).toBe(true);
  expect((thrown as { code: string }).code).toBe(ERROR_CODES.VALIDATION_ERROR);
}

describe('blueprintParser missing-fields property test', () => {
  it('Feature: chapter-blueprint, Property 4: 缺失字段解析报错', () => {
    fc.assert(
      fc.property(
        blueprintCoreArb,
        // Index into CHAPTER_FIELDS choosing which chapter-level field to drop.
        fc.nat({ max: CHAPTER_FIELDS.length - 1 }),
        (core, chapterFieldIndex) => {
          const field = CHAPTER_FIELDS[chapterFieldIndex];
          // Drop one required chapter-level field, then serialize & parse.
          const mutated: Record<string, unknown> = { ...core };
          delete mutated[field as string];

          expectValidationError(mutated);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('Feature: chapter-blueprint, Property 4: 缺失字段解析报错 (scene-level)', () => {
    fc.assert(
      fc.property(
        blueprintCoreArb,
        // Choose which scene to mutate and which scene-level field to drop.
        fc.nat(),
        fc.nat({ max: SCENE_FIELDS.length - 1 }),
        (core, sceneSelector, sceneFieldIndex) => {
          const sceneIndex = sceneSelector % core.scenes.length;
          const field = SCENE_FIELDS[sceneFieldIndex];

          const mutatedScenes = core.scenes.map((scene, i) => {
            if (i !== sceneIndex) {
              return scene;
            }
            const copy: Record<string, unknown> = { ...scene };
            delete copy[field as string];
            return copy;
          });

          const mutated = { ...core, scenes: mutatedScenes };
          expectValidationError(mutated);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
