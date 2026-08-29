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
  detectRepeatedDirectPlotEvents,
  detectUnattributedDialogueActions,
  decodeDirectHandoffReview,
  createLocalDirectHandoffReview,
  directWritingContext,
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
    expect(prompt).toContain('同一道具动作链只能完整演一次');
    expect(prompt).toContain('打开抽屉—拿起照片—看完放回');
    expect(prompt).toContain('priorEpisodeHistory 是前面已经演完的剧情');
    expect(prompt).toContain('每一句都必须单独写成“说话人：完整台词”');
    expect(prompt).toContain('禁止写“△林老板，我们来检查”');
    expect(prompt).toContain('不能把去掉说话人的原台词塞进△动作');
    expect(prompt).toContain('允许说话的临时角色称谓');
  });

  it('makes a user single-episode rewrite instruction higher priority than blind regeneration', () => {
    const prompt = buildDirectDraftPrompt({
      episode: { targetChars: 1_200, dialogueDensityPercent: 60 },
      userRewrite: {
        instruction: '保留前两场，只修改第三场，让女主先发现账本。',
        existingEpisodeText: '第1集\n1-1 办公室 日/内\n人物：沈清\n△沈清推门进入。',
      },
    });

    expect(prompt).toContain('必须优先执行：保留前两场，只修改第三场，让女主先发现账本。');
    expect(prompt).toContain('输出修改后的完整一集');
    expect(prompt).toContain('明确要求保留的部分尽量原样保留');
    expect(prompt).toContain('existingEpisodeText');
    expect(prompt).toContain('△沈清推门进入。');
  });

  it('tells the lightweight reviewer to reject events reserved for later episode cards', () => {
    const prompt = buildDirectReviewPrompt({
      episode: { endingHook: '公开挑战正式成立' },
      nextEpisodeDirection: { mainEvent: '决赛开始' },
    }, '主角已经跑完决赛并夺冠。');

    expect(prompt).toContain('逐项比较本集 endingHook 与 nextEpisodeDirection');
    expect(prompt).toContain('提前完成下一集、后续高潮或结局');
    expect(prompt).toContain('OFF_OUTLINE');
    expect(prompt).toContain('具体道具动作链重复发生');
    expect(prompt).toContain('换了人物、措辞或位置');
    expect(prompt).toContain('与 priorEpisodeHistory.allEpisodeSummaries 的全部前集对照');
    expect(prompt).toContain('至少两个相同的有序核心动作');
    expect(prompt).toContain('仅地点、人物、道具或“检查”行为重合');
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

  it('tells a duplicate-event rewrite to remove the replay instead of paraphrasing it', () => {
    const prompt = buildDirectRewritePrompt({
      episode: { endingHook: '照片背面的日期被确认' },
    }, '两个人先后打开抽屉查看同一张照片。', [{
      code: 'DUPLICATE_MAJOR_EVENT',
      sceneNumber: 1,
      evidence: '后段再次打开抽屉查看同一照片',
      expected: '后段直接写新的发现',
    }]);

    expect(prompt).toContain('保留第一次完整动作链');
    expect(prompt).toContain('删除后面重复的开端和过程');
    expect(prompt).toContain('不能只换人物、地点或近义词');
  });

  it('detects a repeated prop-action chain even when the actor and wording change', () => {
    const repeatedEpisode = {
      ...episode,
      scenes: [{
        ...episode.scenes[0],
        blocks: [
          { id: 'a1', type: 'action' as const, text: '林薇薇拉开书桌抽屉，拿起里面的旧相框。' },
          { id: 'a2', type: 'action' as const, text: '她盯着照片背面的字，随后把相框放回并关上抽屉。' },
          { id: 'd1', type: 'dialogue' as const, speaker: '陆霆骁', text: '你在找什么？' },
          { id: 'a3', type: 'action' as const, text: '林薇薇没有回答，径直走出书房。' },
          { id: 'a4', type: 'action' as const, text: '陆霆骁走到桌前打开抽屉，取出那张照片。' },
          { id: 'a5', type: 'action' as const, text: '他看着相框里的两个人，眉头紧锁。' },
        ],
      }],
    } as unknown as ScriptEpisode;

    expect(detectRepeatedDirectPlotEvents(repeatedEpisode)).toEqual([
      expect.objectContaining({
        code: 'DUPLICATE_MAJOR_EVENT',
        sceneNumber: 1,
        evidence: expect.stringContaining('重复演了抽屉或柜子、照片或相框'),
      }),
    ]);
  });

  it('does not flag one recurring prop when the later action advances the plot', () => {
    const advancingEpisode = {
      ...episode,
      scenes: [{
        ...episode.scenes[0],
        blocks: [
          { id: 'a1', type: 'action' as const, text: '林薇薇打开抽屉，拿出一张照片。' },
          { id: 'a2', type: 'action' as const, text: '她把照片交给律师作为证据。' },
          { id: 'a3', type: 'action' as const, text: '律师核对照片上的日期并联系证人。' },
          { id: 'a4', type: 'action' as const, text: '证人接过照片，当众承认自己改过日期。' },
        ],
      }],
    } as unknown as ScriptEpisode;

    expect(detectRepeatedDirectPlotEvents(advancingEpisode)).toEqual([]);
  });

  it('does not confuse a later inspection in the same market with a repeated event', () => {
    const previousEpisode = {
      ...episode,
      episodeNumber: 12,
      scenes: [{
        ...episode.scenes[0],
        blocks: [
          { id: 'p1', type: 'action' as const, text: '古代集市的摊位旁，林悦把沾泥的食材放回木箱。' },
          { id: 'p2', type: 'action' as const, text: '她检查食材标签，把摊车重新擦净。' },
        ],
      }],
    } as unknown as ScriptEpisode;
    const inspectionEpisode = {
      ...episode,
      episodeNumber: 13,
      scenes: [{
        ...episode.scenes[0],
        blocks: [
          { id: 'c1', type: 'action' as const, text: '林悦在古代集市摆正食材和木箱，等检查人员进店。' },
          { id: 'c2', type: 'action' as const, text: '检查人员翻看台账，核对食材标签后确认卫生合格。' },
        ],
      }],
    } as unknown as ScriptEpisode;

    expect(detectRepeatedDirectPlotEvents(inspectionEpisode, [previousEpisode])).toEqual([]);
  });

  it('flags spoken sentences emitted as triangle action lines without guessing the speaker', () => {
    const malformedEpisode = {
      ...episode,
      scenes: [{
        ...episode.scenes[0],
        blocks: [
          { id: 'a1', type: 'action' as const, text: '林悦迎上去，神色平静。' },
          { id: 'a2', type: 'action' as const, text: '林老板，我们是市场监督管理所的，来核查一下。' },
          { id: 'a3', type: 'action' as const, text: '您请，随便看。证照都在墙上。' },
        ],
      }],
    } as unknown as ScriptEpisode;

    expect(detectUnattributedDialogueActions(malformedEpisode)).toEqual([
      expect.objectContaining({
        code: 'DIALOGUE_FORMAT_ERROR',
        sceneNumber: 1,
        evidence: expect.stringContaining('林老板，我们是市场监督管理所的'),
      }),
    ]);
  });

  it('keeps ordinary visible action out of dialogue-format findings', () => {
    const actionEpisode = {
      ...episode,
      scenes: [{
        ...episode.scenes[0],
        blocks: [
          { id: 'a1', type: 'action' as const, text: '清晨，林悦把账本摆在柜台上。' },
          { id: 'a2', type: 'action' as const, text: '现代学徒从门口探进头来，手里拎着两杯豆浆。' },
        ],
      }],
    } as unknown as ScriptEpisode;

    expect(detectUnattributedDialogueActions(actionEpisode)).toEqual([]);
  });

  it('detects an action chain replayed from an earlier episode', () => {
    const previousEpisode = {
      ...episode,
      episodeNumber: 3,
      scenes: [{
        ...episode.scenes[0],
        blocks: [
          { id: 'p1', type: 'action' as const, text: '古代集市上，醉汉掀开木箱，里面装着食材和饲料。' },
          { id: 'p2', type: 'action' as const, text: '他踩中捕鼠夹后摔倒，撞翻油桶，鼠群从箱底窜出。' },
        ],
      }],
    } as unknown as ScriptEpisode;
    const currentEpisode = {
      ...episode,
      episodeNumber: 14,
      scenes: [{
        ...episode.scenes[0],
        blocks: [
          { id: 'c1', type: 'action' as const, text: '夜里的集市空无一人，古代醉汉抬起木箱盖，查看食材和饲料。' },
          { id: 'c2', type: 'action' as const, text: '他踩到捕鼠夹滑倒，打翻油桶，老鼠从木箱下扑出。' },
        ],
      }],
    } as unknown as ScriptEpisode;

    expect(detectRepeatedDirectPlotEvents(currentEpisode, [previousEpisode])).toEqual([
      expect.objectContaining({
        code: 'DUPLICATE_MAJOR_EVENT',
        sceneNumber: 1,
        evidence: expect.stringMatching(/第 14 集.*重复了第 3 集/u),
        expected: expect.stringContaining('前面集数已经发生'),
      }),
    ]);
  });

  it('keeps all fifty-nine earlier episode summaries while limiting detailed scene history', () => {
    const previousEpisodes = Array.from({ length: 59 }, (_, index) => ({
      ...episode,
      id: `episode-${index + 1}`,
      episodeNumber: index + 1,
      title: `第${index + 1}集`,
      summary: `第${index + 1}集发生了不可重复的关键事件。`,
      newFacts: [`第${index + 1}集关键事实`],
      scenes: [{
        ...episode.scenes[0],
        id: `scene-${index + 1}`,
        blocks: [{ id: `block-${index + 1}`, type: 'action' as const, text: `第${index + 1}集具体场景。` }],
      }],
    })) as ScriptEpisode[];
    const context = directWritingContext({
      projectId: 'project-1',
      characters: [character],
      episodes: previousEpisodes,
      worldBible: {
        era: '当代', primaryLocations: ['校报社'], worldState: '调查中', rules: [],
        organizations: [], recurringProps: [], forbiddenAnachronisms: [],
      },
      seriesOutline: { episodeCards: [] },
    } as unknown as Parameters<typeof directWritingContext>[0], {
      title: '六十集短剧', theme: '真相', genres: ['悬疑'], highlights: [],
      coreConflict: '调查真相', coreRequirements: '', forbiddenElements: [],
      maxScenesPerEpisode: 3, targetCharsPerEpisode: 1_200, dialogueDensityPercent: 60,
    } as unknown as Parameters<typeof directWritingContext>[1], {
      episodeNumber: 60,
      characterIds: [character.id],
    } as unknown as Parameters<typeof directWritingContext>[2]);
    const history = context.priorEpisodeHistory as {
      allEpisodeSummaries: Array<{ episodeNumber: number }>;
      recentSceneEvents: Array<{ episodeNumber: number }>;
    };

    expect(history.allEpisodeSummaries).toHaveLength(59);
    expect(history.allEpisodeSummaries[0]?.episodeNumber).toBe(1);
    expect(history.allEpisodeSummaries.at(-1)?.episodeNumber).toBe(59);
    expect(history.recentSceneEvents).toHaveLength(12);
    expect(history.recentSceneEvents[0]?.episodeNumber).toBe(48);
    expect(history.recentSceneEvents.at(-1)?.episodeNumber).toBe(59);
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
