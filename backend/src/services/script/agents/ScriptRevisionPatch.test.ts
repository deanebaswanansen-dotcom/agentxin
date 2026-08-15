import { describe, expect, it } from 'vitest';

import type { ScriptEpisode } from '../domain.js';
import {
  applyScriptRevisionPatch,
  buildScriptRevisionPatchPolicy,
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

function twoSceneEpisode(): ScriptEpisode {
  const base = episode();
  return {
    ...base,
    scenes: [
      base.scenes[0]!,
      {
        id: 'scene-2',
        ordinal: 2,
        location: '后院',
        timeOfDay: 'night',
        interiorExterior: 'exterior',
        characterIds: ['lead'],
        blocks: [
          { id: 'action-2', type: 'action', text: '沈清走进后院。' },
          { id: 'dialogue-2', type: 'dialogue', characterId: 'lead', speaker: '沈清', text: '果然在这里。' },
        ],
      },
    ],
  };
}

const registeredCharacters = new Set(['lead', 'mother']);

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
    const policy = buildScriptRevisionPatchPolicy(base, [{
      code: 'ACTION_STRUCTURE_POLLUTION',
      severity: 'hard',
      sceneId: 'scene-1',
      blockId: 'action-1',
      path: 'blocks.text',
    }], { registeredCharacterIds: registeredCharacters });
    const result = applyScriptRevisionPatch(base, {
      operations: [{
        op: 'replaceBlockText',
        sceneId: 'scene-1',
        blockId: 'action-1',
        text: '沈清攥紧证据推门。',
      }],
    }, undefined, policy);

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
    const base = episode();
    const policy = buildScriptRevisionPatchPolicy(base, [{
      code: 'TOO_SHORT',
      severity: 'hard',
      path: 'scenes',
    }], { registeredCharacterIds: registeredCharacters });
    const result = applyScriptRevisionPatch(base, {
      operations: [
        {
          op: 'insertBlockAfter',
          sceneId: 'scene-1',
          afterBlockId: 'dialogue-1',
          block: { type: 'caption', text: '三天后' },
        },
        {
          op: 'appendBlock',
          sceneId: 'scene-1',
          block: { type: 'action', text: '门外警笛骤响。' },
        },
      ],
    }, () => ids.shift() ?? 'unexpected', policy);

    expect(result.episode.scenes[0]?.blocks.map((block) => block.id)).toEqual([
      'action-1',
      'dialogue-1',
      'inserted-1',
      'inserted-2',
    ]);
    expect(result.insertedBlockIds).toEqual(['inserted-1', 'inserted-2']);
  });

  it('updates only the requested scene character registry', () => {
    const base = episode();
    const policy = buildScriptRevisionPatchPolicy(base, [{
      code: 'SPEAKER_NOT_IN_SCENE',
      severity: 'hard',
      sceneId: 'scene-1',
      blockId: 'dialogue-1',
      path: 'characterIds',
    }], { registeredCharacterIds: registeredCharacters });
    const result = applyScriptRevisionPatch(base, {
      operations: [{
        op: 'updateSceneCharacters',
        sceneId: 'scene-1',
        characterIds: ['lead', 'mother'],
      }],
    }, undefined, policy);

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

describe('ScriptRevisionPatchPolicy', () => {
  it('authorizes only the exact block named by a block-level issue', () => {
    const base = episode();
    const policy = buildScriptRevisionPatchPolicy(base, [{
      code: 'EMPTY_BLOCK_TEXT',
      severity: 'hard',
      sceneId: 'scene-1',
      blockId: 'action-1',
      path: 'blocks.text',
    }], { registeredCharacterIds: registeredCharacters });

    expect(() => applyScriptRevisionPatch(base, {
      operations: [{
        op: 'replaceBlockText',
        sceneId: 'scene-1',
        blockId: 'dialogue-1',
        text: '越权改写。',
      }],
    }, undefined, policy)).toThrow(/未被当前阻断问题授权/u);
    expect(base.scenes[0]?.blocks[1]?.text).toBe('我回来了。');
  });

  it('allows an empty-scene issue to append in that scene, but not edit another field', () => {
    const base = twoSceneEpisode();
    base.scenes[1]!.blocks = [];
    const policy = buildScriptRevisionPatchPolicy(base, [{
      code: 'EMPTY_SCENE',
      severity: 'hard',
      sceneId: 'scene-2',
      path: 'blocks',
    }], { registeredCharacterIds: registeredCharacters });

    const applied = applyScriptRevisionPatch(base, {
      operations: [{
        op: 'appendBlock',
        sceneId: 'scene-2',
        block: { type: 'action', text: '风吹动门帘。' },
      }],
    }, () => 'appended', policy);
    expect(applied.episode.scenes[1]?.blocks).toEqual([
      { id: 'appended', type: 'action', text: '风吹动门帘。' },
    ]);

    expect(() => applyScriptRevisionPatch(base, {
      operations: [{
        op: 'updateSceneCharacters',
        sceneId: 'scene-2',
        characterIds: ['lead', 'mother'],
      }],
    }, undefined, policy)).toThrow(/未被当前阻断问题授权/u);
  });

  it('limits TOO_SHORT expansion to the final scene and its final known anchor', () => {
    const base = twoSceneEpisode();
    const policy = buildScriptRevisionPatchPolicy(base, [{
      code: 'TOO_SHORT',
      severity: 'hard',
      path: 'scenes',
    }], { registeredCharacterIds: registeredCharacters });

    expect(() => applyScriptRevisionPatch(base, {
      operations: [{
        op: 'appendBlock',
        sceneId: 'scene-1',
        block: { type: 'action', text: '越权扩写前场。' },
      }],
    }, undefined, policy)).toThrow(/未被当前阻断问题授权/u);
    expect(() => applyScriptRevisionPatch(base, {
      operations: [{
        op: 'insertBlockAfter',
        sceneId: 'scene-2',
        afterBlockId: 'action-2',
        block: { type: 'action', text: '越权插入中间。' },
      }],
    }, undefined, policy)).toThrow(/未被当前阻断问题授权/u);

    expect(() => applyScriptRevisionPatch(base, {
      operations: [{
        op: 'insertBlockAfter',
        sceneId: 'scene-2',
        afterBlockId: 'dialogue-2',
        block: { type: 'action', text: '院门突然落锁。' },
      }],
    }, () => 'safe-tail', policy)).not.toThrow();
  });

  it('allows TOO_LONG to replace existing block text only', () => {
    const base = twoSceneEpisode();
    const policy = buildScriptRevisionPatchPolicy(base, [{
      code: 'TOO_LONG',
      severity: 'hard',
      path: 'scenes',
    }], { registeredCharacterIds: registeredCharacters });

    expect(() => applyScriptRevisionPatch(base, {
      operations: [{
        op: 'replaceBlockText',
        sceneId: 'scene-2',
        blockId: 'action-2',
        text: '沈清进院。',
      }],
    }, undefined, policy)).not.toThrow();
    expect(() => applyScriptRevisionPatch(base, {
      operations: [{
        op: 'appendBlock',
        sceneId: 'scene-2',
        block: { type: 'action', text: '越权增写。' },
      }],
    }, undefined, policy)).toThrow(/未被当前阻断问题授权/u);
    expect(() => applyScriptRevisionPatch(base, {
      operations: [{
        op: 'replaceBlockText',
        sceneId: 'scene-2',
        blockId: 'action-2',
        text: '沈清慢慢走进后院并环顾四周。',
      }],
    }, undefined, policy)).toThrow(/不得等长或扩写/u);
  });

  it('requires all scene and new-dialogue character IDs to be registered', () => {
    const base = twoSceneEpisode();
    const characterPolicy = buildScriptRevisionPatchPolicy(base, [{
      code: 'SPEAKER_NOT_IN_SCENE',
      severity: 'hard',
      sceneId: 'scene-1',
      blockId: 'dialogue-1',
      path: 'characterIds',
    }], { registeredCharacterIds: registeredCharacters });
    expect(() => applyScriptRevisionPatch(base, {
      operations: [{
        op: 'updateSceneCharacters',
        sceneId: 'scene-1',
        characterIds: ['lead', 'intruder'],
      }],
    }, undefined, characterPolicy)).toThrow(/未登记人物 ID：intruder/u);

    base.scenes[1]!.blocks = [];
    const appendPolicy = buildScriptRevisionPatchPolicy(base, [{
      code: 'EMPTY_SCENE',
      severity: 'hard',
      sceneId: 'scene-2',
      path: 'blocks',
    }], { registeredCharacterIds: registeredCharacters });
    expect(() => applyScriptRevisionPatch(base, {
      operations: [{
        op: 'appendBlock',
        sceneId: 'scene-2',
        block: {
          type: 'dialogue',
          characterId: 'intruder',
          speaker: '陌生人',
          text: '开门。',
        },
      }],
    }, undefined, appendPolicy)).toThrow(/未登记人物 ID：intruder/u);
  });

  it.each([
    { code: 'MODEL_ARTIFACT', severity: 'hard' as const, path: 'scenes' },
    {
      code: 'MISSING_LOCATION',
      severity: 'hard' as const,
      sceneId: 'scene-1',
      path: 'location',
    },
    {
      code: 'UNKNOWN_DIALOGUE_CHARACTER_REFERENCE',
      severity: 'hard' as const,
      sceneId: 'scene-1',
      blockId: 'dialogue-1',
      path: 'characterId',
    },
  ])('returns an explicit non-auto-repair error for unsupported issue $code', (issue) => {
    expect(() => buildScriptRevisionPatchPolicy(
      episode(),
      [issue],
      { registeredCharacterIds: registeredCharacters },
    )).toThrow(/无法安全自动修复/u);
  });

  it('rejects reuse of a policy after the episode revision changes', () => {
    const base = episode();
    const policy = buildScriptRevisionPatchPolicy(base, [{
      code: 'EMPTY_BLOCK_TEXT',
      severity: 'hard',
      sceneId: 'scene-1',
      blockId: 'action-1',
      path: 'blocks.text',
    }], { registeredCharacterIds: registeredCharacters });
    const newer = { ...base, revision: base.revision + 1 };

    expect(() => applyScriptRevisionPatch(newer, {
      operations: [{
        op: 'replaceBlockText',
        sceneId: 'scene-1',
        blockId: 'action-1',
        text: '新内容。',
      }],
    }, undefined, policy)).toThrow(/版本不匹配/u);
  });
});
