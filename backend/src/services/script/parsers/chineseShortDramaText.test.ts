import { describe, expect, it } from 'vitest';

import type { ScriptCharacter } from '../domain.js';
import { serializeChineseShortDrama } from '../serializers/chineseShortDrama.js';
import { parseChineseShortDramaText } from './chineseShortDramaText.js';

const characters = [
  { id: 'character-zhou', name: '周野', aliases: ['老周'] },
  { id: 'character-lin', name: '林秋', aliases: [] },
] as unknown as ScriptCharacter[];

function options() {
  let sequence = 0;
  return {
    projectId: 'project-1',
    episodeNumber: 3,
    title: '数据卡',
    outlineId: 'outline-3',
    targetChars: 1_200,
    characters,
    createId: () => `generated-${++sequence}`,
  };
}

describe('parseChineseShortDramaText', () => {
  it('recovers a registered-character dialogue line accidentally prefixed as an action', () => {
    const result = parseChineseShortDramaText([
      '第3集',
      '3-1 修车铺 日/内',
      '人物：周野',
      '△周野：这其实是对白，不是动作。',
    ].join('\n'), options());

    expect(result.episode?.scenes[0]?.blocks).toEqual([
      expect.objectContaining({
        type: 'dialogue',
        characterId: 'character-zhou',
        speaker: '周野',
        text: '这其实是对白，不是动作。',
      }),
    ]);
  });

  it('parses readable Chinese screenplay text and assigns all internal IDs locally', () => {
    const result = parseChineseShortDramaText([
      '第三集',
      '',
      '3-1 老周修车厂 夜/内',
      '人物：周野 林秋',
      '【字幕：凌晨一点】',
      '△卷帘门被风吹得哐当作响。',
      '林秋（压低声音）：十年前的原始数据，不是已经被清空了吗？',
      '周野（OS）：有人比我们更怕这张卡重见天日。',
      '',
      '3-2 废弃赛道 晨/外',
      '人物：老周',
      '△周野踩下油门，旧赛车冲出维修通道。',
    ].join('\n'), options());

    expect(result.unparsedLines).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.episode?.scenes).toHaveLength(2);
    expect(result.episode?.scenes[0]).toMatchObject({
      id: 'generated-1',
      ordinal: 1,
      location: '老周修车厂',
      timeOfDay: 'night',
      interiorExterior: 'interior',
      characterIds: ['character-zhou', 'character-lin'],
    });
    expect(result.episode?.scenes[0]?.blocks[2]).toMatchObject({
      type: 'dialogue',
      characterId: 'character-lin',
      speaker: '林秋',
      delivery: '压低声音',
    });
    expect(result.episode?.scenes[0]?.blocks[3]).toMatchObject({
      type: 'dialogue',
      characterId: 'character-zhou',
      speaker: '周野',
      mode: 'os',
    });
    expect(JSON.stringify(result.episode)).not.toContain('model-id');
  });

  it('retains unknown lines and reports speaker and scene-membership problems', () => {
    const result = parseChineseShortDramaText([
      '解释：下面是我为你写的剧本',
      '3-1 修车厂 日/内',
      '人物：周野 陌生老板',
      '林秋：我从后门进来的。',
      '神秘人：把卡交出来。',
      '这一行没有剧本前缀',
    ].join('\n'), options());

    expect(result.warnings.map((item) => item.code)).toEqual([
      'TEXT_BEFORE_FIRST_SCENE',
      'UNKNOWN_SCENE_CHARACTER',
      'DIALOGUE_CHARACTER_NOT_IN_SCENE',
      'UNKNOWN_DIALOGUE_CHARACTER',
      'UNPARSED_LINE',
    ]);
    expect(result.unparsedLines).toEqual([
      { line: 1, text: '解释：下面是我为你写的剧本' },
      { line: 6, text: '这一行没有剧本前缀' },
    ]);
  });

  it('repairs copied scene episode prefixes instead of discarding an otherwise valid episode', () => {
    const result = parseChineseShortDramaText([
      '第3集 公开挑战',
      '1-1 修车厂 日/内',
      '人物：周野 林秋',
      '△周野把旧赛车服铺在工作台上。',
      '林秋：记者已经到了，我们现在就公开证据。',
      '1-2 赛车场媒体中心 日/内',
      '人物：周野',
      '周野：十年前的记录，今天必须重见天日。',
    ].join('\n'), options());

    expect(result.episode?.episodeNumber).toBe(3);
    expect(result.episode?.scenes.map((scene) => scene.ordinal)).toEqual([1, 2]);
    expect(result.unparsedLines).toEqual([]);
    expect(result.warnings.map((item) => item.code)).toEqual([
      'SCENE_EPISODE_NUMBER_REPAIRED',
      'SCENE_EPISODE_NUMBER_REPAIRED',
    ]);
  });

  it('repairs duplicate scene ordinals without losing scene content or characters', () => {
    const result = parseChineseShortDramaText([
      '第3集',
      '3-1 修车厂 日/内',
      '人物：周野',
      '△周野把数据卡放在工作台上。',
      '3-1 赛道入口 日/外',
      '人物：林秋',
      '林秋：入口的监控已经拿到了。',
      '3-2 维修区 夜/内',
      '人物：周野 林秋',
      '△周野和林秋逐帧核对监控。',
    ].join('\n'), options());

    expect(result.episode?.scenes.map((scene) => scene.ordinal)).toEqual([1, 2, 3]);
    expect(result.episode?.scenes.map((scene) => scene.characterIds)).toEqual([
      ['character-zhou'],
      ['character-lin'],
      ['character-zhou', 'character-lin'],
    ]);
    expect(result.episode?.scenes[0]?.blocks[0]).toMatchObject({
      type: 'action',
      text: '周野把数据卡放在工作台上。',
    });
    expect(result.episode?.scenes[1]?.blocks[0]).toMatchObject({
      type: 'dialogue',
      characterId: 'character-lin',
      text: '入口的监控已经拿到了。',
    });
    expect(result.episode?.scenes[2]?.blocks[0]).toMatchObject({
      type: 'action',
      text: '周野和林秋逐帧核对监控。',
    });
    expect(result.unparsedLines).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        line: 5,
        code: 'SCENE_ORDINAL_REPAIRED',
        message: '重复场号 1 已顺延为 2。',
      }),
      expect.objectContaining({
        line: 8,
        code: 'SCENE_ORDINAL_REPAIRED',
        message: '重复场号 2 已顺延为 3。',
      }),
    ]);
  });

  it('preserves legal non-consecutive scene ordinals', () => {
    const result = parseChineseShortDramaText([
      '第3集',
      '3-3 赛道入口 日/外',
      '人物：周野',
      '△周野走向检录台。',
      '3-4 维修区 夜/内',
      '人物：林秋',
      '林秋：原始记录还在。',
    ].join('\n'), options());

    expect(result.episode?.scenes.map((scene) => scene.ordinal)).toEqual([3, 4]);
    expect(result.unparsedLines).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('accepts numbered scene headings without an episode prefix', () => {
    const result = parseChineseShortDramaText([
      '第4集 证据之争',
      '第1场 市郊资格赛场 日/外',
      '人物：周野',
      '△周野戴上头盔走向发车区。',
      '周野：先拿到资格，决赛再把真相说清楚。',
      '第2场 修车铺 夜/内',
      '人物：周野',
      '字幕：明天就是你的终点。',
    ].join('\n'), options());

    expect(result.episode?.scenes).toHaveLength(2);
    expect(result.episode?.scenes.map((scene) => scene.ordinal)).toEqual([1, 2]);
    expect(result.unparsedLines).toEqual([]);
  });

  it('accepts numbered scene headings that repeat the episode prefix', () => {
    const result = parseChineseShortDramaText([
      '第3集 地下赛邀请',
      '第3-1场 修车铺内 夜/内',
      '人物：周野 林秋',
      '△周野把地下资格赛报名表拍在工作台上。',
      '林秋：这次我跟你一起去。',
      '第3-2场 地下赛车场入口 夜/外',
      '人物：周野',
      '周野：十年了，这口气该出了。',
    ].join('\n'), options());

    expect(result.episode?.scenes).toHaveLength(2);
    expect(result.episode?.scenes.map((scene) => scene.ordinal)).toEqual([1, 2]);
    expect(result.unparsedLines).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('accepts mixed scene-heading families used by Flash drafts', () => {
    const result = parseChineseShortDramaText([
      '第3集',
      '3-1 日/内 修车铺',
      '人物：周野',
      '△周野拧紧螺丝。',
      '3-2 修车铺 日 内',
      '人物：周野',
      '周野：先把车修好。',
      '3-3 修车铺（夜/内）',
      '人物：周野',
      '周野：今晚不能睡。',
    ].join('\n'), options());

    expect(result.unparsedLines).toEqual([]);
    expect(result.episode?.scenes).toHaveLength(3);
    expect(result.episode?.scenes.map((scene) => scene.location)).toEqual(['修车铺', '修车铺', '修车铺']);
    expect(result.episode?.scenes.map((scene) => scene.timeOfDay)).toEqual(['day', 'day', 'night']);
  });

  it('accepts production-order scene headings and first-appearance role notes', () => {
    const result = parseChineseShortDramaText([
      '第3集：',
      '3-1 夜 内 修车厂',
      '人物：周野（四十岁 修车工） 林秋（律师）',
      '【闪回】',
      '△【特写】周野攥紧旧数据卡。',
      '周野OS：十年前的声音又回来了。',
      '林秋VO：有人跟过来了。',
      '【闪回结束】',
    ].join('\n'), options());

    expect(result.unparsedLines).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.episode?.scenes[0]).toMatchObject({
      location: '修车厂',
      timeOfDay: 'night',
      interiorExterior: 'interior',
      characterIds: ['character-zhou', 'character-lin'],
    });
    expect(result.episode?.scenes[0]?.blocks[0]).toMatchObject({ type: 'caption', text: '闪回' });
    expect(result.episode?.scenes[0]?.blocks[1]).toMatchObject({
      type: 'action',
      text: '【特写】周野攥紧旧数据卡。',
    });
    expect(result.episode?.scenes[0]?.blocks[2]).toMatchObject({ type: 'dialogue', speaker: '周野', mode: 'os' });
    expect(result.episode?.scenes[0]?.blocks[3]).toMatchObject({ type: 'dialogue', speaker: '林秋', mode: 'vo' });
    expect(result.episode?.scenes[0]?.blocks[4]).toMatchObject({ type: 'caption', text: '闪回结束' });
  });

  it('accepts an unwrapped caption label as a caption instead of a dialogue speaker', () => {
    const result = parseChineseShortDramaText([
      '第3集',
      '3-1 赛车场 日/外',
      '人物：周野',
      '字幕：十年前事故调查发布会',
      '△周野把旧检测报告放在镜头前。',
    ].join('\n'), options());

    expect(result.unparsedLines).toEqual([]);
    expect(result.episode?.scenes[0]?.blocks[0]).toMatchObject({
      type: 'caption',
      text: '十年前事故调查发布会',
    });
  });

  it('keeps a standalone quoted phone message as on-screen text', () => {
    const result = parseChineseShortDramaText([
      '第3集',
      '3-1 修车厂 夜/内',
      '人物：周野',
      '△手机屏幕突然亮起，出现一条陌生短信。',
      '“证据没了，人也没了。你还要继续吗？”',
    ].join('\n'), options());

    expect(result.unparsedLines).toEqual([]);
    expect(result.episode?.scenes[0]?.blocks[1]).toMatchObject({
      type: 'caption',
      text: '证据没了，人也没了。你还要继续吗？',
    });
  });

  it('keeps bracketed and plain shot directions containing colons as actions', () => {
    const result = parseChineseShortDramaText([
      '第3集',
      '3-1 监控室 夜/内',
      '人物：周野 林秋',
      '【特写】屏幕上，门禁记录滚动刷新，最后一条记录显示：007。',
      '【特写】监控画面时间：凌晨四点二十分。',
      '特写：王强的嘴角微微上扬。',
      '周野：这两条记录对不上。',
    ].join('\n'), options());

    expect(result.unparsedLines).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.episode?.scenes[0]?.blocks).toEqual([
      expect.objectContaining({
        type: 'action',
        text: '【特写】屏幕上，门禁记录滚动刷新，最后一条记录显示：007。',
      }),
      expect.objectContaining({
        type: 'action',
        text: '【特写】监控画面时间：凌晨四点二十分。',
      }),
      expect.objectContaining({
        type: 'action',
        text: '特写：王强的嘴角微微上扬。',
      }),
      expect.objectContaining({
        type: 'dialogue',
        characterId: 'character-zhou',
        speaker: '周野',
      }),
    ]);
  });

  it('round-trips the supported screenplay surface through the existing serializer', () => {
    const parsed = parseChineseShortDramaText([
      '第3集',
      '3-1 修车厂 黄昏/内',
      '人物：周野 林秋',
      '△周野关掉举升机。',
      '林秋（VO）：赛道那边来电话了。',
    ].join('\n'), options());
    const episode = {
      ...parsed.episode!,
      id: 'episode-3',
      projectId: 'project-1',
      revision: 1,
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
      status: 'completed' as const,
    };

    const serialized = serializeChineseShortDrama([episode], characters);
    expect(serialized).toContain('3-1 黄昏 内 修车厂');
    expect(serialized).toContain('林秋VO：赛道那边来电话了。');
  });
});
