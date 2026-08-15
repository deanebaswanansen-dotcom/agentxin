import { describe, expect, it } from 'vitest';

import type { ScriptEpisode, ScriptPlannedScene } from '../domain.js';
import {
  buildScriptEpisodeCandidateArtifact,
  buildScriptScenePlanArtifact,
  buildScriptUpstreamArtifactRef,
  computeScriptCheckpointArtifactHash,
  computeScriptCheckpointInputFingerprint,
  decodeScriptEpisodeCandidateArtifact,
  decodeScriptScenePlanArtifact,
  decideScriptCheckpointResume,
  InMemoryScriptCheckpointStore,
  latestScriptCheckpoint,
  nextScriptCheckpointArtifactRevision,
  type ScriptCheckpointArtifactBuildContext,
  type ScriptCheckpointArtifactExpectation,
  type ScriptPipelineCheckpoint,
} from './ScriptCheckpoint.js';

function checkpoint(
  overrides: Partial<ScriptPipelineCheckpoint> = {},
): ScriptPipelineCheckpoint {
  return {
    schemaVersion: 2,
    projectId: 'project-1',
    runKey: 'script_episode_batch:1:5',
    node: 'draft',
    status: 'succeeded',
    attempt: 1,
    artifactRevision: 4,
    episodeNumber: 2,
    inputRevisionRefs: [
      { resource: 'outline', id: 'outline-2', revision: 4 },
      { resource: 'plan', id: 'plan-1', revision: 3 },
    ],
    upstreamArtifactRefs: [
      { node: 'scene_plan', artifactRevision: 4, artifactHash: 'scene-plan-hash' },
    ],
    promptVersion: 'draft-v2',
    configRevision: 'model-config-v3',
    inputFingerprint: 'a'.repeat(64),
    validationErrors: [],
    artifact: { title: '第二集' },
    updatedAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  };
}

function artifactContext(
  overrides: Partial<ScriptCheckpointArtifactBuildContext> = {},
): ScriptCheckpointArtifactBuildContext {
  return {
    projectId: 'project-1',
    episodeNumber: 2,
    baseEpisodeRevision: 7,
    inputRevisionRefs: [
      { resource: 'plan', id: 'plan-1', revision: 3 },
      { resource: 'outline', id: 'outline-2', revision: 4 },
    ],
    upstreamArtifactRefs: [],
    promptVersion: 'draft-v2',
    configRevision: 'model-config-v3',
    validationErrors: [],
    createdAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  };
}

function plannedScenes(): ScriptPlannedScene[] {
  return [{
    ordinal: 1,
    location: '校报社',
    timeOfDay: 'day',
    interiorExterior: 'interior',
    purpose: '取得关键证据',
  }];
}

function candidateEpisode(): ScriptEpisode {
  return {
    id: 'episode-2',
    projectId: 'project-1',
    episodeNumber: 2,
    title: '证人出现',
    outlineId: 'outline-2',
    status: 'reviewing',
    targetChars: 600,
    scenes: [{
      id: 'scene-2-1',
      ordinal: 1,
      location: '校报社',
      timeOfDay: 'day',
      interiorExterior: 'interior',
      characterIds: ['lead'],
      blocks: [{ id: 'block-2-1', type: 'action', text: '沈清打开录音笔。' }],
    }],
    summary: '沈清取得关键证据。',
    newFacts: ['录音笔保存着证词'],
    openedThreads: ['证人为何失踪'],
    closedThreads: [],
    revision: 7,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  };
}

function expectation(artifact: {
  projectId: string;
  episodeNumber: number;
  baseEpisodeRevision: number;
  inputFingerprint: string;
  candidateHash: string;
}): ScriptCheckpointArtifactExpectation {
  return {
    projectId: artifact.projectId,
    episodeNumber: artifact.episodeNumber,
    baseEpisodeRevision: artifact.baseEpisodeRevision,
    inputFingerprint: artifact.inputFingerprint,
    candidateHash: artifact.candidateHash,
  };
}

