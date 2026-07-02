/**
 * Property-based test for {@link FileDataStore} scene-draft write isolation
 * (task 2.8).
 *
 * Covers design.md Correctness **Property 14: 场景正文写入仅影响目标场景**
 * (Validates: Requirements 11.5, 12.3): *For any* chapter with several scene
 * drafts persisted under distinct `sceneId`s, re-saving the draft of ONE scene
 * (as an expand/rewrite would) replaces ONLY that scene's content — every other
 * scene's persisted draft stays byte-for-byte unchanged.
 *
 * Method:
 *   1. Create a real project + chapter so drafts reference a genuine chapter
 *      primary key (`SceneDraft.chapterId`).
 *   2. Persist an initial draft for each of N distinct scene ids.
 *   3. Pick one scene id and re-save it with brand-new content (and a new
 *      `updatedAt`) — the upsert path exercised by scene rewrite/expand.
 *   4. Assert `getSceneDraft` returns the NEW draft for the target scene and the
 *      ORIGINAL draft (unchanged) for every other scene; cross-check the full
 *      `listSceneDrafts` snapshot against the expected per-scene map.
 *
 * Uses fast-check. Because every run performs real filesystem I/O (mkdtemp +
 * several atomic writes + recursive cleanup), runs are capped at 40 — enough to
 * exercise the generators' edge classes while keeping wall-clock reasonable.
 * Every run gets its OWN temp directory (created inside the predicate) which is
 * removed in a `finally` block, so runs never contaminate each other and no
 * leftover files remain.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { FileDataStore } from './FileDataStore.js';
import type { SceneDraft } from '../types/index.js';

// File I/O per run -> keep runs modest (design.md Testing Strategy: 文件 IO 取 30-50).
const NUM_RUNS = 40;

/**
 * Scene-draft content generator covering the required edge classes: empty,
 * pure-whitespace, full Unicode code points, printable graphemes/emoji,
 * hand-picked structural-marker strings, and longer strings.
 */
const contentArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.string({ unit: 'binary' }),
  fc.constantFrom(
    '',
    ' ',
    '\n',
    '\t',
    '   \n\t  ',
    '\u3000\u00a0', // 全角空格 + 不间断空格
    '第一段正文。\n\n第二段正文。',
    '林夜推开门，星光涌入。',
    '日本語の本文テキスト',
    '😀🎉👨‍👩‍👧‍👦',
    'line1\nline2\r\nline3',
    '"quoted" <tag> & ampersand \\backslash',
    '{"looks":"like json"}',
  ),
  fc.string({ minLength: 100, maxLength: 400 }),
);

/** High-entropy scene id so a unique 2–6 id set is easy to sample. */
const sceneIdArb: fc.Arbitrary<string> = fc.string({
  minLength: 1,
  maxLength: 16,
});

/** ISO-8601 timestamp arbitrary (stored verbatim by the store). */
const isoTimestampArb: fc.Arbitrary<string> = fc
  .date({
    min: new Date('2000-01-01T00:00:00.000Z'),
    max: new Date('2100-01-01T00:00:00.000Z'),
  })
  .map((d) => d.toISOString());

interface SceneSpec {
  sceneId: string;
  content: string;
  updatedAt: string;
}

const sceneSpecArb: fc.Arbitrary<SceneSpec> = fc.record({
  sceneId: sceneIdArb,
  content: contentArb,
  updatedAt: isoTimestampArb,
});

describe('FileDataStore scene-draft write isolation property test', () => {
  it('Feature: chapter-blueprint, Property 14: 场景正文写入仅影响目标场景', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          // 2–6 scenes with DISTINCT sceneId so "only the target changes" is
          // observable against at least one untouched neighbour.
          scenes: fc.uniqueArray(sceneSpecArb, {
            minLength: 2,
            maxLength: 6,
            selector: (s) => s.sceneId,
          }),
          // Which scene to rewrite (mod length, resolved in the predicate).
          targetSelector: fc.nat(),
          // New content + timestamp for the rewritten target scene.
          newContent: contentArb,
          newUpdatedAt: isoTimestampArb,
        }),
        async ({ scenes, targetSelector, newContent, newUpdatedAt }) => {
          const dir = await mkdtemp(join(tmpdir(), 'fds-scene-iso-'));
          const file = join(dir, 'store.json');
          try {
            const store = await FileDataStore.create(file);
            const project = await store.createProject('p');
            const chapter = await store.createChapter(project.id, 'c');

            // Expected per-scene draft map, kept in lock-step with the store.
            const expected = new Map<string, SceneDraft>();

            // 1. Persist the initial draft for every scene.
            for (const spec of scenes) {
              const draft: SceneDraft = {
                chapterId: chapter.id,
                sceneId: spec.sceneId,
                content: spec.content,
                updatedAt: spec.updatedAt,
              };
              await store.saveSceneDraft(draft);
              expected.set(spec.sceneId, draft);
            }

            // 2. Re-save (upsert) ONE scene with brand-new content, mirroring
            //    what an expand/rewrite does (Requirements 11.5 / 12.3).
            const target = scenes[targetSelector % scenes.length];
            const rewritten: SceneDraft = {
              chapterId: chapter.id,
              sceneId: target.sceneId,
              content: newContent,
              updatedAt: newUpdatedAt,
            };
            await store.saveSceneDraft(rewritten);
            expected.set(target.sceneId, rewritten);

            // 3. The target reads back the NEW draft; every other scene reads
            //    back its ORIGINAL draft, unchanged.
            for (const [sceneId, draft] of expected) {
              const readBack = await store.getSceneDraft(chapter.id, sceneId);
              expect(readBack).toEqual(draft);
            }

            // 4. Cross-check the full snapshot: same set of drafts, no extras,
            //    none of the untouched scenes mutated.
            const listed = await store.listSceneDrafts(chapter.id);
            expect(listed).toHaveLength(expected.size);
            const listedById = new Map(listed.map((d) => [d.sceneId, d]));
            for (const [sceneId, draft] of expected) {
              expect(listedById.get(sceneId)).toEqual(draft);
            }
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 120_000);
});
