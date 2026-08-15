import { describe, expect, it } from 'vitest';

import type { ScriptCharacter, ScriptEpisode } from '../domain.js';
import { serializeFountain } from './fountain.js';
import { serializeScriptMarkdown } from './markdown.js';

const characters = [{ id: 'lead', name: '沈清' }] as unknown as ScriptCharacter[];
const episode = {
  id: 'episode-2',
  projectId: 'project-1',
  episodeNumber: 2,
  title: '门缝的秘密',
  outlineId: 'outline-2',
  status: 'completed',
  targetChars: 300,
  scenes: [
    {
      id: 'scene-1',
      ordinal: 1,
      location: '太奶奶房门口',
      timeOfDay: 'night',
      interiorExterior: 'interior',
      characterIds: ['lead'],
      blocks: [
        { id: 'caption', type: 'caption', text: '深夜' },
        { id: 'action', type: 'action', text: '沈清俯身查看门缝。' },
        { id: 'line', type: 'dialogue', characterId: 'lead', speaker: '沈清', mode: 'vo', text: '果然有问题。' },
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

describe('script exchange serializers', () => {
  it('exports Fountain while preserving Chinese captions and VO', () => {
    expect(serializeFountain([episode], characters)).toContain(
      ['# 第2集 门缝的秘密', '', '.INT. 太奶奶房门口 - NIGHT', '', '[[字幕：深夜]]'].join('\n'),
    );
    expect(serializeFountain([episode], characters)).toContain('沈清 (V.O.)\n果然有问题。');
  });

  it('exports navigable Markdown headings without JSON artifacts', () => {
    const value = serializeScriptMarkdown([episode], characters);
    expect(value).toContain('# 第2集 门缝的秘密');
    expect(value).toContain('## 2-1 太奶奶房门口 夜/内');
    expect(value).toContain('**沈清（vo）：**果然有问题。');
    expect(value).not.toContain('```json');
  });

  it('adds a series title and nests episodes and scenes for whole-book Markdown export', () => {
    const value = serializeScriptMarkdown([episode], characters, { title: '绝食逼我道歉？' });

    expect(value).toContain('# 绝食逼我道歉？');
    expect(value).toContain('## 第二集 · 门缝的秘密');
    expect(value).toContain('### 2-1 太奶奶房门口 夜/内');
  });
});
