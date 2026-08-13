import { describe, expect, it } from 'vitest';

import { buildAgentRunOptions } from './buildAgentRunOptions.js';

describe('buildAgentRunOptions', () => {
  it('builds auto_next options with default targetWords', () => {
    expect(buildAgentRunOptions({ task: 'auto_next' })).toEqual({ targetWords: 2000 });
    expect(buildAgentRunOptions({ task: 'auto_next', targetWords: 1800 })).toEqual({
      targetWords: 1800,
    });
    expect(buildAgentRunOptions({ task: 'auto_next', autoNextTargetWords: 2500 })).toEqual({
      targetWords: 2500,
    });
  });

  it('builds full_novel options with chat-path defaults', () => {
    expect(buildAgentRunOptions({ task: 'full_novel' })).toEqual({
      chapters: 3,
      targetWords: 1500,
      totalChapters: 3,
      planSummary: undefined,
    });
  });

  it('prefers planSummary chapterCount for full_novel totalChapters', () => {
    const planSummary = { chapterCount: 12, wordsPerChapter: 2000, totalWords: 24000 };
    expect(
      buildAgentRunOptions({
        task: 'full_novel',
        chapters: 5,
        targetWords: 1800,
        planSummary,
      }),
    ).toEqual({
      chapters: 5,
      targetWords: 1800,
      totalChapters: 12,
      planSummary,
    });
  });

  it('builds long_novel options with semi_auto and totalWords fallbacks', () => {
    // defaults: batch 3 章 × 2000 字; totalChapters falls back to 10; totalWords 20 万
    expect(buildAgentRunOptions({ task: 'long_novel' })).toEqual({
      chapters: 3,
      targetWords: 2000,
      totalChapters: 10,
      totalWords: 200_000,
      automationLevel: 'semi_auto',
      planSummary: undefined,
    });

    const planSummary = {
      chapterCount: 20,
      totalWords: 100_000,
      wordsPerChapter: 2500,
      planConfig: { targetWordsPerChapter: { min: 2200, max: 2800 } },
    };
    expect(
      buildAgentRunOptions({
        task: 'long_novel',
        chapters: 5,
        targetWords: 2500,
        automationLevel: 'auto',
        planSummary,
        minWordsPerChapter: 800,
      }),
    ).toEqual({
      chapters: 5,
      targetWords: 2500,
      totalChapters: 20,
      totalWords: 100_000,
      automationLevel: 'auto',
      planSummary,
      minWordsPerChapter: 800,
      maxWordsPerChapter: 2800,
    });
  });

  it('prefers explicit totalWords over product and plan', () => {
    expect(
      buildAgentRunOptions({
        task: 'long_novel',
        chapters: 10,
        targetWords: 2000,
        totalWords: 200_000,
        planSummary: { totalWords: 50_000 },
      })?.totalWords,
    ).toBe(200_000);
  });

  it('uses 200_000 when totalWords and plan total absent', () => {
    expect(
      buildAgentRunOptions({
        task: 'long_novel',
        chapters: 10,
        targetWords: 2000,
      })?.totalWords,
    ).toBe(200_000);
  });

  it('accepts explicit product totalWords from callers', () => {
    expect(
      buildAgentRunOptions({
        task: 'long_novel',
        chapters: 10,
        targetWords: 2000,
        totalWords: 10 * 2000,
      })?.totalWords,
    ).toBe(20_000);
  });

  it('returns planSummary-only for other tasks, or undefined', () => {
    const planSummary = { title: '代码御剑' };
    expect(buildAgentRunOptions({ task: 'novel', planSummary })).toEqual({ planSummary });
    expect(buildAgentRunOptions({ task: 'outline' })).toBeUndefined();
  });
});
