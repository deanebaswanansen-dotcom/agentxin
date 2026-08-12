import { describe, expect, it } from 'vitest';

import { defaultLongNovelConfig, runChapterQualityGates } from './qualityGates.js';

describe('long novel quality gates', () => {
  it('hard-fails empty or meta-leak drafts', () => {
    const empty = runChapterQualityGates({
      content: '',
      minWords: 300,
      maxWords: 4000,
      targetWords: 2000,
      chapterTitle: '第1章',
    });
    expect(empty.hardFail).toBe(true);

    const leak = runChapterQualityGates({
      content: '好的，作为AI助手我来为你写一章。\n\n正文开始……'.repeat(20),
      minWords: 100,
      maxWords: 8000,
      targetWords: 2000,
      chapterTitle: '第1章',
    });
    expect(leak.findings.some((f) => f.gate === 'format' && f.severity === 'hard')).toBe(true);
  });

  it('keeps an unsubstantiated low reviewer score recoverable', () => {
    const body = '林远冲进雨里，却发现地图是假的。他说：“我们被骗了。”下一秒警报响起。'.repeat(30);
    const result = runChapterQualityGates({
      content: body,
      minWords: 100,
      maxWords: 8000,
      targetWords: 1500,
      chapterTitle: '第2章',
      inspectorScore: 40,
      recommendRevision: true,
      revisionHints: ['加强章末钩子'],
    });
    expect(result.hardFail).toBe(false);
    expect(result.findings.some((f) => f.severity === 'soft')).toBe(true);

    const conflict = runChapterQualityGates({
      content: body,
      minWords: 100,
      maxWords: 8000,
      targetWords: 1500,
      chapterTitle: '第2章',
      inspectorScore: 40,
      recommendRevision: true,
      revisionHints: ['角色已死亡却再次出场，属于明确设定冲突'],
    });
    expect(conflict.hardFail).toBe(true);

    const fatalFinding = runChapterQualityGates({
      content: body,
      minWords: 100,
      maxWords: 8000,
      targetWords: 1500,
      chapterTitle: '第2章',
      inspectorScore: 40,
      recommendRevision: false,
      fatalIssues: ['人物身份与 Canon 冲突'],
    });
    expect(fatalFinding.hardFail).toBe(true);
  });

  it('default config maps automation levels to max chapters per run', () => {
    expect(defaultLongNovelConfig({ automationLevel: 'assistant' }).maxChaptersPerRun).toBe(1);
    expect(defaultLongNovelConfig({ automationLevel: 'semi_auto' }).maxChaptersPerRun).toBe(5);
    expect(defaultLongNovelConfig({ automationLevel: 'unattended' }).maxChaptersPerRun).toBe(50);
    expect(defaultLongNovelConfig({ automationLevel: 'auto' }).autoRevisionEnabled).toBe(true);
  });
});
