import { describe, expect, it } from 'vitest';

import type { ScriptEpisode, ScriptProjectState } from './domain.js';
import {
  buildScriptAtomicCommitInput,
  buildScriptContinuityCandidate,
  currentScriptContinuityCommits,
} from './ScriptContinuityCommit.js';

function fixture(): { state: ScriptProjectState; episode: ScriptEpisode } {
  const state: ScriptProjectState = {
    schemaVersion: 1,
    projectId: 'project-1',
    plan: {
      id: 'plan-1',
      projectId: 'project-1',
      status: 'locked',
      revision: 3,
      title: '短剧',
      theme: '真相',
      market: 'domestic',
      channel: 'general',
      genres: ['都市'],
      audience: '大众',
      coreConflict: '调查真相',
      logline: '女主调查真相。',
      highlights: [],
      totalEpisodes: 1,
      episodeDurationSeconds: { min: 60, max: 90 },
      targetCharsPerEpisode: 300,
      maxPrimaryCharacters: 8,
      maxScenesPerEpisode: 3,
      dialogueDensityPercent: 50,
      language: 'zh-CN',
      format: 'cn_short_drama',
      coreRequirements: '',
      forbiddenElements: [],
      endingDirection: '公开真相',
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
    },
    characters: [
      {
        id: 'lead', projectId: 'project-1', name: '沈清', aliases: [], role: 'lead',
        identity: '记者', biography: '调查记者', motivation: '追寻真相', goal: '公开证据',
        weakness: '固执', arc: '学会合作', appearance: '利落', hairstyle: '短发', physique: '高挑',
        defaultOutfit: '白衬衫', personality: ['冷静'], skills: ['采访'], speechStyle: '简短',
        catchphrases: [], relationships: [], revision: 5, updatedAt: '2026-08-15T00:00:00.000Z',
      },
      {
        id: 'witness', projectId: 'project-1', name: '证人', aliases: [], role: 'supporting',
        identity: '证人', biography: '掌握线索', motivation: '自保', goal: '说出真相', weakness: '胆小',
        arc: '鼓起勇气', appearance: '普通', hairstyle: '短发', physique: '中等', defaultOutfit: '夹克',
        personality: ['谨慎'], skills: [], speechStyle: '迟疑', catchphrases: [], relationships: [],
        revision: 1, updatedAt: '2026-08-15T00:00:00.000Z',
      },
    ],
    worldBible: {
      projectId: 'project-1',
      era: '2026年',
      primaryLocations: ['校报社'],
      worldState: '当代城市',
      rules: [],
      transport: [],
      communication: ['手机'],
      organizations: ['校报社'],
      recurringProps: ['录音笔'],
      forbiddenAnachronisms: [],
      revision: 2,
      updatedAt: '2026-08-15T00:00:00.000Z',
    },
    episodeOutlines: [],
    episodes: [],
    continuity: { currentState: [], openThreads: [], wardrobeLedger: [] },
    reviewRevision: 0,
    reviewIssues: [],
    updatedAt: '2026-08-15T00:00:00.000Z',
  };
  const episode: ScriptEpisode = {
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
      location: '校报社',
      timeOfDay: 'day',
      interiorExterior: 'interior',
      characterIds: ['lead'],
      blocks: [{ id: 'block-1', type: 'action', text: '沈清拿出录音笔证据。' }],
    }],
    summary: '沈清取得证据。',
    newFacts: ['录音已经备份'],
    openedThreads: ['证人是否出面'],
    closedThreads: [],
    revision: 0,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  };
  return { state, episode };
}

describe('ScriptContinuityCommit', () => {
  it('fingerprints every character revision independently and binds evidence to candidate blocks', () => {
    const { state, episode } = fixture();
    const continuity = buildScriptContinuityCandidate(state, episode);
    const first = buildScriptAtomicCommitInput(state, episode, continuity, {
      promptVersion: 'test-v1',
      modelConfigFingerprint: 'a'.repeat(64),
    });

    expect(first.inputRevisionRefs).toEqual(expect.arrayContaining([
      { resource: 'characters', id: 'lead', revision: 5 },
      { resource: 'characters', id: 'witness', revision: 1 },
    ]));
    expect(first.candidateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(continuity.factsAdded[0]).toMatchObject({ evidenceBlockIds: ['block-1'] });
    expect(continuity.props[0]).toMatchObject({
      name: '录音笔',
      state: '本集正文出现',
      evidenceBlockIds: ['block-1'],
    });
    expect(continuity.timelineEvents[0]).toMatchObject({ evidenceBlockIds: ['block-1'] });

    state.characters[1]!.revision += 1;
    const changed = buildScriptAtomicCommitInput(state, episode, continuity, {
      promptVersion: 'test-v1',
      modelConfigFingerprint: 'a'.repeat(64),
    });
    expect(changed.inputFingerprint).not.toBe(first.inputFingerprint);
  });

  it('keeps the reviewed candidate revision as the atomic CAS expectation', () => {
    const { state, episode } = fixture();
    const reviewedCandidate = { ...episode, revision: 1 };
    state.episodes = [{
      ...episode,
      revision: 2,
      updatedAt: '2026-08-15T00:01:00.000Z',
    }];

    const input = buildScriptAtomicCommitInput(
      state,
      reviewedCandidate,
      buildScriptContinuityCandidate(state, reviewedCandidate),
      {
        promptVersion: 'test-v1',
        modelConfigFingerprint: 'a'.repeat(64),
      },
    );

    expect(input.expectedEpisodeRevision).toBe(1);
    expect(input.inputRevisionRefs).toContainEqual({
      resource: 'episode',
      id: episode.id,
      revision: 2,
    });
  });

  it('drops every successor from canon when an earlier continuity link becomes stale', () => {
    const { state, episode } = fixture();
    const firstEpisode = { ...episode, status: 'completed' as const, revision: 1 };
    const secondEpisode = {
      ...firstEpisode,
      id: 'episode-2',
      episodeNumber: 2,
      title: '第二集',
      revision: 1,
    };
    state.episodes = [firstEpisode, secondEpisode];
    const emptyDelta = {
      characterUpdates: [], factsAdded: [], props: [], threads: [], timelineEvents: [],
      nextEpisodeMustInherit: [],
    };
    state.continuityCommits = [
      {
        ...emptyDelta,
        id: 'continuity-1', schemaVersion: 1, projectId: state.projectId,
        episodeNumber: 1, episodeRevision: 1, revision: 1, status: 'current',
        inputFingerprint: 'a'.repeat(64),
        createdAt: state.updatedAt, updatedAt: state.updatedAt,
      },
      {
        ...emptyDelta,
        id: 'continuity-2', schemaVersion: 1, projectId: state.projectId,
        episodeNumber: 2, episodeRevision: 1, revision: 2, status: 'current',
        inputFingerprint: 'b'.repeat(64),
        previousContinuityCommitId: 'continuity-1', previousContinuityRevision: 1,
        createdAt: state.updatedAt, updatedAt: state.updatedAt,
      },
    ];

    expect(currentScriptContinuityCommits(state).map((commit) => commit.episodeNumber))
      .toEqual([1, 2]);
    state.continuityCommits[0]!.status = 'stale';
    expect(currentScriptContinuityCommits(state)).toEqual([]);
  });
});
