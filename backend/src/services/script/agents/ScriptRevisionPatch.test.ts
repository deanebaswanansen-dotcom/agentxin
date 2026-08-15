import { describe, expect, it } from 'vitest';

import type { ScriptEpisode } from '../domain.js';
import {
  applyScriptRevisionPatch,
  SCRIPT_REVISION_PATCH_CONTRACT,
  ScriptRevisionPatchError,
  type ScriptRevisionOperation,
} from './ScriptRevisionPatch.js';

function episode(): ScriptEpisode {
  return {
    id: 'episode-1',
    projectId: 'project-1',
    episodeNumber: 1,
    title: '第一集',
    outlineId: 'outline-1',
    status: 'reviewing',
    targetChars: 300,
    scenes: [{
      id: 'scene-1',
      ordinal: 1,
      location: '沈家老宅',
      timeOfDay: 'day',
      interiorExterior: 'interior',
      characterIds: ['lead'],
      blocks: [
        { id: 'action-1', type: 'action', text: '沈清推门。' },
        { id: 'dialogue-1', type: 'dialogue', characterId: 'lead', speaker: '沈清', text: '我回来了。' },
      ],
    }],
    summary: '沈清回到老宅。',
    newFacts: [],
    openedThreads: [],
    closedThreads: [],
    revision: 3,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  };
}

describe('SCRIPT_REVISION_PATCH_CONTRACT', () => {
  it('collects field errors and rejects whole-episode or delete operations', () => {
    const decoded = SCRIPT_REVISION_PATCH_CONTRACT.decode({
      operations: [
        { op: 'deleteScene', sceneId: 'scene-1' },
        { op: 'replaceBlockText', sceneId: '', blockId: 'action-1', text: '' },
      ],
    });

    expect(decoded.success).toBe(false);
    if (decoded.success) throw new Error('预期解码失败');
    expect(decoded.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['operations', 0, 'op'], code: 'enum.operation' }),
      expect.objectContaining({ path: ['operations', 1, 'sceneId'], code: 'field.required' }),
      expect.objectContaining({ path: ['operations', 1, 'text'], code: 'field.required' }),
    ]));
  });
});

describe('applyScriptRevisionPatch', () => {
  it('replaces only the targeted block and preserves all canonical episode metadata', () => {
    const base = episode();
    const result = applyScriptRevisionPatch(base, {
      operations: [{
        op: 'replaceBlockText',
        sceneId: 'scene-1',
        blockId: 'action-1',
        text: '沈清攥紧证据推门。',
      }],
    });

    expect(result.episode.scenes[0]?.blocks[0]).toMatchObject({
      id: 'action-1',
      type: 'action',
      text: '沈清攥紧证据推门。',
    });
    expect(result.episode.scenes[0]?.blocks[1]).toEqual(base.scenes[0]?.blocks[1]);
    expect(result.episode).toMatchObject({
      id: base.id,
      episodeNumber: base.episodeNumber,
      outlineId: base.outlineId,
      revision: base.revision,
    });
    expect(base.scenes[0]?.blocks[0]?.text).toBe('沈清推门。');
  });

  it('inserts and appends new blocks with server-owned unique IDs in stable order', () => {
    const ids = ['inserted-1', 'inserted-2'];
    const result = applyScriptRevisionPatch(episode(), {
      operations: [
        {
          op: 'insertBlockAfter',
          sceneId: 'scene-1',
          afterBlockId: 'action-1',
          block: { type: 'caption', text: '三天后' },
        },
        {
          op: 'appendBlock',
          sceneId: 'scene-1',
          block: { type: 'action', text: '门外警笛骤响。' },
        },
      ],
    }, () => ids.shift() ?? 'unexpected');

    expect(result.episode.scenes[0]?.blocks.map((block) => block.id)).toEqual([
      'action-1',
      'inserted-1',
      'dialogue-1',
      'inserted-2',
    ]);
    expect(result.insertedBlockIds).toEqual(['inserted-1', 'inserted-2']);
  });

  it('updates only the requested scene character registry', () => {
    const result = applyScriptRevisionPatch(episode(), {
      operations: [{
        op: 'updateSceneCharacters',
        sceneId: 'scene-1',
        characterIds: ['lead', 'mother'],
      }],
    });

    expect(result.episode.scenes[0]?.characterIds).toEqual(['lead', 'mother']);
    expect(result.episode.scenes[0]?.blocks).toEqual(episode().scenes[0]?.blocks);
  });

  it.each<ScriptRevisionOperation>([
    { op: 'replaceBlockText', sceneId: 'missing', blockId: 'action-1', text: '新动作' },
    { op: 'replaceBlockText', sceneId: 'scene-1', blockId: 'missing', text: '新动作' },
    { op: 'insertBlockAfter', sceneId: 'scene-1', afterBlockId: 'missing', block: { type: 'action', text: '新动作' } },
  ])('rejects stale scene/block references without mutating the base: %j', (operation) => {
    const base = episode();
    expect(() => applyScriptRevisionPatch(base, { operations: [operation] }))
      .toThrow(ScriptRevisionPatchError);
    expect(base).toEqual(episode());
  });

  it('rejects a server-generated block ID collision', () => {
    expect(() => applyScriptRevisionPatch(episode(), {
      operations: [{
        op: 'appendBlock',
        sceneId: 'scene-1',
        block: { type: 'action', text: '新动作' },
      }],
    }, () => 'action-1')).toThrow(/ID 冲突/u);
  });
});
