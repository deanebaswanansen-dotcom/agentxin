import { describe, expect, it } from 'vitest';

import {
  computeScriptCheckpointInputFingerprint,
  decideScriptCheckpointResume,
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

describe('script checkpoint v2 recovery', () => {
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
});
