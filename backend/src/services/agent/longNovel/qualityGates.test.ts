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

  it('hard-fails narrative chapter-number leaks but allows the leading heading and document clauses', () => {
    const leaked = runChapterQualityGates({
      content: [
        '第20章　引航台',
        '',
        '顾棠从外套内袋抽出横线纸——第17章从泵站底座取到的那张。',
        '她终于发现纸背还有一组数字。',
      ].join('\n'),
      minWords: 1,
      maxWords: 8000,
      targetWords: 2000,
      chapterTitle: '第20章',
    });

    expect(leaked.findings).toContainEqual(expect.objectContaining({
      gate: 'format',
      severity: 'hard',
      message: expect.stringContaining('章节编号'),
    }));

    const documentReference = runChapterQualityGates({
      content: '## 第20章　引航台\n\n顾棠翻开协议，发现协议第三章中明确写着污染处置流程。',
      minWords: 1,
      maxWords: 8000,
      targetWords: 2000,
      chapterTitle: '第20章',
    });
    expect(documentReference.findings.some((finding) =>
      finding.gate === 'format' && finding.severity === 'hard')).toBe(false);
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
      revisionHints: ['将发色改为与设定一致，并加强章末钩子'],
    });
    expect(conflict.hardFail).toBe(false);

    const fatalFinding = runChapterQualityGates({
      content: body,
      minWords: 100,
      maxWords: 8000,
      targetWords: 1500,
      chapterTitle: '第2章',
      inspectorScore: 40,
      recommendRevision: false,
      fatalIssues: ['角色已死亡却再次出场，人物身份与 Canon 冲突'],
    });
    expect(fatalFinding.hardFail).toBe(true);

    const appearanceDrift = runChapterQualityGates({
      content: body,
      minWords: 100,
      maxWords: 8000,
      targetWords: 1500,
      chapterTitle: '第2章',
      inspectorScore: 45,
      recommendRevision: true,
      fatalIssues: ['卡奥斯的旧疤从小臂变成右手无名指，与人物设定不一致'],
      revisionHints: ['将旧疤位置改回小臂'],
    });
    expect(appearanceDrift.hardFail).toBe(false);

    const fixableDateMismatch = runChapterQualityGates({
      content: body,
      minWords: 100,
      maxWords: 8000,
      targetWords: 1500,
      chapterTitle: '第2章',
      inspectorScore: 45,
      recommendRevision: true,
      fatalIssues: ['时间线硬冲突：第1章写十一月五日，第2章误写十一月六日'],
      revisionHints: ['统一火灾日期为十一月五日'],
    });
    expect(fixableDateMismatch.hardFail).toBe(false);
  });

  it.each([
    '角色此前被捕关押，本章却无解释地自由行动并出席宴会',
    '唯一神器归墟钥匙同一时间被两人持有',
    '主角提前知道尚未公开的核心秘密',
    '能力已被封印，本章却直接发动并恢复可用',
    '人物上一章重伤濒死，本章却伤势消失并满状态战斗',
    '主角性别被改写',
  ])('hard-fails an explicit story-breaking continuity issue: %s', (fatalIssue) => {
    const result = runChapterQualityGates({
      content: '林远冲进雨里，却发现地图是假的。他说：“我们被骗了。”下一秒警报响起。'.repeat(30),
      minWords: 100,
      maxWords: 8000,
      targetWords: 1500,
      chapterTitle: '第2章',
      inspectorScore: 45,
      fatalIssues: [fatalIssue],
    });

    expect(result.hardFail).toBe(true);
    expect(result.findings).toContainEqual(expect.objectContaining({
      gate: 'continuity',
      severity: 'hard',
    }));
  });

  it('does not let a high reviewer score override an explicit P0 finding', () => {
    const result = runChapterQualityGates({
      content: '林远冲进雨里，却发现地图是假的。他说：“我们被骗了。”下一秒警报响起。'.repeat(30),
      minWords: 100,
      maxWords: 8000,
      targetWords: 1500,
      chapterTitle: '第2章',
      inspectorScore: 92,
      fatalIssues: ['角色此前已经死亡，本章却无解释再次出场'],
    });

    expect(result.hardFail).toBe(true);
  });

  it('default config maps automation levels to max chapters per run', () => {
    expect(defaultLongNovelConfig({ automationLevel: 'assistant' }).maxChaptersPerRun).toBe(1);
    expect(defaultLongNovelConfig({ automationLevel: 'semi_auto' }).maxChaptersPerRun).toBe(5);
    expect(defaultLongNovelConfig({ automationLevel: 'unattended' }).maxChaptersPerRun).toBe(5);
    expect(defaultLongNovelConfig({ automationLevel: 'auto' }).autoRevisionEnabled).toBe(true);
  });
});
