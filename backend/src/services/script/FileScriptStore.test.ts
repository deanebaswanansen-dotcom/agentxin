import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runWithClientId } from '../client/clientScope.js';
import type {
  ScriptCommitEpisodeWithContinuityInput,
  ScriptCharacter,
  ScriptEpisode,
  ScriptEpisodeContinuityCommitInput,
  ScriptPlan,
  ScriptReviewIssue,
} from './domain.js';
import {
  FileScriptStore,
  createClientScopedScriptStore,
} from './FileScriptStore.js';
import {
  ScriptConflictError,
  computeScriptEpisodeCandidateHash,
  computeScriptInputFingerprint,
} from './ScriptStore.js';

function plan(projectId = 'project-1'): ScriptPlan {
  return {
    id: 'plan-1',
    projectId,
    status: 'draft',
    revision: 0,
    title: '沈家风云',
    theme: '打破旧规',
    market: 'domestic',
    channel: 'female',
    genres: ['都市', '家庭'],
    audience: '女性观众',
    coreConflict: '新旧规则冲突',
    logline: '新媳妇用现代方式打破家族绑架。',
    highlights: ['反向打脸'],
    totalEpisodes: 10,
    episodeDurationSeconds: { min: 60, max: 90 },
    targetCharsPerEpisode: 1_200,
    maxPrimaryCharacters: 8,
    maxScenesPerEpisode: 3,
    dialogueDensityPercent: 65,
    language: 'zh-CN',
    format: 'cn_short_drama',
    coreRequirements: '快节奏',
    forbiddenElements: [],
    endingDirection: '和解',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
  };
}

