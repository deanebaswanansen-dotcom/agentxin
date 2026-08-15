import { describe, expect, it } from 'vitest';

import {
  assessScriptPlanning,
  type ScriptPlanningField,
  type ScriptPlanningSession,
} from './ScriptPlanningAgent.js';

function session(overrides: Partial<ScriptPlanningSession> = {}): ScriptPlanningSession {
  return {
    values: { genres: ['校园青春'] },
    delegatedFields: [],
    askedFields: [],
    questionCount: 0,
    ...overrides,
  };
}

describe('assessScriptPlanning', () => {
  it('asks at most five missing high-impact questions using the selected genre context', () => {
    const result = assessScriptPlanning(session());

    expect(result.kind).toBe('questions');
    if (result.kind !== 'questions') return;
    expect(result.questions).toHaveLength(5);
    expect(result.questions[0]?.prompt).toContain('校园青春');
    expect(result.questions.map((question) => question.field)).toEqual([
      'coreConflict',
      'audience',
      'totalEpisodes',
      'episodeDurationSeconds',
      'targetCharsPerEpisode',
    ]);
    expect(result.questions.map((question) => question.prompt).join('')).not.toMatch(/西方玄幻|修仙/);
  });

  it('never repeats an already asked field and respects the twelve-question budget', () => {
    const asked: ScriptPlanningField[] = [
      'coreConflict',
      'audience',
      'totalEpisodes',
      'episodeDurationSeconds',
      'targetCharsPerEpisode',
    ];
    const result = assessScriptPlanning(
      session({ askedFields: asked, questionCount: 11 }),
    );

    expect(result.kind).toBe('questions');
    if (result.kind !== 'questions') return;
    expect(result.questions).toHaveLength(1);
    expect(asked).not.toContain(result.questions[0]?.field);
  });

  it('opens the confirmation gate only when every key decision is answered or delegated', () => {
    const values = {
      genres: ['校园青春'],
      coreConflict: '新闻社主编与校园霸凌势力对抗',
      audience: '18—30 岁女性',
      totalEpisodes: 20,
      episodeDurationSeconds: { min: 60, max: 90 },
      targetCharsPerEpisode: 1_000,
      maxScenesPerEpisode: 3,
      dialogueDensityPercent: 60,
    };
    const result = assessScriptPlanning(
      session({ values, delegatedFields: ['endingDirection'] }),
    );

    expect(result).toEqual({ kind: 'ready', values, delegatedFields: ['endingDirection'] });
  });
});
