/**
 * Property-based test for {@link parseBlueprintFromText} on text that contains
 * no extractable, valid JSON object.
 *
 * Covers design.md Correctness **Property 3: 非法 JSON 文本解析报错**
 * (task 3.4; Validates: Requirements 3.4): *For any* text that has no
 * extractable balanced JSON object, `parseBlueprintFromText` throws a
 * {@link ServiceError} with `code === 'VALIDATION_ERROR'`.
 *
 * The parser locates the first balanced `{...}` block by brace-pair scanning.
 * To guarantee "no extractable JSON object", the generators produce plain text
 * that contains NO brace characters at all (`{` / `}`). With no `{`, extraction
 * fails outright and the parser must reject with VALIDATION_ERROR (需求 3.4).
 *
 * Uses fast-check with >= 100 runs. Generators cover ASCII, Unicode,
 * whitespace, emoji, JSON-like-but-brace-free strings and longer text.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { parseBlueprintFromText } from './blueprintParser.js';
import { isServiceError } from '../ServiceError.js';
import { ERROR_CODES } from '../../types/index.js';

const NUM_RUNS = 200;

/**
 * Brace-free text generator. Any '{' or '}' is stripped so the text can never
 * contain an extractable JSON object (the property's precondition). Covers
 * ASCII (incl. empty), Unicode, whitespace, emoji, bracket/colon noise that
 * looks JSON-ish without braces, and longer strings.
 */
const braceFreeTextArb: fc.Arbitrary<string> = fc
  .oneof(
    fc.string(),
    fc.string({ unit: 'grapheme' }),
    fc.string({ unit: 'binary' }),
    fc.constantFrom(
      '',
      ' ',
      '\n\t  \r\n',
      '这不是 JSON，只是一段普通说明文字。',
      'No JSON here, just prose.',
      'key: value, another: thing',
      '[1, 2, 3] looks like an array but has no object',
      '"a quoted string with no object"',
      'chapter_id title target_words scenes',
      '日本語のテキストです',
      '😀🎉👨‍👩‍👧‍👦',
    ),
    fc.string({ minLength: 200, maxLength: 600 }),
  )
  // Remove every brace so no balanced JSON object can be extracted.
  .map((s) => s.replace(/[{}]/g, ''));

describe('blueprintParser invalid-text property test', () => {
  it('Feature: chapter-blueprint, Property 3: 非法 JSON 文本解析报错', () => {
    fc.assert(
      fc.property(braceFreeTextArb, (text) => {
        let thrown: unknown;
        try {
          parseBlueprintFromText(text);
        } catch (error) {
          thrown = error;
        }

        // Must reject (never return) and the error must be a VALIDATION_ERROR.
        expect(isServiceError(thrown)).toBe(true);
        expect((thrown as { code: string }).code).toBe(
          ERROR_CODES.VALIDATION_ERROR,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
