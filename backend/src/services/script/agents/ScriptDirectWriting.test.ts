import { describe, expect, it } from 'vitest';

import type {
  ScriptCharacter,
  ScriptEpisode,
  ScriptEpisodeContinuityCommitInput,
} from '../domain.js';
import {
  buildDirectDraftPrompt,
  buildDirectReviewPrompt,
  decodeDirectHandoffReview,
  mergeDirectHandoffContinuity,
  reconcileDirectReviewBoundary,
} from './ScriptDirectWriting.js';

const character = {
  id: 'character-zhou',
  name: '周野',
  aliases: ['老周'],
} as unknown as ScriptCharacter;

const episode = {
  projectId: 'project-1',
  episodeNumber: 2,
  scenes: [{
    id: 'scene-1',
    ordinal: 1,
    location: '修车厂',
    timeOfDay: 'night',
    interiorExterior: 'interior',
    characterIds: [character.id],
    blocks: [{ id: 'block-1', type: 'action', text: '周野把原始数据卡锁进工具柜。' }],
  }],
} as unknown as ScriptEpisode;

const emptyContinuity: ScriptEpisodeContinuityCommitInput = {
  characterUpdates: [],
  factsAdded: [],
  props: [],
  threads: [],
  timelineEvents: [],
  nextEpisodeMustInherit: [],
};

describe('ScriptDirectWriting', () => {
  it('keeps the direct-writing prompt focused on outline fidelity instead of exact quotas', () => {
    const prompt = buildDirectDraftPrompt({
      episode: { targetChars: 1_200, dialogueDensityPercent: 60 },
      nextEpisodeDirection: { mainEvent: '公开挑战' },
    });
    expect(prompt).toContain('直接写出本集完整中文短剧正文');
    expect(prompt).toContain('篇幅和对白比例是建议');
    expect(prompt).not.toContain('恰好');
    expect(prompt).toContain('不要输出 JSON');
    expect(prompt).toContain('必须在 endingHook 处停住');
    expect(prompt).toContain('绝不能提前完成下一集事件');
  });

  it('tells the lightweight reviewer to reject events reserved for later episode cards', () => {
    const prompt = buildDirectReviewPrompt({
      episode: { endingHook: '公开挑战正式成立' },
      nextEpisodeDirection: { mainEvent: '决赛开始' },
    }, '主角已经跑完决赛并夺冠。');

    expect(prompt).toContain('逐项比较本集 endingHook 与 nextEpisodeDirection');
    expect(prompt).toContain('提前完成下一集、后续高潮或结局');
    expect(prompt).toContain('OFF_OUTLINE');
  });

  it('does not invent a next episode after the confirmed finale', () => {
    const prompt = buildDirectReviewPrompt({
      episode: { endingHook: '该回家了' },
    }, '主角赢下决赛，公开证据后说该回家了。');
    const review = reconcileDirectReviewBoundary({}, {
      verdict: 'major_issue',
      issues: [{
        code: 'OFF_OUTLINE',
        evidence: '主角已经公开证据',
        expected: '证据应留到下一集公开',
      }],
      handoff: {
        summary: '主角赢下决赛并洗清冤屈',
        characterStates: [], props: [], openThreads: [], ending: '该回家了',
      },
    });

    expect(prompt).toContain('这是全剧最后一集');
    expect(prompt).toContain('禁止虚构“应留到下一集”');
    expect(review).toMatchObject({ verdict: 'pass', issues: [] });
  });

  it('drops unsupported review categories and caps major issues at three', () => {
    const review = decodeDirectHandoffReview({
      verdict: 'major_issue',
      issues: [
        { code: 'OFF_OUTLINE', evidence: '改成篮球赛', expected: '继续赛车复出' },
        { code: 'LITERARY_STYLE', evidence: '不够优美', expected: '加修辞' },
        { code: 'CAUSAL_CONTRADICTION', evidence: '先领奖后参赛', expected: '先参赛' },
        { code: 'PROP_STATE_CONTRADICTION', evidence: '数据卡已销毁又出现', expected: '保持锁在柜中' },
        { code: 'DUPLICATE_MAJOR_EVENT', evidence: '第二次首次发现', expected: '只能发现一次' },
      ],
      handoff: { summary: '本集完成复出准备', openThreads: ['谁篡改了数据'] },
    });

    expect(review.issues).toHaveLength(3);
    expect(review.issues.map((item) => item.code)).not.toContain('LITERARY_STYLE');
  });

  it('maps compact character, prop, and ending state into the next-episode continuity handoff', () => {
    const review = decodeDirectHandoffReview({
      verdict: 'pass',
      issues: [],
      handoff: {
        summary: '周野锁好数据卡。',
        characterStates: [{
          characterId: '老周',
          location: '修车厂',
          state: '决定复出',
          knows: ['数据卡没有被销毁'],
        }],
        props: [{ name: '原始数据卡', holder: '周野', location: '工具柜', state: '已上锁' }],
        openThreads: ['谁伪造了禁赛证据'],
        ending: '门外传来陌生赛车的引擎声',
      },
    });
    const merged = mergeDirectHandoffContinuity(emptyContinuity, review, episode, [character]);

    expect(merged.characterUpdates).toContainEqual(expect.objectContaining({
      characterId: character.id,
      location: '修车厂',
      emotionalState: '决定复出',
      knownFactsAdded: ['数据卡没有被销毁'],
    }));
    expect(merged.props).toContainEqual(expect.objectContaining({
      name: '原始数据卡',
      holderCharacterId: character.id,
      state: '已上锁；位置：工具柜',
      evidenceBlockIds: ['block-1'],
    }));
    expect(merged.nextEpisodeMustInherit).toContain('门外传来陌生赛车的引擎声');
  });
});
