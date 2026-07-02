/**
 * Property-based test for {@link buildScenePrompt} (分场景写作提示词组装).
 *
 * Covers design.md Correctness **Property 17: 场景写作上下文包含蓝图与正文约束
 * （提示词组装）** (task 6.2; Validates: Requirements 6.1, 6.2, 6.3):
 *
 *   *For any* {@link ScenePromptInput}, the concatenation of every assembled
 *   message's `content` must contain, as verbatim substrings:
 *     - the target scene's `purpose`                       (需求 6.1)
 *     - every item of the scene's `must_include`           (需求 6.1)
 *     - the scene's `ending_state`                         (需求 6.1)
 *     - every appearing character's `description`          (需求 6.2)
 *     - the previous scene content, when present & non-empty (需求 6.3)
 *
 * Robustness / non-triviality strategy:
 *   - Fields whose presence we assert (`purpose`, `ending_state`, each
 *     `must_include` item, each character `description`, and the present
 *     `previousSceneContent`) are generated NON-EMPTY. A substring assertion
 *     against the empty string is vacuously true, so empty values would make the
 *     property meaningless; `minLength: 1` keeps every assertion with teeth.
 *   - Generators span ASCII, full Unicode code points, graphemes/emoji,
 *     whitespace-only and structural-marker strings, and long strings, so a
 *     match cannot be a coincidence of shared boilerplate.
 *   - A separate edge test feeds empty `must_include`, an empty character set,
 *     and absent/empty `previousSceneContent` to confirm assembly never throws
 *     and still carries `purpose` / `ending_state`.
 *
 * Uses fast-check with >= 100 runs.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  buildScenePrompt,
  type CharacterContext,
  type ScenePromptInput,
} from './buildBlueprintPrompts.js';
import type { BlueprintCore, Scene } from '../../types/index.js';

const NUM_RUNS = 200;

/**
 * Non-empty text generator covering the required edge classes: ASCII, full
 * Unicode code points, graphemes/emoji, hand-picked whitespace / structural
 * markers, and long strings. Every value has length >= 1 so substring
 * assertions remain meaningful (the empty string is a substring of everything).
 */
const nonEmptyTextArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ minLength: 1 }),
  fc.string({ unit: 'binary', minLength: 1 }),
  fc.string({ unit: 'grapheme', minLength: 1 }),
  fc.constantFrom(
    ' ',
    '\n',
    '\t',
    '   \n\t  ',
    '日本語のテキスト',
    '😀🎉👨‍👩‍👧‍👦',
    'line1\nline2\r\nline3',
    '【角色】重要设定',
    '场景目的（purpose）：表面平静',
  ),
  fc.string({ minLength: 200, maxLength: 500 }),
);

/** Any text (incl. empty) for fields that are not the subject of an assertion. */
const anyTextArb: fc.Arbitrary<string> = fc.oneof(
  nonEmptyTextArb,
  fc.constant(''),
  fc.string(),
);

/** A blueprint core; only `title` / `main_goal` / `tone` are read by the builder. */
const blueprintArb: fc.Arbitrary<BlueprintCore> = fc.record({
  chapter_id: anyTextArb,
  title: anyTextArb,
  target_words: fc.integer({ min: 1, max: 1_000_000 }),
  main_goal: anyTextArb,
  tone: anyTextArb,
  pacing: anyTextArb,
  required_plot_points: fc.array(anyTextArb, { maxLength: 4 }),
  forbidden_points: fc.array(anyTextArb, { maxLength: 4 }),
  emotional_curve: anyTextArb,
  scenes: fc.constant<Scene[]>([]), // not consumed by buildScenePrompt
  ending_hook: anyTextArb,
});

/** Build a scene generator; asserted fields are forced non-empty. */
function sceneArbWith(
  mustIncludeArb: fc.Arbitrary<string[]>,
): fc.Arbitrary<Scene> {
  return fc.record({
    scene_id: anyTextArb,
    name: anyTextArb,
    target_words: fc.integer({ min: 1, max: 100_000 }),
    location: anyTextArb,
    characters: fc.array(anyTextArb, { maxLength: 5 }),
    purpose: nonEmptyTextArb, // asserted (需求 6.1)
    emotion: anyTextArb,
    pacing: anyTextArb,
    must_include: mustIncludeArb, // each item asserted (需求 6.1)
    ending_state: nonEmptyTextArb, // asserted (需求 6.1)
  });
}

const characterArb: fc.Arbitrary<CharacterContext> = fc.record({
  name: anyTextArb,
  description: nonEmptyTextArb, // asserted (需求 6.2)
});

