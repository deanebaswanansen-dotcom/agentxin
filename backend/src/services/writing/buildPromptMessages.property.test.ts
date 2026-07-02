/**
 * Property-based tests for {@link buildPromptMessages} (WritingService 上下文组装).
 *
 * Covers design.md Correctness Properties 19, 20, 22, 23 (tasks 7.2 - 7.5).
 * Uses fast-check with >= 100 runs each. Generators cover special characters,
 * whitespace, Unicode, empty collections and long strings.
 *
 * Robustness note: substring-containment assertions are anchored to the
 * *specific* message that is supposed to carry the value (the final `user`
 * message for 19/20, the leading `system` message for 22) rather than to the
 * concatenation of all messages. Property 23 verifies ordering by checking the
 * exact contiguous block of history messages position-by-position, so it does
 * not rely on substring containment at all.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildPromptMessages } from './buildPromptMessages.js';
import type {
  ChatTurn,
  SettingSnippet,
  WritingContextInput,
} from '../../types/index.js';

const NUM_RUNS = 200;

/**
 * Text generator covering the required edge classes: ASCII (incl. empty),
 * full Unicode code points, printable graphemes/emoji, hand-picked
 * whitespace / structural-marker strings, and long strings.
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
    '【当前章节正文】',
    '【续写指令】',
    '日本語のテキスト',
    '😀🎉👨‍👩‍👧‍👦',
    'line1\nline2\r\nline3',
  ),
  fc.string({ minLength: 200, maxLength: 500 }),
);

const snippetArb: fc.Arbitrary<SettingSnippet> = fc.record({
  kind: fc.constantFrom<SettingSnippet['kind']>('character', 'world', 'outline'),
  title: textArb,
  body: textArb,
});

const turnArb: fc.Arbitrary<ChatTurn> = fc.record({
  role: fc.constantFrom<ChatTurn['role']>('user', 'assistant'),
  content: textArb,
});

const settingsArb: fc.Arbitrary<SettingSnippet[]> = fc.array(snippetArb, {
  maxLength: 6,
});

const historyArb: fc.Arbitrary<ChatTurn[]> = fc.array(turnArb, {
  maxLength: 8,
});

describe('buildPromptMessages property tests', () => {
  it('Feature: novel-writing-agent, Property 19: 写作上下文包含章节正文与指令（续写）', () => {
    fc.assert(
      fc.property(
        textArb, // chapterContent
        textArb, // instruction
        settingsArb,
        historyArb,
        (chapterContent, instruction, attachedSettings, sessionHistory) => {
          const input: WritingContextInput = {
            operation: 'continue',
            instruction,
            chapterContent,
            attachedSettings,
            sessionHistory,
          };

          const messages = buildPromptMessages(input);

          // The final assembled message is the continuation user prompt.
          const finalMessage = messages[messages.length - 1];
          expect(finalMessage.role).toBe('user');

          // It must contain both the chapter content and the instruction.
          expect(finalMessage.content.includes(chapterContent)).toBe(true);
          expect(finalMessage.content.includes(instruction)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('Feature: novel-writing-agent, Property 20: 写作上下文包含选定文本与指令（改写/润色）', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<'rewrite' | 'polish'>('rewrite', 'polish'),
        textArb, // selectedText
        textArb, // instruction
        settingsArb,
        historyArb,
        (operation, selectedText, instruction, attachedSettings, sessionHistory) => {
          const input: WritingContextInput = {
            operation,
            instruction,
            chapterContent: '',
            selectedText,
            attachedSettings,
            sessionHistory,
          };

          const messages = buildPromptMessages(input);

          const finalMessage = messages[messages.length - 1];
          expect(finalMessage.role).toBe('user');

          // It must contain both the selected text and the instruction.
          expect(finalMessage.content.includes(selectedText)).toBe(true);
          expect(finalMessage.content.includes(instruction)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('Feature: novel-writing-agent, Property 22: 附加设定内容进入写作上下文', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<WritingContextInput['operation']>(
          'continue',
          'rewrite',
          'polish',
        ),
        textArb, // instruction
        textArb, // chapterContent
        textArb, // selectedText
        // Use minLength: 1 here so the "settings present" branch is exercised;
        // the empty-collection edge is covered by the dedicated assertion below.
        fc.array(snippetArb, { minLength: 1, maxLength: 6 }),
        (operation, instruction, chapterContent, selectedText, attachedSettings) => {
          const input: WritingContextInput = {
            operation,
            instruction,
            chapterContent,
            selectedText,
            attachedSettings,
            sessionHistory: [],
          };

          const messages = buildPromptMessages(input);

          // A leading system message must carry the attached settings.
          const systemMessage = messages[0];
          expect(systemMessage.role).toBe('system');

          // Every snippet's body must appear in the system message content.
          for (const snippet of attachedSettings) {
            expect(systemMessage.content.includes(snippet.body)).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('Feature: prompt-cache, Property 22 (edge): 空设定集合仍产生 base system 消息（缓存前缀）', () => {
    const messages = buildPromptMessages({
      operation: 'continue',
      instruction: 'go',
      chapterContent: 'body',
      attachedSettings: [],
      sessionHistory: [],
    });
    // Cache optimization: system message is ALWAYS present for stable prefix
    expect(messages.some((m) => m.role === 'system')).toBe(true);
    // When no settings, system content is the base prompt only (no setting block)
    expect(messages[0].content).not.toContain('【');
  });

  it('Feature: prompt-cache, stable prefix: 附加设定乱序选择仍产生相同 system 前缀', () => {
    const attachedSettings: SettingSnippet[] = [
      { kind: 'outline', title: '卷一大纲', body: '主线推进到回村。' },
      { kind: 'character', title: '林远', body: '怕黑但嘴硬。' },
      { kind: 'world', title: '村规', body: '夜里不能翻族谱。' },
    ];
    const baseInput: Omit<WritingContextInput, 'attachedSettings'> = {
      operation: 'continue',
      instruction: '续写葬礼后的发现。',
      chapterContent: '祠堂里只剩一盏油灯。',
      sessionHistory: [],
    };

    const a = buildPromptMessages({ ...baseInput, attachedSettings });
    const b = buildPromptMessages({
      ...baseInput,
      attachedSettings: [...attachedSettings].reverse(),
    });

    expect(a[0]).toEqual(b[0]);
  });

  it('Feature: novel-writing-agent, Property 23: 会话历史按序保留于上下文', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<WritingContextInput['operation']>(
          'continue',
          'rewrite',
          'polish',
        ),
        textArb, // instruction
        textArb, // chapterContent
        textArb, // selectedText
        settingsArb, // include/exclude the leading system message
        historyArb,
        (
          operation,
          instruction,
          chapterContent,
          selectedText,
          attachedSettings,
          sessionHistory,
        ) => {
          const input: WritingContextInput = {
            operation,
            instruction,
            chapterContent,
            selectedText,
            attachedSettings,
            sessionHistory,
          };

          const messages = buildPromptMessages(input);

          // Structure: [always system] + history (1:1, in order) + final user.
          // System message is always present for cache prefix stability.
          const offset = 1;
          expect(messages.length).toBe(offset + sessionHistory.length + 1);

          // The history block must reproduce every turn's role + content in order.
          const historyBlock = messages.slice(
            offset,
            offset + sessionHistory.length,
          );
          expect(historyBlock.length).toBe(sessionHistory.length);
          for (let i = 0; i < sessionHistory.length; i += 1) {
            expect(historyBlock[i].role).toBe(sessionHistory[i].role);
            expect(historyBlock[i].content).toBe(sessionHistory[i].content);
          }

          // The final message is the freshly built user prompt.
          expect(messages[messages.length - 1].role).toBe('user');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
