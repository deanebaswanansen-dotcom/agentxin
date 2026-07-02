/**
 * Property-based test for {@link parseBlueprintFromText} extraction from text
 * that carries extra explanatory prose around the blueprint JSON.
 *
 * Covers design.md Correctness **Property 2: 从夹带文字的文本中提取蓝图**
 * (task 3.3; Validates: Requirements 3.1): *For any* valid {@link BlueprintCore}
 * `core` and any explanatory prefix `p` / suffix `q`, parsing
 * `p + serializeBlueprint(core) + q` must still yield an object whose every
 * chapter-level and scene-level field equals `core`.
 *
 * IMPORTANT test premise: the parser extracts the *first balanced* JSON object
 * by brace-pair scanning. Any `{` or `}` inside the prefix/suffix would change
 * where extraction starts/ends and corrupt the result, so the prose generators
 * deliberately EXCLUDE the brace characters `{` and `}`. This is a precondition
 * of the property, not a parser limitation under test here.
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
 * Text generator for blueprint *field values*: covers ASCII (incl. empty),
 * full Unicode code points, graphemes/emoji, hand-picked whitespace /
 * structural-marker strings, and longer strings. Field values MAY contain
 * braces — the parser correctly skips braces inside JSON string literals.
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
    '"quoted" <tag> & {braces} \\backslash',
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
 * A field-valid {@link BlueprintCore} (>= 1 scene). Structural rules (scene
 * count / deviation / uniqueness) are out of scope — the parser only checks
 * field presence & basic types.
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

/**
 * Prose generator for the surrounding prefix/suffix. MUST exclude '{' and '}'
 * (see file header): braces in the prose would shift the balanced-object
 * extraction window. Covers ASCII, Unicode, whitespace, emoji and longer text,
 * plus realistic LLM preamble/epilogue phrases — all brace-free.
 */
const proseArb: fc.Arbitrary<string> = fc
  .oneof(
    fc.string(),
    fc.string({ unit: 'grapheme' }),
    fc.constantFrom(
      '',
      ' ',
      '\n\n',
      '好的，这是你要的章节蓝图：\n',
      '以下为生成结果，请查收。',
      'Here is the blueprint you requested:\n\n',
      '\n\n希望对你有帮助！',
      'はい、こちらが章のブループリントです：',
      '😀 done 🎉',
      '```json\n', // note: contains no braces, only a code fence marker
      '\n```\n说明结束。',
    ),
    fc.string({ minLength: 100, maxLength: 300 }),
  )
  // Strip any brace characters to honor the property's precondition.
  .map((s) => s.replace(/[{}]/g, ''));

describe('blueprintParser extraction-from-prose property test', () => {
  it('Feature: chapter-blueprint, Property 2: 从夹带文字的文本中提取蓝图', () => {
    fc.assert(
      fc.property(
        proseArb,
        blueprintCoreArb,
        proseArb,
        (prefix, core, suffix) => {
          const text = prefix + serializeBlueprint(core) + suffix;
          const parsed = parseBlueprintFromText(text);

          // Every chapter-level & scene-level field is reproduced exactly.
          expect(parsed).toEqual(core);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
