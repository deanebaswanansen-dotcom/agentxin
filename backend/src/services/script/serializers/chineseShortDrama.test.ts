import { describe, expect, it } from 'vitest';

import type { ScriptCharacter, ScriptEpisode } from '../domain.js';
import { serializeChineseShortDrama } from './chineseShortDrama.js';

describe('serializeChineseShortDrama', () => {
  it('renders structured scenes as standard Chinese short-drama text', () => {
    const characters = [
      { id: 'c-1', name: '沈清' },
      { id: 'c-2', name: '周慧兰' },
    ] as unknown as ScriptCharacter[];
    const episode = {
      id: 'episode-1',
      projectId: 'project-1',
      episodeNumber: 1,
      title: '新媳妇进门',
      outlineId: 'outline-1',
      status: 'completed',
      targetChars: 300,
      scenes: [
        {
          id: 'scene-1',
          ordinal: 1,
          location: '沈家老宅大门',
          timeOfDay: 'day',
          interiorExterior: 'exterior',
          characterIds: ['c-1', 'c-2'],
          blocks: [
            { id: 'b-1', type: 'caption', text: '沧南市沈家百年老宅' },
            { id: 'b-2', type: 'action', text: '沈清跨过门槛。' },
            {
              id: 'b-3',
              type: 'dialogue',
              characterId: 'c-2',
              speaker: '周慧兰',
              delivery: '嗓子哑',
              text: '恭请太奶奶出房用膳——！',
            },
            {
              id: 'b-4',
              type: 'dialogue',
              characterId: 'c-1',
              speaker: '沈清',
              mode: 'os',
              text: '这规矩，该改改了。',
            },
          ],
        },
      ],
      summary: '',
      newFacts: [],
      openedThreads: [],
      closedThreads: [],
      revision: 1,
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    } satisfies ScriptEpisode;

    expect(serializeChineseShortDrama([episode], characters)).toBe(
      [
        '第一集',
        '',
        '1-1 沈家老宅大门 日/外',
        '人物：沈清 周慧兰',
        '【字幕：沧南市沈家百年老宅】',
        '△沈清跨过门槛。',
        '周慧兰（嗓子哑）：恭请太奶奶出房用膳——！',
        '沈清（os）：这规矩，该改改了。',
      ].join('\n'),
    );
  });
});
