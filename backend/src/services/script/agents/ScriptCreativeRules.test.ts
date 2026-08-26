import { describe, expect, it } from 'vitest';

import {
  scriptCreativeWritingInstruction,
  scriptQualityNoteIssues,
  scriptQualityReviewInstruction,
} from './ScriptCreativeRules.js';

describe('ScriptCreativeRules', () => {
  it('treats every creative preference as bendable completion guidance', () => {
    const instruction = scriptCreativeWritingInstruction({
      creativeRules: {
        preset: 'hongguo',
        fiveEpisodeArc: true,
        openingHook: true,
        endingHook: true,
        goldenLine: true,
        firstAppearanceDetails: true,
        productionLabels: true,
        writingInstructions: '每集都要情绪升级',
        formatInstructions: '标注必要特写',
        qualityMode: 'hongguo',
        qualityInstructions: '',
      },
    });
    expect(instruction).toContain('每五集作为一个松散推进单元');
    expect(instruction).toContain('均为软约束');
    expect(instruction).toContain('不得因未完美满足偏好而截断、拒绝输出或暂停任务');
  });

  it('turns subjective quality feedback into AI soft notes only', () => {
    const instruction = scriptQualityReviewInstruction({
      creativeRules: {
        preset: 'custom',
        fiveEpisodeArc: false,
        openingHook: true,
        endingHook: true,
        goldenLine: false,
        firstAppearanceDetails: true,
        productionLabels: false,
        writingInstructions: '',
        formatInstructions: '',
        qualityMode: 'custom',
        qualityInstructions: '检查情绪兑现',
      },
    });
    expect(instruction).toContain('不得标 hard');
    expect(instruction).toContain('不得据此判 major_issue');
    expect(scriptQualityNoteIssues(['情绪兑现可以更清楚'])).toEqual([{
      code: 'CREATIVE_PREFERENCE',
      severity: 'soft',
      source: 'ai',
      message: '情绪兑现可以更清楚',
    }]);
  });
});
