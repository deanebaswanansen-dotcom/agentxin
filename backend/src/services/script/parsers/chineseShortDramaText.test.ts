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
    expect(serialized).toContain('3-1 修车厂 黄昏/内');
    expect(serialized).toContain('林秋（vo）：赛道那边来电话了。');
  });
});
