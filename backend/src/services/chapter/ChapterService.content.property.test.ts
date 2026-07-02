/**
 * Property-based test for chapter content update round-trip.
 *
 * Covers design.md Correctness **Property 8: 章节正文更新往返**
 * (task 4.4; Requirement 2.3): for any chapter and any content string —
 * including special characters, whitespace (tabs / newlines / CR), Unicode,
 * the empty string and long strings — calling
 * {@link ChapterService.updateContent} and then reading the chapter back must
 * return content exactly equal to the submitted content.
 *
 * **Validates: Requirements 2.3**
 *
 * Method (design.md Testing Strategy): end-to-end through a REAL
 * {@link FileDataStore} (no mocks) backed by a unique temp file per run. Each
 * run creates a fresh store, a project and a chapter, updates the content, then
 * asserts the round-trip three ways:
 *   1. the {@link Chapter} returned by `updateContent`,
 *   2. the value read back via `store.getChapter` from the same instance, and
 *   3. the value read back after reconstructing a NEW {@link FileDataStore}
 *      over the same file (persistence / restart recovery — the content must
 *      survive a reload, not merely live in memory).
 *
 * Uses fast-check with >= 100 runs. The content generator covers ASCII, full
 * Unicode, graphemes / emoji, whitespace, the empty string, JSON-breaking
 * characters and long strings.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { FileDataStore } from '../../store/FileDataStore.js';
import { ChapterService } from './ChapterService.js';

const NUM_RUNS = 100;

/**
 * Content generator covering the required edge classes:
 * - default Unicode strings (`fc.string`)
 * - grapheme clusters / emoji (combining marks, ZWJ sequences)
 * - the empty string and pure-whitespace strings (spaces, tabs, newlines, CR)
 * - characters that are significant to JSON serialization (quotes, backslash)
 * - LONG strings (up to a few thousand chars), incl. mixed Unicode.
 */
const contentArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.string({ unit: 'binary' }),
  fc.constantFrom(
    '',
    ' ',
    '\t',
    '\n',
    '\r\n',
    '   \t  \n\n  ',
    '正文内容',
    '第一章\n\n林深见鹿，海蓝见鲸。',
    '日本語のテキスト',
    '😀🎉👨‍👩‍👧‍👦',
    'line1\nline2\r\nline3\ttabbed',
    '"quoted"',
    'back\\slash',
    '{"json":"like","content":true}',
    '<tag>&amp;</tag>',
    '\u0000\u001f null & control chars',
  ),
  // Long strings (incl. mixed Unicode) to stress serialization round-trips.
  fc.string({ minLength: 1000, maxLength: 4000 }),
  fc
    .array(
      fc.constantFrom('世界', '😀', 'a', ' ', '\n', '\t', '«»', 'Ω≈ç'),
      { minLength: 200, maxLength: 600 },
    )
    .map((parts) => parts.join('')),
);

describe('ChapterService content update round-trip (property)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chapter-content-prop-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('Feature: novel-writing-agent, Property 8: 章节正文更新往返', async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(contentArb, async (content) => {
        // Fresh store + temp file per run so each case is fully isolated.
        run += 1;
        const filePath = join(dir, `store-${run}.json`);
        const store = await FileDataStore.create(filePath);
        const service = new ChapterService(store);

        const project = await store.createProject('小说项目');
        const chapter = await service.create(project.id, '第一章');

        // 1) Value returned by updateContent equals the submitted content.
        const updated = await service.updateContent(chapter.id, content);
        expect(updated.content).toBe(content);

        // 2) Re-read from the SAME store instance equals the submitted content.
        const reread = await store.getChapter(chapter.id);
        expect(reread?.content).toBe(content);

        // 3) Persistence: reconstruct a NEW store over the same file and
        //    confirm the content survived the reload (Requirement 7.3 backing
        //    2.3's "持久化到数据存储").
        const reloaded = await FileDataStore.create(filePath);
        const afterReload = await reloaded.getChapter(chapter.id);
        expect(afterReload?.content).toBe(content);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
