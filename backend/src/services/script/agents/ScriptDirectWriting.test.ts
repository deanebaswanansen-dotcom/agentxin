import { describe, expect, it } from 'vitest';

import type {
  ScriptCharacter,
  ScriptEpisode,
  ScriptEpisodeContinuityCommitInput,
} from '../domain.js';
import {
  buildDirectDraftPrompt,
  buildDirectRewritePrompt,
  buildDirectReviewPrompt,
  decodeDirectHandoffReview,
  createLocalDirectHandoffReview,
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
  it('treats targetChars as a hard ceiling without asking the model to pad the draft', () => {
    const prompt = buildDirectDraftPrompt({
      episode: { targetChars: 1_200, dialogueDensityPercent: 60 },
      nextEpisodeDirection: { mainEvent: '公开挑战' },
    });
    expect(prompt).toContain('直接写出本集完整中文短剧正文');
    expect(prompt).toContain('1200 个可见字符为目标');
    expect(prompt).toContain('800—1600 字');
    expect(prompt).toContain('字数是软目标');
    expect(prompt).toContain('绝不能把一句话写一半后用省略号代替未写内容');
    expect(prompt).not.toContain('恰好');
    expect(prompt).toContain('不要输出 JSON');
    expect(prompt).toContain('必须在 endingHook 处停住');
    expect(prompt).toContain('绝不能提前完成下一集事件');
    expect(prompt).toContain('N-1 日或夜 内或外 具体地点');
    expect(prompt).toContain('人物在全剧第一次出场时');
    expect(prompt).toContain('△【特写】动作');
    expect(prompt).toContain('【闪回】和【闪回结束】');
    expect(prompt).toContain('OS必须跟人物心里所想的话');
    expect(prompt).toContain('VO只用于画外能听见但看不到人物');
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

  it('keeps custom quality checks advisory and separate from rewrite issues', () => {
    const prompt = buildDirectReviewPrompt({
      project: {
        creativeRules: {
          qualityMode: 'custom',
          qualityInstructions: '重点检查人物动机与情绪兑现',
        },
      },
      episode: { endingHook: '公开挑战正式成立' },
    }, '主角拿出证据。');
    expect(prompt).toContain('qualityNotes');
    expect(prompt).toContain('重点检查人物动机与情绪兑现');
    expect(prompt).toContain('不得据此判 major_issue');

    const review = decodeDirectHandoffReview({
      verdict: 'pass',
      issues: [],
      qualityNotes: ['人物动机可以更明确', '情绪兑现可以更具体', '第三条应被截断'],
    });
    expect(review.qualityNotes).toEqual(['人物动机可以更明确', '情绪兑现可以更具体']);
    expect(review).toMatchObject({ verdict: 'pass', issues: [] });
  });

  it('tells an off-outline rewrite to delete later evidence instead of paraphrasing it', () => {
    const prompt = buildDirectRewritePrompt({
      episode: { endingHook: '只拍到半张维修记录' },
      nextEpisodeDirection: { mainEvent: '继续追查资本资金链' },
    }, '主角已经拿到完整资金流水。', [{
      code: 'OFF_OUTLINE',
      evidence: '提前拿到完整资金流水',
      expected: '本集只拍到半张维修记录',
    }]);

    expect(prompt).toContain('彻底删除 evidence 涉及的越界人物、道具、证据和后续事件');
    expect(prompt).toContain('不能只换说法或换地点保留');
    expect(prompt).toContain('精确停在本集 endingHook');
  });

  it('drops the rejected original when retrying an off-outline rewrite', () => {
    const prompt = buildDirectRewritePrompt({
      episode: { endingHook: '只拍到半张维修记录' },
      nextEpisodeDirection: { mainEvent: '继续追查资本资金链' },
    }, '主角已经拿到完整资金流水。', [{
      code: 'OFF_OUTLINE',
      evidence: '提前拿到完整资金流水',
      expected: '本集只拍到半张维修记录',
    }], { rewriteFromOutline: true });

    expect(prompt).toContain('完全从分集卡重新写出本集');
    expect(prompt).toContain('不要参考、延续或改写上一版正文');
    expect(prompt).not.toContain('主角已经拿到完整资金流水');
    expect(prompt).not.toContain('原正文');
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

  it('tolerates omitted empty fields in a pass-only payload', () => {
    expect(decodeDirectHandoffReview({ verdict: 'pass' })).toEqual({
      verdict: 'pass',
      issues: [],
      qualityNotes: [],
      handoff: {
        summary: '',
        characterStates: [],
        props: [],
        openThreads: [],
        ending: '',
      },
    });
  });

  it('downgrades an unusable major_issue payload to an advisory pass', () => {
    expect(decodeDirectHandoffReview({
      verdict: 'major_issue',
      issues: [
        { code: 'LITERARY_STYLE', evidence: '不够优美', expected: '加修辞' },
        { code: 'UNKNOWN_STYLE', evidence: '太口语', expected: '更文学' },
      ],
      handoff: { summary: '本集完成复出准备', openThreads: ['谁篡改了数据'] },
    })).toMatchObject({ verdict: 'pass', issues: [] });
  });

  it('synthesizes a local handoff when the review provider is unavailable', () => {
    const review = createLocalDirectHandoffReview({
      goal: '周野决定复出',
      endingHook: '门外传来引擎声',
    } as unknown as Parameters<typeof createLocalDirectHandoffReview>[0], episode);

    expect(review.verdict).toBe('pass');
    expect(review.handoff.summary).toBe('周野决定复出');
    expect(review.handoff.ending).toBe('周野把原始数据卡锁进工具柜。');
  });
});