/** Join all message contents into one big string for substring checks. */
function combineContents(messages: { content: string }[]): string {
  return messages.map((m) => m.content).join('\n');
}

describe('buildScenePrompt scene-context property test', () => {
  it('Feature: chapter-blueprint, Property 17: 场景写作上下文包含蓝图与正文约束', () => {
    fc.assert(
      fc.property(
        blueprintArb,
        // non-empty must_include array of non-empty items
        sceneArbWith(fc.array(nonEmptyTextArb, { minLength: 1, maxLength: 6 })),
        // at least one appearing character so 需求 6.2 is exercised
        fc.array(characterArb, { minLength: 1, maxLength: 5 }),
        // previous content: present (non-empty) or absent (undefined)
        fc.option(nonEmptyTextArb, { nil: undefined }),
        (blueprint, scene, characters, previousSceneContent) => {
          const input: ScenePromptInput = {
            blueprint,
            scene,
            characters,
            previousSceneContent,
          };

          const messages = buildScenePrompt(input);

          // Structural sanity: every entry is a well-formed ChatMessage.
          expect(messages.length).toBeGreaterThan(0);
          for (const m of messages) {
            expect(typeof m.content).toBe('string');
          }

          const combined = combineContents(messages);

          // 需求 6.1: scene purpose, every must_include item, ending_state.
          expect(combined).toContain(scene.purpose);
          for (const item of scene.must_include) {
            expect(combined).toContain(item);
          }
          expect(combined).toContain(scene.ending_state);

          // 需求 6.2: every appearing character's description.
          for (const c of characters) {
            expect(combined).toContain(c.description);
          }

          // 需求 6.3: previous scene content only when present & non-empty.
          if (
            previousSceneContent !== undefined &&
            previousSceneContent.length > 0
          ) {
            expect(combined).toContain(previousSceneContent);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('Feature: chapter-blueprint, Property 17 (edge): 空必含要点/无出场角色/无上一场景正文不破坏组装', () => {
    fc.assert(
      fc.property(
        blueprintArb,
        sceneArbWith(fc.constant<string[]>([])), // empty must_include
        fc.constant<CharacterContext[]>([]), // no characters
        // undefined OR empty string: neither is injected (需求 6.3 boundary)
        fc.constantFrom<string | undefined>(undefined, ''),
        (blueprint, scene, characters, previousSceneContent) => {
          const input: ScenePromptInput = {
            blueprint,
            scene,
            characters,
            previousSceneContent,
          };

          // Assembly must not throw on empty collections / absent prior content.
          const messages = buildScenePrompt(input);
          expect(messages.length).toBeGreaterThan(0);

          const combined = combineContents(messages);

          // The non-empty scene constraints are still present.
          expect(combined).toContain(scene.purpose);
          expect(combined).toContain(scene.ending_state);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('Feature: prompt-cache, stable prefix: 同章不同场景共享章节缓存前缀', () => {
    const blueprint: BlueprintCore = {
      chapter_id: 'chapter-1',
      title: '第1章 归村',
      target_words: 3000,
      main_goal: '主角回村参加葬礼并发现族谱异常。',
      tone: '民俗恐怖',
      pacing: '前慢后紧',
      required_plot_points: ['葬礼', '族谱变黑'],
      forbidden_points: ['提前解释真相'],
      emotional_curve: '疑惑到惊惧',
      scenes: [],
      ending_hook: '名字完全变黑。',
    };
    const sceneA: Scene = {
      scene_id: 's1',
      name: '入村',
      target_words: 1000,
      location: '村口',
      characters: [],
      purpose: '建立压抑气氛',
      emotion: '阴冷',
      pacing: '慢',
      must_include: ['纸钱'],
      ending_state: '抵达祠堂',
    };
    const sceneB: Scene = {
      ...sceneA,
      scene_id: 's2',
      name: '翻族谱',
      purpose: '发现名字变黑',
      must_include: ['族谱'],
      ending_state: '灯灭',
    };

    const prefixA = buildScenePrompt({ blueprint, scene: sceneA, characters: [] })[1].content
      .split('【场景蓝图约束】')[0];
    const prefixB = buildScenePrompt({ blueprint, scene: sceneB, characters: [] })[1].content
      .split('【场景蓝图约束】')[0];

    expect(prefixA).toBe(prefixB);
    expect(prefixA).toContain('【稳定章节缓存前缀】');
    expect(prefixA).toContain('族谱变黑');
  });
});
