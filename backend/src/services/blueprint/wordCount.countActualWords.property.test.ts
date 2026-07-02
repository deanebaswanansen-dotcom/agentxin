/**
 * Property-based test for {@link countActualWords}.
 *
 * Covers design.md Correctness **Property 9: 实际字数等于去空白字符数** (task 5.2;
 * Validates: Requirements 9.1): *For any* string `s`, `countActualWords(s)`
 * equals the number of Unicode code points remaining after removing every
 * whitespace character, i.e. `[...s.replace(/\s/gu, '')].length`.
 *
 * Oracle strategy: the actual-word-count is defined (术语表 ActualWordCount,
 * 需求 9.1) as "remove all whitespace, count remaining characters by code
 * point". The oracle recomputes that definition directly with the spread
 * operator (code-point iteration), independently of the SUT's `Array.from`
 * implementation. Additional invariants (whitespace-only → 0; never exceeds the
 * total code-point count) further constrain correctness.
 *
 * Generators deliberately cover ASCII, full Unicode, emoji (incl. ZWJ
 * sequences and flags), every flavour of whitespace matched by `/\s/u`
 * (space / tab / CR / LF / FF / VT / NBSP / line & paragraph separators /
 * full-width space \u3000 / BOM), whitespace-only strings, and long strings.
 *
 * Uses fast-check with >= 100 runs.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { countActualWords } from './wordCount.js';

const NUM_RUNS = 300;

/** Independent oracle: code points left after stripping all Unicode whitespace. */
function expectedActualWords(text: string): number {
  return [...text.replace(/\s/gu, '')].length;
}

/**
 * Whitespace characters matched by JS `/\s/u`, including the easy-to-miss
 * full-width space (\u3000), NBSP (\u00A0), line/paragraph separators and BOM.
 */
const WHITESPACE_CHARS = [
  ' ',
  '\t',
  '\n',
  '\r',
  '\f',
  '\v',
  '\u00A0',
  '\u1680',
  '\u2028',
  '\u2029',
  '\u202F',
  '\u205F',
  '\u3000',
  '\uFEFF',
];

const whitespaceCharArb = fc.constantFrom(...WHITESPACE_CHARS);

/** Multi-byte characters & emoji, including grapheme clusters spanning code points. */
const richCharArb = fc.constantFrom(
  'a',
  'Z',
  '0',
  '汉',
  '字',
  'é',
  'ñ',
  'Ω',
  '😀',
  '👍',
  '🎉',
  '🍕',
  '🇯🇵', // flag: two regional-indicator code points
  '👨‍👩‍👧‍👦', // ZWJ family sequence: multiple code points
);

/** A grab-bag character: whitespace, rich char, or any single Unicode code point. */
const anyCharArb = fc.oneof(
  { weight: 3, arbitrary: whitespaceCharArb },
  { weight: 3, arbitrary: richCharArb },
  { weight: 2, arbitrary: fc.fullUnicode() },
  { weight: 2, arbitrary: fc.char() },
);

/** Mixed strings interleaving whitespace, ASCII, multi-byte chars and emoji. */
const mixedArb = fc
  .array(anyCharArb, { maxLength: 200 })
  .map((chars) => chars.join(''));

/** Long strings to exercise larger inputs. */
const longArb = fc
  .array(anyCharArb, { minLength: 300, maxLength: 800 })
  .map((chars) => chars.join(''));

/** Whitespace-only strings (expected count 0). */
const whitespaceOnlyArb = fc
  .array(whitespaceCharArb, { maxLength: 40 })
  .map((chars) => chars.join(''));

const textArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  whitespaceOnlyArb,
  fc.string(),
  fc.fullUnicodeString(),
  mixedArb,
  longArb,
);

describe('wordCount countActualWords property test', () => {
  it('Feature: chapter-blueprint, Property 9: 实际字数等于去空白字符数', () => {
    fc.assert(
      fc.property(textArb, (s) => {
        const actual = countActualWords(s);

        // Core definition: equals whitespace-stripped code-point count.
        expect(actual).toBe(expectedActualWords(s));

        // Invariant: never exceeds the total code-point count of the input.
        expect(actual).toBeLessThanOrEqual([...s].length);

        // Invariant: a non-negative integer.
        expect(Number.isInteger(actual)).toBe(true);
        expect(actual).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('Feature: chapter-blueprint, Property 9: 实际字数等于去空白字符数 (whitespace-only counts 0)', () => {
    fc.assert(
      fc.property(whitespaceOnlyArb, (s) => {
        expect(countActualWords(s)).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