function reviewIssue(overrides: Partial<ScriptReviewIssue> = {}): ScriptReviewIssue {
  return {
    id: 'issue-1',
    projectId: 'project-1',
    episodeNumber: 1,
    code: 'MISSING_SUMMARY',
    severity: 'soft',
    category: 'continuity',
    message: '本集摘要为空。',
    status: 'open',
    source: 'deterministic',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

function episode(overrides: Partial<ScriptEpisode> = {}): ScriptEpisode {
  return {
    id: 'episode-1',
    projectId: 'project-1',
    episodeNumber: 1,
    title: '初入老宅',
    outlineId: 'outline-1',
    status: 'reviewing',
    targetChars: 300,
    scenes: [{
      id: 'scene-1',
      ordinal: 1,
      location: '沈家老宅',
      timeOfDay: 'day',
      interiorExterior: 'interior',
      characterIds: ['character-1'],
      blocks: [{ id: 'block-1', type: 'action', text: '沈清推门走进老宅。' }],
    }],
    summary: '沈清第一次进入老宅。',
    newFacts: ['沈清已经进入老宅'],
    openedThreads: ['绝食真相'],
    closedThreads: [],
    revision: 0,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

function character(overrides: Partial<ScriptCharacter> = {}): ScriptCharacter {
  return {
    id: 'character-1',
    projectId: 'project-1',
    name: '沈清',
    aliases: [],
    role: 'lead',
    age: 25,
    occupation: '美食工作室老板',
    identity: '沈家新媳妇',
    biography: '独立创业后第一次随男友回老宅。',
    motivation: '保护家人并打破不合理旧规。',
    goal: '让家人正常吃饭。',
    weakness: '容易替受压迫者承担风险。',
    arc: '从旁观者成为家庭秩序的重建者。',
    appearance: '目光坚定。',
    hairstyle: '黑色高马尾',
    physique: '高挑利落',
    defaultOutfit: '白色衬衫',
    personality: ['冷静', '果断'],
    skills: ['烹饪'],
    speechStyle: '简洁有力',
    catchphrases: [],
    relationships: [],
    revision: 0,
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

async function registerCharacters(store: FileScriptStore): Promise<void> {
  await store.saveCharacters('project-1', [character()], 0);
}

function continuity(
  overrides: Partial<ScriptEpisodeContinuityCommitInput> = {},
): ScriptEpisodeContinuityCommitInput {
  return {
    characterUpdates: [{
      characterId: 'character-1',
      location: '沈家老宅',
      knownFactsAdded: ['沈家要求儿媳跪请长辈用餐'],
      relationshipChanges: [],
      outfit: '白色衬衫',
    }],
    factsAdded: [{
      factId: 'fact-kneeling-rule',
      text: '沈家要求儿媳跪请长辈用餐',
      evidenceBlockIds: ['block-1'],
    }],
    props: [{
      propId: 'prop-noodle-box',
      name: '泡面桶',
      state: '藏在床下',
      evidenceBlockIds: ['block-1'],
    }],
    threads: [{
      threadId: 'thread-hunger-strike',
      action: 'opened',
      description: '太奶奶绝食的真相',
      evidenceBlockIds: ['block-1'],
    }],
    timelineEvents: [{
      eventId: 'event-enter-house',
      timeLabel: '第一集白天',
      summary: '沈清进入沈家老宅。',
      causeEventIds: [],
      evidenceBlockIds: ['block-1'],
    }],
    nextEpisodeMustInherit: ['沈清已经察觉绝食有蹊跷'],
    ...overrides,
  };
}

function commitInput(
  value: ScriptEpisode,
  overrides: Partial<ScriptCommitEpisodeWithContinuityInput> = {},
): ScriptCommitEpisodeWithContinuityInput {
  const candidateHash = overrides.candidateHash
    ?? computeScriptEpisodeCandidateHash(value);
  const partial = {
    episode: value,
    expectedEpisodeRevision: value.revision,
    continuity: continuity(),
    inputRevisionRefs: [{ resource: 'plan' as const, id: 'plan-1', revision: 1 }],
    upstreamArtifactRefs: [{ node: 'review', artifactRevision: 1, artifactHash: 'review-hash' }],
    promptVersion: 'episode-v1',
    modelConfigFingerprint: 'model-fingerprint',
    candidateHash,
    ...overrides,
  };
  return {
    ...partial,
    inputFingerprint: overrides.inputFingerprint
      ?? computeScriptInputFingerprint(partial),
  };
}

describe('FileScriptStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'script-store-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('atomically persists a project and restores it after restart', async () => {
    const store = await FileScriptStore.create(root);
    const saved = await store.savePlan(plan(), 0);

    expect(saved.revision).toBe(1);
    const files = await readdir(root);
    expect(files).toEqual(['project-1.json']);
    expect(files.some((file) => file.includes('.tmp-'))).toBe(false);

    const restarted = await FileScriptStore.create(root);
    expect((await restarted.getProjectState('project-1'))?.plan).toEqual(saved);
  });

  it('rejects a stale revision without overwriting the current artifact', async () => {
    const store = await FileScriptStore.create(root);
    const first = await store.savePlan(plan(), 0);

    await expect(
      store.savePlan({ ...first, title: '过期修改' }, 0),
    ).rejects.toBeInstanceOf(ScriptConflictError);
    expect((await store.getProjectState('project-1'))?.plan?.title).toBe('沈家风云');
  });

  it('serializes concurrent compare-and-save operations so only one wins', async () => {
    const store = await FileScriptStore.create(root);

    const results = await Promise.allSettled([
      store.savePlan({ ...plan(), title: 'A' }, 0),
      store.savePlan({ ...plan(), title: 'B' }, 0),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await store.getProjectState('project-1'))?.plan?.revision).toBe(1);
  });

  it('isolates identical project ids by the request client id', async () => {
    const store = createClientScopedScriptStore(root);
    const clientA = 'a'.repeat(64);
    const clientB = 'b'.repeat(64);

    await runWithClientId(clientA, () => store.savePlan({ ...plan(), title: 'A' }, 0));
    await runWithClientId(clientB, () => store.savePlan({ ...plan(), title: 'B' }, 0));

    const titleA = await runWithClientId(
      clientA,
      async () => (await store.getProjectState('project-1'))?.plan?.title,
    );
    const titleB = await runWithClientId(
      clientB,
      async () => (await store.getProjectState('project-1'))?.plan?.title,
    );
    expect([titleA, titleB]).toEqual(['A', 'B']);
    expect(await readdir(root)).toEqual([clientA, clientB]);
  });

  it('deletes the project file without touching another project', async () => {
    const store = await FileScriptStore.create(root);
    await store.savePlan(plan('project-1'), 0);
    await store.savePlan(plan('project-2'), 0);

    await store.deleteProject('project-1');

    expect(await store.getProjectState('project-1')).toBeUndefined();
    expect((await store.getProjectState('project-2'))?.plan).toBeDefined();
    expect(await readdir(root)).toEqual(['project-2.json']);
  });

  it('atomically saves continuity ledgers without exposing mutable store state', async () => {
    const store = await FileScriptStore.create(root);
    const saved = await store.saveContinuity('project-1', {
      currentState: ['沈清已发现泡面桶'],
      openThreads: ['太奶奶的绝食谎言'],
      wardrobeLedger: [
        { episodeNumber: 1, characterId: 'character-1', outfit: '白衬衫与黑色西装裤' },
      ],
    });
    saved.currentState.push('外部篡改');

    const restarted = await FileScriptStore.create(root);
    expect((await restarted.getProjectState('project-1'))?.continuity).toEqual({
      currentState: ['沈清已发现泡面桶'],
      openThreads: ['太奶奶的绝食谎言'],
      wardrobeLedger: [
        { episodeNumber: 1, characterId: 'character-1', outfit: '白衬衫与黑色西装裤' },
      ],
    });
  });

  it('rejects unknown schema versions instead of overwriting them', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'project-1.json'),
      JSON.stringify({ schemaVersion: 99, projectId: 'project-1' }),
      'utf8',
    );
    const store = await FileScriptStore.create(root);

    await expect(store.getProjectState('project-1')).rejects.toMatchObject({
      code: 'STORE_ERROR',
    });
    expect(JSON.parse(await readFile(join(root, 'project-1.json'), 'utf8'))).toMatchObject({
      schemaVersion: 99,
    });
  });

  it('atomically commits a completed episode with one matching current continuity commit', async () => {
    const store = await FileScriptStore.create(root);
    await store.savePlan(plan(), 0);
    await registerCharacters(store);
    const draft = await store.saveEpisode(episode(), 0);

    const committed = await store.commitEpisodeWithContinuity(commitInput(draft));

    expect(committed.episode).toMatchObject({ status: 'completed', revision: 2 });
    expect(committed.continuity).toMatchObject({
      schemaVersion: 1,
      episodeNumber: 1,
      episodeRevision: 2,
      revision: 1,
      status: 'current',
      inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      factsAdded: [expect.objectContaining({ factId: 'fact-kneeling-rule' })],
      props: [expect.objectContaining({ propId: 'prop-noodle-box' })],
      threads: [expect.objectContaining({ threadId: 'thread-hunger-strike' })],
      timelineEvents: [expect.objectContaining({ eventId: 'event-enter-house' })],
    });

    const restarted = await FileScriptStore.create(root);
    const state = await restarted.getProjectState('project-1');
    expect(state?.episodes).toEqual([committed.episode]);
    expect(state?.continuityCommits).toEqual([committed.continuity]);
  });

  it('downgrades an edited completed episode and stales its commit in the same mutation', async () => {
    const store = await FileScriptStore.create(root);
    await store.savePlan(plan(), 0);
    await registerCharacters(store);
    const draft = await store.saveEpisode(episode(), 0);
    const first = await store.commitEpisodeWithContinuity(commitInput(draft));

    const edited = await store.saveEpisode({
      ...first.episode,
      status: 'completed',
      title: '修改后的标题',
    }, first.episode.revision);

    expect(edited).toMatchObject({ status: 'reviewing', revision: 3 });
    let state = await store.getProjectState('project-1');
    expect(state?.continuityCommits).toEqual([
      expect.objectContaining({ id: first.continuity.id, status: 'stale' }),
    ]);
    expect(state?.continuityCommits?.filter((item) => item.status === 'current')).toHaveLength(0);

    const second = await store.commitEpisodeWithContinuity(commitInput(edited, {
      continuity: continuity({
        threads: [{
          threadId: 'thread-hunger-strike',
          action: 'advanced',
          description: '沈清发现泡面桶线索',
          evidenceBlockIds: ['block-1'],
        }],
      }),
    }));
    state = await store.getProjectState('project-1');
    expect(second.episode).toMatchObject({ status: 'completed', revision: 4 });
    expect(second.continuity).toMatchObject({ status: 'current', revision: 2 });
    expect(state?.continuityCommits).toHaveLength(2);
    expect(state?.continuityCommits?.filter((item) => item.status === 'current')).toEqual([
      expect.objectContaining({ id: second.continuity.id, episodeRevision: 4 }),
    ]);
  });

  it('links the next episode to the current preceding continuity revision', async () => {
    const store = await FileScriptStore.create(root);
    await store.savePlan(plan(), 0);
    await registerCharacters(store);
    const firstDraft = await store.saveEpisode(episode(), 0);
    const first = await store.commitEpisodeWithContinuity(commitInput(firstDraft));
    const secondDraft = await store.saveEpisode(episode({
      id: 'episode-2',
      episodeNumber: 2,
      title: '泡面疑云',
      scenes: [{
        ...episode().scenes[0]!,
        id: 'scene-2',
        blocks: [{ id: 'block-2', type: 'action', text: '沈清循着气味来到后窗。' }],
      }],
      revision: 0,
    }), 0);

    const second = await store.commitEpisodeWithContinuity(commitInput(secondDraft, {
      continuity: continuity({
        factsAdded: [{
          factId: 'fact-window-clue',
          text: '沈清循着气味来到后窗',
          evidenceBlockIds: ['block-2'],
        }],
        props: [],
        threads: [{
          threadId: 'thread-hunger-strike',
          action: 'advanced',
          description: '沈清开始寻找绝食真相',
          evidenceBlockIds: ['block-2'],
        }],
        timelineEvents: [{
          eventId: 'event-find-window',
          timeLabel: '第二集夜晚',
          summary: '沈清循着泡面味来到后窗。',
          causeEventIds: ['event-enter-house'],
          evidenceBlockIds: ['block-2'],
        }],
      }),
      inputRevisionRefs: [
        { resource: 'plan', id: 'plan-1', revision: 1 },
        {
          resource: 'continuity',
          id: first.continuity.id,
          revision: first.continuity.revision,
        },
      ],
    }));

    expect(second.continuity).toMatchObject({
      episodeNumber: 2,
      revision: 2,
      previousContinuityCommitId: first.continuity.id,
      previousContinuityRevision: first.continuity.revision,
    });
  });

  it('rejects episode N when episode N-1 is missing or lacks a matching current commit', async () => {
    const missingPrevious = await FileScriptStore.create(join(root, 'missing-previous'));
    await missingPrevious.savePlan(plan(), 0);
    await registerCharacters(missingPrevious);
    const orphanDraft = await missingPrevious.saveEpisode(episode({
      id: 'episode-2',
      episodeNumber: 2,
    }), 0);
    await expect(missingPrevious.commitEpisodeWithContinuity(commitInput(orphanDraft)))
      .rejects.toThrow('第 1 集必须处于已完成状态');
    expect((await missingPrevious.getProjectState('project-1'))?.episodes).toEqual([orphanDraft]);
    expect((await missingPrevious.getProjectState('project-1'))?.continuityCommits).toEqual([]);

    const missingCommit = await FileScriptStore.create(join(root, 'missing-commit'));
    await missingCommit.savePlan(plan(), 0);
    await registerCharacters(missingCommit);
    const firstDraft = await missingCommit.saveEpisode(episode(), 0);
    const legacyCompleted = await missingCommit.saveEpisode({
      ...firstDraft,
      status: 'completed',
    }, firstDraft.revision);
    expect(legacyCompleted.status).toBe('completed');
    const secondDraft = await missingCommit.saveEpisode(episode({
      id: 'episode-2',
      episodeNumber: 2,
    }), 0);

    await expect(missingCommit.commitEpisodeWithContinuity(commitInput(secondDraft)))
      .rejects.toThrow('缺少与最新正文版本匹配的连续性提交');
    const state = await missingCommit.getProjectState('project-1');
    expect(state?.episodes.find((item) => item.episodeNumber === 2)).toEqual(secondDraft);
    expect(state?.continuityCommits).toEqual([]);
  });

  it('rejects invalid continuity references and IDs without partially completing the episode', async () => {
    const store = await FileScriptStore.create(root);
    await store.savePlan(plan(), 0);
    await registerCharacters(store);
    const draft = await store.saveEpisode(episode(), 0);
    const valid = continuity();
    const invalidCases: Array<{
      expectedMessage: string;
      value: ScriptEpisodeContinuityCommitInput;
    }> = [
      {
        expectedMessage: '不属于候选正文的证据块',
        value: continuity({
          factsAdded: [{
            ...valid.factsAdded[0]!,
            evidenceBlockIds: ['missing-block'],
          }],
        }),
      },
      {
        expectedMessage: '人物更新引用了未登记人物',
        value: continuity({
          characterUpdates: [{
            ...valid.characterUpdates[0]!,
            characterId: 'unknown-character',
          }],
        }),
      },
      {
        expectedMessage: '道具持有人未登记',
        value: continuity({
          props: [{
            ...valid.props[0]!,
            holderCharacterId: 'unknown-character',
          }],
        }),
      },
      {
        expectedMessage: '事实 ID 在同一连续性提交中必须唯一',
        value: continuity({
          factsAdded: [valid.factsAdded[0]!, { ...valid.factsAdded[0]! }],
        }),
      },
      {
        expectedMessage: '道具 ID 在同一连续性提交中必须唯一',
        value: continuity({
          props: [valid.props[0]!, { ...valid.props[0]! }],
        }),
      },
      {
        expectedMessage: '伏笔 ID 在同一连续性提交中必须唯一',
        value: continuity({
          threads: [valid.threads[0]!, { ...valid.threads[0]! }],
        }),
      },
      {
        expectedMessage: '时间事件 ID 在同一连续性提交中必须唯一',
        value: continuity({
          timelineEvents: [valid.timelineEvents[0]!, { ...valid.timelineEvents[0]! }],
        }),
      },
      {
        expectedMessage: '事实 ID 不能为空',
        value: continuity({
          factsAdded: [{ ...valid.factsAdded[0]!, factId: '  ' }],
        }),
      },
      {
        expectedMessage: '引用了无法解析的原因事件',
        value: continuity({
          timelineEvents: [{
            ...valid.timelineEvents[0]!,
            causeEventIds: ['missing-cause-event'],
          }],
        }),
      },
    ];

    for (const invalid of invalidCases) {
      await expect(store.commitEpisodeWithContinuity(commitInput(draft, {
        continuity: invalid.value,
      }))).rejects.toThrow(invalid.expectedMessage);
      const state = await store.getProjectState('project-1');
      expect(state?.episodes).toEqual([draft]);
      expect(state?.continuityCommits).toEqual([]);
    }
  });

  it('rejects stale canon or a replaced candidate without partially committing either resource', async () => {
    const store = await FileScriptStore.create(root);
    const firstPlan = await store.savePlan(plan(), 0);
    await registerCharacters(store);
    const draft = await store.saveEpisode(episode(), 0);
    const staleInput = commitInput(draft);
    await store.savePlan({ ...firstPlan, title: '策划已更新' }, firstPlan.revision);

    await expect(store.commitEpisodeWithContinuity(staleInput))
      .rejects.toBeInstanceOf(ScriptConflictError);
    await expect(store.commitEpisodeWithContinuity(commitInput(draft, {
      inputRevisionRefs: [{ resource: 'plan', id: 'plan-1', revision: 2 }],
      candidateHash: '0'.repeat(64),
    }))).rejects.toBeInstanceOf(ScriptConflictError);
    await expect(store.commitEpisodeWithContinuity(commitInput(draft, {
      inputRevisionRefs: [{ resource: 'plan', id: 'plan-1', revision: 2 }],
      inputFingerprint: '0'.repeat(64),
    }))).rejects.toBeInstanceOf(ScriptConflictError);

    const state = await store.getProjectState('project-1');
    expect(state?.episodes).toEqual([draft]);
    expect(state?.continuityCommits).toEqual([]);
  });

  it('serializes concurrent atomic completions so only one current commit is created', async () => {
    const store = await FileScriptStore.create(root);
    await store.savePlan(plan(), 0);
    await registerCharacters(store);
    const draft = await store.saveEpisode(episode(), 0);
    const results = await Promise.allSettled([
      store.commitEpisodeWithContinuity(commitInput({ ...draft, title: '候选 A' })),
      store.commitEpisodeWithContinuity(commitInput({ ...draft, title: '候选 B' })),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const state = await store.getProjectState('project-1');
    expect(state?.episodes[0]).toMatchObject({ status: 'completed', revision: 2 });
    expect(state?.continuityCommits?.filter((item) => item.status === 'current')).toHaveLength(1);
  });

  it('idempotently defaults review state when loading a legacy schemaVersion 1 file', async () => {
    await writeFile(
      join(root, 'project-1.json'),
      JSON.stringify({
        schemaVersion: 1,
        projectId: 'project-1',
        characters: [],
        episodeOutlines: [],
        episodes: [],
        continuity: { currentState: [], openThreads: [], wardrobeLedger: [] },
        updatedAt: '2026-08-14T00:00:00.000Z',
      }),
      'utf8',
    );

    const store = await FileScriptStore.create(root);
    const first = await store.getProjectState('project-1');
    const second = await store.getProjectState('project-1');

    expect(first).toMatchObject({
      continuityCommits: [],
      reviewRevision: 0,
      reviewIssues: [],
    });
    expect(second).toEqual(first);
  });

  it('persists review issues with collection conflicts and safely replaces one episode source', async () => {
    const store = await FileScriptStore.create(root);
    const userIssue = reviewIssue({ id: 'user-1', source: 'user', code: 'USER_NOTE' });
    const deterministic = reviewIssue();
    const first = await store.saveReviewIssues('project-1', [userIssue, deterministic], 0);
    expect(first.revision).toBe(1);

    await expect(
      store.saveReviewIssues('project-1', [], 0),
    ).rejects.toBeInstanceOf(ScriptConflictError);

    const replaced = await store.replaceEpisodeReviewIssues(
      'project-1',
      1,
      ['deterministic'],
      [reviewIssue({ id: 'new-id', message: '摘要仍为空。' })],
      1,
    );
    expect(replaced.revision).toBe(2);
    expect(replaced.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'user-1', source: 'user' }),
      expect.objectContaining({ id: 'issue-1', source: 'deterministic', message: '摘要仍为空。' }),
    ]));
  });

  it('reuses review ids one-to-one when multiple findings share the same fingerprint', async () => {
    const store = await FileScriptStore.create(root);
    await store.saveReviewIssues('project-1', [
      reviewIssue({ id: 'issue-1', message: '第一处问题' }),
      reviewIssue({ id: 'issue-2', message: '第二处问题' }),
    ], 0);

    const replaced = await store.replaceEpisodeReviewIssues(
      'project-1',
      1,
      ['deterministic'],
      [
        reviewIssue({ id: 'generated-1', message: '第一处问题已重新定位' }),
        reviewIssue({ id: 'generated-2', message: '第二处问题已重新定位' }),
      ],
      1,
    );

    expect(replaced.items.map((item) => item.id).sort()).toEqual(['issue-1', 'issue-2']);
    expect(new Set(replaced.items.map((item) => item.id)).size).toBe(2);
  });
});
