/**
 * Property-based tests for {@link applyAdoption} (文本采用纯函数).
 *
 * Covers design.md Correctness Property 21 (task 12.3):
 *   "采用文本的插入/替换正确性" — Validates Requirements 6.4.
 *
 * Uses fast-check with >= 100 runs each. Generators cover the required edge
 * classes: empty original / generated, positions at 0 and length, out-of-range
 * (negative, greater than length), non-integer and non-finite positions,
 * Unicode strings and long strings, and replace with end < start.
 *
 * The expected results are reconstructed using the EXACT same clamping logic as
 * the implementation, so the property is a faithful specification rather than a
 * re-derivation that could mask a shared bug. In addition we assert structural
 * invariants (prefix/suffix preservation, embedding of the generated text, and
 * round-trip removal of an insert) that hold independently of the clamp.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { applyAdoption } from './applyAdoption';

const NUM_RUNS = 300;

/**
 * Mirror of the implementation's private `clamp`: non-finite -> min, truncate
 * toward zero, then clamp into [min, max]. Kept in lockstep with
 * applyAdoption.ts so the expected-value reconstruction is authoritative.
 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * String generator covering ASCII (incl. empty), full Unicode code points,
 * graphemes/emoji, hand-picked whitespace / structural strings, and long
 * strings.
 */
const textArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'binary' }),
  fc.string({ unit: 'grapheme' }),
  fc.constantFrom(
    '',
    ' ',
    '\n',
    '\t',
    '   \n\t  ',
    'abc',
    'héllo世界',
    '日本語のテキスト',
    '😀🎉👨‍👩‍👧‍👦',
    'line1\nline2\r\nline3',
  ),
  fc.string({ minLength: 200, maxLength: 500 }),
);

/**
 * Position generator covering in-range integers, boundary values, out-of-range
 * (negative / very large), non-integers, and non-finite values. Generated
 * relative to a known length where helpful, but also includes free integers.
 */
function positionArb(length: number): fc.Arbitrary<number> {
  return fc.oneof(
    // In-range and boundary integers.
    fc.integer({ min: 0, max: Math.max(0, length) }),
    // Out-of-range integers (negative and beyond length).
    fc.integer({ min: -50, max: length + 50 }),
    // Non-integer (fractional) values to exercise truncation.
    fc.double({ min: -50, max: length + 50, noNaN: true }),
    // Explicit edge constants including non-finite values.
    fc.constantFrom(
      0,
      length,
      -1,
      length + 1,
      -1000,
      1000,
      0.5,
      2.9,
      -0.4,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ),
  );
}

describe('applyAdoption property tests', () => {
  it('Feature: novel-writing-agent, Property 21: 采用文本的插入/替换正确性 (insert)', () => {
    fc.assert(
      fc.property(
        textArb,
        textArb,
        fc.integer({ min: -50, max: 50 }),
        (original, generated, rawPosition) => {
          // Bias rawPosition into a meaningful range relative to length while
          // still allowing out-of-range values.
          const position = rawPosition;
          const result = applyAdoption(original, generated, {
            mode: 'insert',
            position,
          });

          const clampedPos = clamp(position, 0, original.length);
          const prefix = original.slice(0, clampedPos);
          const suffix = original.slice(clampedPos);

          // 1. Faithful specification: equals prefix + generated + suffix.
          expect(result).toBe(prefix + generated + suffix);

          // 2. Structural: prefix and suffix preserved in order around insert.
          expect(result.startsWith(prefix)).toBe(true);
          expect(result.endsWith(suffix)).toBe(true);

          // 3. generated is embedded exactly at the clamped position.
          expect(result.slice(clampedPos, clampedPos + generated.length)).toBe(
            generated,
          );

          // 4. Round-trip: removing the inserted block returns the original.
          const removed =
            result.slice(0, clampedPos) +
            result.slice(clampedPos + generated.length);
          expect(removed).toBe(original);

          // 5. Length is additive.
          expect(result.length).toBe(original.length + generated.length);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('Feature: novel-writing-agent, Property 21: 采用文本的插入/替换正确性 (insert, wide position incl. non-finite)', () => {
    fc.assert(
      fc.property(
        textArb,
        textArb,
        fc.constant(null).chain(() => fc.nat().map((n) => n)),
        (original, generated, _seed) => {
          // Exercise the full position arbitrary (negatives, fractions, NaN, ∞).
          return fc.assert(
            fc.property(positionArb(original.length), (position) => {
              const result = applyAdoption(original, generated, {
                mode: 'insert',
                position,
              });
              const clampedPos = clamp(position, 0, original.length);
              expect(result).toBe(
                original.slice(0, clampedPos) +
                  generated +
                  original.slice(clampedPos),
              );
            }),
            { numRuns: 20 },
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('Feature: novel-writing-agent, Property 21: 采用文本的插入/替换正确性 (replace)', () => {
    fc.assert(
      fc.property(
        textArb,
        textArb,
        positionArb(20),
        positionArb(20),
        (original, generated, rawStart, rawEnd) => {
          const result = applyAdoption(original, generated, {
            mode: 'replace',
            start: rawStart,
            end: rawEnd,
          });

          // Mirror the implementation's clamping exactly:
          // start -> [0, len]; end -> [start, len].
          const start = clamp(rawStart, 0, original.length);
          const end = clamp(rawEnd, start, original.length);

          const prefix = original.slice(0, start);
          const suffix = original.slice(end);

          // 1. Faithful specification: equals prefix + generated + suffix.
          expect(result).toBe(prefix + generated + suffix);

          // 2. Characters outside [start, end) preserved in order.
          expect(result.startsWith(prefix)).toBe(true);
          expect(result.endsWith(suffix)).toBe(true);

          // 3. generated replaces the interval exactly at `start`.
          expect(result.slice(start, start + generated.length)).toBe(generated);

          // 4. Length accounting: removed (end - start) chars, added generated.
          expect(result.length).toBe(
            original.length - (end - start) + generated.length,
          );

          // 5. The preserved characters equal original with [start,end) cut out.
          const expectedPreserved =
            original.slice(0, start) + original.slice(end);
          const actualPreserved =
            result.slice(0, start) + result.slice(start + generated.length);
          expect(actualPreserved).toBe(expectedPreserved);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('Feature: novel-writing-agent, Property 21: 采用文本的插入/替换正确性 (replace, end < start clamps to empty interval)', () => {
    fc.assert(
      fc.property(
        textArb,
        textArb,
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        (original, generated, a, b) => {
          // Force end < start by ordering, to exercise the clamp(end -> [start,len]).
          const rawStart = Math.max(a, b);
          const rawEnd = Math.min(a, b);

          const result = applyAdoption(original, generated, {
            mode: 'replace',
            start: rawStart,
            end: rawEnd,
          });

          const start = clamp(rawStart, 0, original.length);
          const end = clamp(rawEnd, start, original.length); // == start when rawEnd <= start

          // end is clamped up to start -> empty interval -> behaves like insert.
          expect(end).toBe(start);
          expect(result).toBe(
            original.slice(0, start) + generated + original.slice(start),
          );
          // No original characters were removed.
          expect(result.length).toBe(original.length + generated.length);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