describe('script checkpoint v2 recovery', () => {
  it('selects the highest artifact revision independent of list and timestamp order', () => {
    const latest = checkpoint({
      artifactRevision: 6,
      updatedAt: '2026-08-14T00:00:00.000Z',
      artifact: { title: '第六版' },
    });
    const older = checkpoint({
      artifactRevision: 5,
      updatedAt: '2099-08-14T00:00:00.000Z',
      artifact: { title: '第五版' },
    });

    expect(latestScriptCheckpoint([older, latest], {
      node: 'draft',
      episodeNumber: 2,
    })).toEqual(latest);
    expect(nextScriptCheckpointArtifactRevision([latest, older], {
      node: 'draft',
      episodeNumber: 2,
    })).toBe(7);
  });

  it('keeps immutable revisions in memory and permits status-only updates', async () => {
    const store = new InMemoryScriptCheckpointStore();
    const running = checkpoint({ status: 'running', artifactRevision: 4 });
    const succeeded = checkpoint({
      status: 'succeeded',
      attempt: 2,
      artifactRevision: 4,
      updatedAt: '2026-08-15T00:01:00.000Z',
    });
    const revisionFive = checkpoint({
      artifactRevision: 5,
      artifact: { title: '第五版' },
      updatedAt: '2026-08-15T00:02:00.000Z',
    });

    await store.save(running);
    await store.save(succeeded);
    await store.save(revisionFive);
    await expect(store.save(checkpoint({
      artifactRevision: 5,
      artifact: { title: '原地篡改' },
    }))).rejects.toThrow(/不可原地改写/);

    const history = await store.list(running.projectId, running.runKey);
    expect(history).toEqual([succeeded, revisionFive]);
    expect(latestScriptCheckpoint(history, {
      node: 'draft',
      episodeNumber: 2,
    })).toEqual(revisionFive);
  });

  it('materializes an empty revision without allowing its provenance to change', async () => {
    const store = new InMemoryScriptCheckpointStore();
    const running = checkpoint({
      status: 'running',
      artifactRevision: 7,
      artifact: undefined,
    });
    await store.save(running);

    await expect(store.save(checkpoint({
      status: 'succeeded',
      artifactRevision: 7,
      artifact: { title: '候选' },
      inputFingerprint: 'b'.repeat(64),
    }))).rejects.toThrow(/不可原地改写 provenance/);

    const materialized = checkpoint({
      status: 'succeeded',
      attempt: 2,
      artifactRevision: 7,
      artifact: { title: '候选' },
      updatedAt: '2026-08-15T00:03:00.000Z',
    });
    await store.save(materialized);
    expect(await store.list(running.projectId, running.runKey)).toEqual([materialized]);
  });

  it('computes the same fingerprint regardless of revision-ref input order', () => {
    const left = computeScriptCheckpointInputFingerprint({
      node: 'draft',
      inputRevisionRefs: [
        { resource: 'outline', id: 'outline-2', revision: 4 },
        { resource: 'plan', id: 'plan-1', revision: 3 },
      ],
      upstreamArtifactRefs: [
        { node: 'scene_plan', artifactRevision: 4, artifactHash: 'scene-plan-hash' },
        { node: 'episode_outline', artifactRevision: 4, artifactHash: 'outline-hash' },
      ],
      promptVersion: 'draft-v2',
      configRevision: 'model-config-v3',
    });
    const right = computeScriptCheckpointInputFingerprint({
      node: 'draft',
      inputRevisionRefs: [
        { resource: 'plan', id: 'plan-1', revision: 3 },
        { resource: 'outline', id: 'outline-2', revision: 4 },
      ],
      upstreamArtifactRefs: [
        { node: 'episode_outline', artifactRevision: 4, artifactHash: 'outline-hash' },
        { node: 'scene_plan', artifactRevision: 4, artifactHash: 'scene-plan-hash' },
      ],
      promptVersion: 'draft-v2',
      configRevision: 'model-config-v3',
    });

    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(right).toBe(left);
  });

  it('changes the fingerprint when canon, prompt, config, upstream or node changes', () => {
    const base = {
      node: 'draft',
      inputRevisionRefs: [{ resource: 'plan' as const, id: 'plan-1', revision: 3 }],
      upstreamArtifactRefs: [
        { node: 'scene_plan', artifactRevision: 4, artifactHash: 'scene-plan-hash' },
      ],
      promptVersion: 'draft-v2',
      configRevision: 'model-config-v3',
    };
    const fingerprint = computeScriptCheckpointInputFingerprint(base);

    expect(computeScriptCheckpointInputFingerprint({
      ...base,
      inputRevisionRefs: [{ resource: 'plan', id: 'plan-1', revision: 4 }],
    })).not.toBe(fingerprint);
    expect(computeScriptCheckpointInputFingerprint({
      ...base,
      upstreamArtifactRefs: [{ ...base.upstreamArtifactRefs[0]!, artifactRevision: 5 }],
    })).not.toBe(fingerprint);
    expect(computeScriptCheckpointInputFingerprint({ ...base, promptVersion: 'draft-v3' }))
      .not.toBe(fingerprint);
    expect(computeScriptCheckpointInputFingerprint({ ...base, configRevision: 'model-config-v4' }))
      .not.toBe(fingerprint);
    expect(computeScriptCheckpointInputFingerprint({ ...base, node: 'review' }))
      .not.toBe(fingerprint);
  });

  it('reuses only a succeeded checkpoint with the same verified fingerprint', () => {
    const fingerprint = computeScriptCheckpointInputFingerprint({
      node: 'draft',
      inputRevisionRefs: [],
      promptVersion: 'draft-v2',
      configRevision: 'model-config-v3',
    });

    expect(decideScriptCheckpointResume(
      checkpoint({ inputFingerprint: fingerprint }),
      fingerprint,
    )).toMatchObject({ disposition: 'reuse', checkpoint: { status: 'succeeded' } });
    expect(decideScriptCheckpointResume(
      checkpoint({ status: 'needs_review', inputFingerprint: fingerprint }),
      fingerprint,
    )).toMatchObject({ disposition: 'resume', checkpoint: { status: 'needs_review' } });
  });

  it('marks changed or unverifiable inputs stale without mutating the stored value', () => {
    const original = checkpoint({ inputFingerprint: 'b'.repeat(64) });
    const changed = decideScriptCheckpointResume(original, 'c'.repeat(64));
    const legacy = decideScriptCheckpointResume(
      checkpoint({ inputFingerprint: '' }),
      'c'.repeat(64),
    );

    expect(changed).toMatchObject({ disposition: 'stale', checkpoint: { status: 'stale' } });
    expect(legacy).toMatchObject({ disposition: 'stale', checkpoint: { status: 'stale' } });
    expect(original.status).toBe('succeeded');
  });

  it('builds and strictly decodes a versioned scene-plan artifact', () => {
    const context = artifactContext({
      baseEpisodeRevision: 4,
      promptVersion: 'scene-plan-v1',
    });
    const artifact = buildScriptScenePlanArtifact(context, plannedScenes());

    expect(artifact).toMatchObject({
      schemaVersion: 1,
      stage: 'scene_plan',
      projectId: 'project-1',
      episodeNumber: 2,
      baseEpisodeRevision: 4,
      inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      candidateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      validationErrors: [],
      plannedScenes: plannedScenes(),
    });
    expect(decodeScriptScenePlanArtifact(artifact, expectation(artifact))).toEqual(artifact);
    expect(buildScriptUpstreamArtifactRef('scene_plan', 5, artifact)).toEqual({
      node: 'scene_plan',
      artifactRevision: 5,
      artifactHash: computeScriptCheckpointArtifactHash({
        schemaVersion: artifact.schemaVersion,
        stage: artifact.stage,
        projectId: artifact.projectId,
        episodeNumber: artifact.episodeNumber,
        baseEpisodeRevision: artifact.baseEpisodeRevision,
        inputFingerprint: artifact.inputFingerprint,
        candidateHash: artifact.candidateHash,
      }),
    });
  });

  it('uses stable typed-artifact identity for upstream refs and preserves legacy hashing', () => {
    const artifact = buildScriptScenePlanArtifact(
      artifactContext({ baseEpisodeRevision: 4, promptVersion: 'scene-plan-v1' }),
      plannedScenes(),
    );
    const original = buildScriptUpstreamArtifactRef('scene_plan', 5, artifact);

    expect(buildScriptUpstreamArtifactRef('scene_plan', 5, {
      ...artifact,
      createdAt: '2099-12-31T23:59:59.999Z',
    }).artifactHash).toBe(original.artifactHash);
    expect(buildScriptUpstreamArtifactRef('scene_plan', 5, {
      ...artifact,
      validationErrors: ['non-identity diagnostic'],
    }).artifactHash).toBe(original.artifactHash);
    expect(buildScriptUpstreamArtifactRef('scene_plan', 5, {
      ...artifact,
      candidateHash: 'a'.repeat(64),
    }).artifactHash).not.toBe(original.artifactHash);
    expect(buildScriptUpstreamArtifactRef('scene_plan', 5, {
      ...artifact,
      inputFingerprint: 'b'.repeat(64),
    }).artifactHash).not.toBe(original.artifactHash);

    const legacyArtifact = { kind: 'legacy', createdAt: '2026-08-15T00:00:00.000Z' };
    const changedLegacyArtifact = { ...legacyArtifact, createdAt: '2099-12-31T23:59:59.999Z' };
    expect(buildScriptUpstreamArtifactRef('legacy', 1, legacyArtifact).artifactHash)
      .toBe(computeScriptCheckpointArtifactHash(legacyArtifact));
    expect(buildScriptUpstreamArtifactRef('legacy', 1, changedLegacyArtifact).artifactHash)
      .not.toBe(buildScriptUpstreamArtifactRef('legacy', 1, legacyArtifact).artifactHash);
  });

  it('builds and strictly decodes draft and patched episode artifacts', () => {
    const draft = buildScriptEpisodeCandidateArtifact(
      artifactContext(),
      'draft',
      candidateEpisode(),
    );
    const patched = buildScriptEpisodeCandidateArtifact(
      artifactContext({
        upstreamArtifactRefs: [buildScriptUpstreamArtifactRef('draft', 1, draft)],
        promptVersion: 'revision-v1',
      }),
      'patched',
      candidateEpisode(),
    );

    expect(draft).toMatchObject({
      schemaVersion: 1,
      stage: 'draft',
      episodeNumber: 2,
      baseEpisodeRevision: 7,
      episode: { id: 'episode-2', revision: 7, status: 'reviewing' },
    });
    expect(decodeScriptEpisodeCandidateArtifact(draft, expectation(draft))).toEqual(draft);
    expect(patched.stage).toBe('patched');
    expect(decodeScriptEpisodeCandidateArtifact(patched, expectation(patched))).toEqual(patched);
  });

  it('rejects tampered artifact schema, episode number, hash and base revision', () => {
    const artifact = buildScriptEpisodeCandidateArtifact(
      artifactContext(),
      'draft',
      candidateEpisode(),
    );
    const expected = expectation(artifact);

    expect(() => decodeScriptEpisodeCandidateArtifact(
      { ...artifact, schemaVersion: 2 },
      expected,
    )).toThrow(/schemaVersion/);
    expect(() => decodeScriptEpisodeCandidateArtifact(
      { ...artifact, episodeNumber: 3 },
      expected,
    )).toThrow(/集号|episodeNumber|不匹配/);
    expect(() => decodeScriptEpisodeCandidateArtifact(
      { ...artifact, candidateHash: '0'.repeat(64) },
      expected,
    )).toThrow(/candidateHash/);
    expect(() => decodeScriptEpisodeCandidateArtifact(
      { ...artifact, baseEpisodeRevision: 8 },
      expected,
    )).toThrow(/base revision|baseEpisodeRevision|不匹配/);
    expect(() => decodeScriptEpisodeCandidateArtifact(
      {
        ...artifact,
        episode: {
          ...artifact.episode,
          scenes: [{
            ...artifact.episode.scenes[0]!,
            blocks: [{
              ...artifact.episode.scenes[0]!.blocks[0]!,
              text: '被篡改的正文',
            }],
          }],
        },
      },
      expected,
    )).toThrow(/candidateHash/);
    expect(() => buildScriptEpisodeCandidateArtifact(
      artifactContext({ episodeNumber: 3 }),
      'draft',
      candidateEpisode(),
    )).toThrow(/集号|episodeNumber|不一致/);
    expect(() => buildScriptEpisodeCandidateArtifact(
      artifactContext({ baseEpisodeRevision: 8 }),
      'draft',
      candidateEpisode(),
    )).toThrow(/baseEpisodeRevision|revision 不一致/);
  });

  it('rejects a tampered scene-plan payload or current-input fingerprint', () => {
    const artifact = buildScriptScenePlanArtifact(
      artifactContext({ baseEpisodeRevision: 4, promptVersion: 'scene-plan-v1' }),
      plannedScenes(),
    );
    const expected = expectation(artifact);

    expect(() => decodeScriptScenePlanArtifact({
      ...artifact,
      plannedScenes: [{ ...artifact.plannedScenes[0]!, purpose: '被替换的场景目的' }],
    }, expected)).toThrow(/candidateHash/);
    expect(() => decodeScriptScenePlanArtifact(artifact, {
      ...expected,
      inputFingerprint: 'f'.repeat(64),
    })).toThrow(/inputFingerprint/);
  });

  it('hashes artifacts canonically without depending on object key order', () => {
    expect(computeScriptCheckpointArtifactHash({
      stage: 'draft',
      nested: { revision: 3, id: 'candidate-1' },
    })).toBe(computeScriptCheckpointArtifactHash({
      nested: { id: 'candidate-1', revision: 3 },
      stage: 'draft',
    }));
  });
});
