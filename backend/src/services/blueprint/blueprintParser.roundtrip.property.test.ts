/**
 * Property-based test for {@link serializeBlueprint} / {@link parseBlueprintFromText}.
 *
 * Covers design.md Correctness **Property 1: 蓝图序列化-解析往返** (task 3.2;
 * Validates: Requirements 3.2, 3.3): *For any* valid {@link BlueprintCore}
 * `core`, parsing its serialized form must reproduce a structurally identical
 * object whose every chapter-level and scene-level field value equals `core`.
 *
 * `serializeBlueprint` writes a stable schema-only field set via
 * `JSON.stringify`, and `parseBlueprintFromText` keeps only schema fields, so
 * the round trip is an exact identity over `BlueprintCore` — asserted here with
 * deep equality (`toEqual`), the strongest form of "every field equal".
 *
 * Uses fast-check with >= 100 runs. Generators cover special characters,
 * whitespace, Unicode, empty arrays, longer strings and positive-integer word
 * counts.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  serializeBlueprint,
  parseBlueprintFromText,
} from './blueprintParser.js';
import type { BlueprintCore, Scene } from '../../types/index.js';

const NUM_RUNS = 200;

/**
 * Text generator covering the required edge classes: ASCII (incl. empty),
 * full Unicode code points, printable graphemes/emoji, hand-picked
 * whitespace / structural-marker strings, and longer strings.
 */
const textArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.string({ unit: 'binary' }),
  fc.constantFrom(
    '',
    ' ',
    '\n',
    '\t',
    '   \n\t  ',
    '第一章',
    '林夜与星辰之海',
    '日本語のテキスト',
    '😀🎉👨‍👩‍👧‍👦',
    'line1\nline2\r\nline3',
    '"quoted" <tag> & ampersand \\backslash',
  ),
  fc.string({ minLength: 200, maxLength: 500 }),
);

/** Arbitrary string[] field (covers the empty-array edge via maxLength incl. 0). */
const stringArrayArb: fc.Arbitrary<string[]> = fc.array(textArb, {
  maxLength: 5,
});

/** Positive-integer word counts (parser only checks the `number` type here). */
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

/**
 * A structurally valid {@link BlueprintCore}: at least one scene (this suite
 * does NOT care about structural rules — scene count / deviation ratio /
 * scene_id uniqueness are `validateBlueprint`'s concern; the parser only checks
 * field presence & basic types).
 */
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

describe('blueprintParser serialize/parse round trip property test', () => {
  it('Feature: chapter-blueprint, Property 1: 蓝图序列化-解析往返', () => {
    fc.assert(
      fc.property(blueprintCoreArb, (core) => {
        const parsed = parseBlueprintFromText(serializeBlueprint(core));

        // Deep equality verifies every chapter-level and scene-level field
        // value (incl. arrays and nested scenes) is reproduced exactly.
        expect(parsed).toEqual(core);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
