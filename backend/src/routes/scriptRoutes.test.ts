import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileScriptStore } from '../services/script/FileScriptStore.js';
import { ScriptService } from '../services/script/ScriptService.js';
import type {
  ScriptCharacterInput,
  ScriptEpisodeInput,
  ScriptEpisodeOutlineInput,
  ScriptPlanInput,
  ScriptSeriesOutlineInput,
  ScriptWorldBibleInput,
} from '../services/script/domain.js';
import { registerScriptRoutes } from './scriptRoutes.js';

const projectId = 'project-1';

function planInput(): ScriptPlanInput {
  return {
    status: 'draft',
    title: '绝食逼我道歉？',
    theme: '平等和尊重',
    market: 'domestic',
    channel: 'female',
    genres: ['都市', '家庭'],
    audience: '女性观众',
    coreConflict: '新媳妇对抗家族权威',
    logline: '新媳妇用美食打破家族绝食绑架。',
    highlights: ['反向打脸'],
    totalEpisodes: 10,
    episodeDurationSeconds: { min: 60, max: 90 },
    targetCharsPerEpisode: 1_200,
    maxPrimaryCharacters: 8,
    maxScenesPerEpisode: 3,
    dialogueDensityPercent: 65,
    language: 'zh-CN',
    format: 'cn_short_drama',
    coreRequirements: '快节奏，每集有卡点',
    forbiddenElements: [],
    endingDirection: '重建家庭秩序',
  };
}

function charactersInput(): ScriptCharacterInput[] {
  return [
    {
      id: 'character-1',
      name: '沈清',
      aliases: [],
      role: 'lead',
      age: 25,
      occupation: '美食工作室老板',
      identity: '现代独立女性',
      biography: '白手起家',
      motivation: '保护家人',
      goal: '打破绑架规矩',
      weakness: '不愿求助',
      arc: '学会接纳家庭',
      appearance: '利落',
      hairstyle: '高马尾',
      physique: '高挑',
      defaultOutfit: '白衬衫黑西装裤',
      personality: ['冷静'],
      skills: ['烹饪'],
      speechStyle: '简短有力',
      catchphrases: [],
      relationships: [],
    },
  ];
}

function worldInput(): ScriptWorldBibleInput {
  return {
    era: '2026年',
    primaryLocations: ['沈家老宅'],
    worldState: '现代都市',
    rules: ['尊重现代法律'],
    transport: ['私家车'],
    communication: ['智能手机'],
    organizations: ['沈家'],
    recurringProps: ['电烤盘'],
    forbiddenAnachronisms: [],
  };
}

function outlineInput(): ScriptSeriesOutlineInput {
  return {
    synopsis: '沈清逐步打破沈家旧规。',
    openingState: '全家被太奶奶控制',
    midpointTurn: '证据曝光',
    climax: '家族公开对决',
    endingState: '家庭恢复平等',
    mainArc: ['反抗', '取证', '重建'],
    subplotArcs: [],
    episodeCards: Array.from({ length: 10 }, (_, index) => ({
      episodeNumber: index + 1,
      title: `第${index + 1}集`,
      logline: `第${index + 1}集概要`,
      mainEvent: `事件${index + 1}`,
      endingHook: `卡点${index + 1}`,
    })),
  };
}

function episodeOutlineInput(number = 1): ScriptEpisodeOutlineInput {
  return {
    episodeNumber: number,
    title: '初入老宅',
    goal: '建立冲突',
    conflict: '跪请与拒绝',
    beats: ['进门', '跪请', '拒绝'],
    characterIds: ['character-1'],
    plannedScenes: [
      {
        ordinal: 1,
        location: '沈家老宅大门',
        timeOfDay: 'day',
        interiorExterior: 'exterior',
        purpose: '介绍冲突',
      },
    ],
    endingHook: '沈清决定改规矩',
    requiredFacts: [],
    forbiddenFacts: [],
    status: 'approved',
  };
}

function episodeInput(number = 1): ScriptEpisodeInput {
  return {
    episodeNumber: number,
    title: '初入老宅',
    outlineId: 'outline-1',
    status: 'completed',
    targetChars: 1_200,
    scenes: [
      {
        id: 'scene-1',
        ordinal: 1,
        location: '沈家老宅大门',
        timeOfDay: 'day',
        interiorExterior: 'exterior',
        characterIds: ['character-1'],
        blocks: [
          { id: 'block-1', type: 'caption', text: '沧南市沈家百年老宅' },
          { id: 'block-2', type: 'action', text: '沈清跨过门槛。' },
          {
            id: 'block-3',
            type: 'dialogue',
            characterId: 'character-1',
            speaker: '沈清',
            delivery: '从容',
            mode: 'normal',
            text: '这规矩，该改改了。',
          },
        ],
      },
    ],
    summary: '沈清进入老宅。',
    newFacts: [],
    openedThreads: [],
    closedThreads: [],
  };
}

describe('scriptRoutes', () => {
  let root: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'script-routes-'));
    const store = await FileScriptStore.create(root);
    app = Fastify({ logger: false });
    registerScriptRoutes(app, new ScriptService(store));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it('saves, reads and approves a validated script plan', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-plan`,
      payload: { expectedRevision: 0, value: planInput() },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ revision: 1, status: 'draft' });

    const read = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/script-plan`,
    });
    expect(read.json()).toMatchObject({ title: '绝食逼我道歉？', revision: 1 });

    const approved = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/script-plan/approve`,
      payload: { expectedRevision: 1 },
    });
    expect(approved.json()).toMatchObject({ status: 'approved', revision: 2 });
  });

  it('returns 409 CONFLICT for a stale PUT revision', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-plan`,
      payload: { expectedRevision: 0, value: planInput() },
    });
    const response = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-plan`,
      payload: { expectedRevision: 0, value: { ...planInput(), title: '过期修改' } },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'CONFLICT',
        message: '数据已被更新，请刷新后重试。',
        details: { expectedRevision: 0, actualRevision: 1 },
      },
    });
  });

  it('rejects invalid plan ranges at the HTTP boundary', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-plan`,
      payload: {
        expectedRevision: 0,
        value: { ...planInput(), totalEpisodes: 201, targetCharsPerEpisode: 200 },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('round-trips characters, world, series outline and episode outline', async () => {
    const resources = [
      ['script-characters', { expectedRevision: 0, items: charactersInput() }],
      ['script-world', { expectedRevision: 0, value: worldInput() }],
      ['script-outline', { expectedRevision: 0, value: outlineInput() }],
      ['episode-outlines/1', { expectedRevision: 0, value: episodeOutlineInput() }],
    ] as const;

    for (const [path, payload] of resources) {
      const put = await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/${path}`,
        payload,
      });
      expect(put.statusCode, path).toBe(200);
      const get = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/${path}`,
      });
      expect(get.statusCode, path).toBe(200);
    }
  });

  it('rejects a body whose episode number differs from the route', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/episode-outlines/2`,
      payload: { expectedRevision: 0, value: episodeOutlineInput(1) },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('saves episodes, lists ordered summaries and exports TXT, Markdown and Fountain', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-plan`,
      payload: { expectedRevision: 0, value: planInput() },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-characters`,
      payload: { expectedRevision: 0, items: charactersInput() },
    });
    for (const number of [2, 1]) {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/script-episodes/${number}`,
        payload: {
          expectedRevision: 0,
          value: { ...episodeInput(number), status: 'reviewing' },
        },
      });
      expect(response.statusCode).toBe(200);
    }

    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/script-episodes`,
    });
    expect(list.json().map((item: { episodeNumber: number }) => item.episodeNumber)).toEqual([1, 2]);

    const txt = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/script-export?format=txt&startEpisode=1&episodeCount=1`,
    });
    expect(txt.statusCode).toBe(200);
    expect(txt.headers['content-type']).toContain('text/plain');
    expect(txt.body).toContain('第一集');
    expect(txt.body).toContain('1-1 沈家老宅大门 日/外');
    expect(txt.body).toContain('人物：沈清');
    expect(txt.body).toContain('【字幕：沧南市沈家百年老宅】');
    expect(txt.body).toContain('△沈清跨过门槛。');
    expect(txt.body).toContain('沈清（从容）：这规矩，该改改了。');
    expect(txt.body).not.toContain('第二集');

    const md = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/script-export?format=md`,
    });
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(md.body).toContain('# 绝食逼我道歉？');
    expect(md.body).toContain('## 第一集 · 初入老宅');

    const fountain = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/script-export?format=fountain`,
    });
    expect(fountain.statusCode).toBe(200);
    expect(fountain.headers['content-disposition']).toContain('.fountain');
    expect(fountain.body).toContain('沈清');
  });

  it('rejects marking an episode completed when it fails the hard quality gate', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-plan`,
      payload: { expectedRevision: 0, value: planInput() },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-characters`,
      payload: { expectedRevision: 0, items: charactersInput() },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/episode-outlines/1`,
      payload: { expectedRevision: 0, value: episodeOutlineInput(1) },
    });

    const response = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-episodes/1`,
      payload: { expectedRevision: 0, value: episodeInput(1) },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        details: { issues: expect.arrayContaining([expect.objectContaining({ code: 'TOO_SHORT' })]) },
      },
    });
  });

  it('rejects completed status while the episode has a persisted user hard review issue', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-plan`,
      payload: {
        expectedRevision: 0,
        value: { ...planInput(), targetCharsPerEpisode: 300 },
      },
    });
    const outlineResponse = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/episode-outlines/1`,
      payload: { expectedRevision: 0, value: episodeOutlineInput(1) },
    });
    const outlineId = outlineResponse.json().id as string;
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-review-issues`,
      payload: {
        expectedRevision: 0,
        items: [{
          id: 'user-hard-1',
          episodeNumber: 1,
          code: 'AI_LOGIC_CONFLICT',
          severity: 'hard',
          category: 'logic',
          message: '人物动机与前集冲突。',
          status: 'open',
          source: 'user',
        }],
      },
    });

    const completedValue = {
      episodeNumber: 1,
      title: '初入老宅',
      outlineId,
      status: 'completed' as const,
      targetChars: 300,
      scenes: [{
        id: 'scene-valid',
        ordinal: 1,
        location: '沈家老宅大门',
        timeOfDay: 'day',
        interiorExterior: 'exterior',
        characterIds: [],
        blocks: [{ id: 'action-valid', type: 'action', text: '剧情'.repeat(135) }],
      }],
      summary: '沈清进入老宅并直面旧规。',
      newFacts: [],
      openedThreads: [],
      closedThreads: [],
    };
    const response = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-episodes/1`,
      payload: {
        expectedRevision: 0,
        value: completedValue,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('未解决的硬性校稿问题'),
        details: {
          issues: [expect.objectContaining({ id: 'user-hard-1', status: 'open' })],
        },
      },
    });

    const fixed = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/script-review-issues/user-hard-1`,
      payload: { expectedRevision: 1, status: 'fixed' },
    });
    expect(fixed.statusCode).toBe(200);
    const completed = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-episodes/1`,
      payload: { expectedRevision: 0, value: completedValue },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ episodeNumber: 1, status: 'completed' });
  });

  it('returns 404 for a missing single resource and [] for empty lists', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/script-world`,
    });
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/script-episodes`,
    });

    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
    expect(list.json()).toEqual([]);
  });

  it('returns a compact five-episode workspace and persists proofreading issue status', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-plan`,
      payload: { expectedRevision: 0, value: planInput() },
    });
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/script-plan/approve`,
      payload: { expectedRevision: 1 },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-characters`,
      payload: { expectedRevision: 0, items: charactersInput() },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-world`,
      payload: { expectedRevision: 0, value: worldInput() },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-outline`,
      payload: { expectedRevision: 0, value: outlineInput() },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-episodes/1`,
      payload: { expectedRevision: 0, value: { ...episodeInput(1), status: 'reviewing' } },
    });
    const savedIssues = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/script-review-issues`,
      payload: {
        expectedRevision: 0,
        items: [{
          id: 'manual-1',
          episodeNumber: 1,
          code: 'WORDING',
          severity: 'soft',
          category: 'dialogue',
          message: '台词可以更口语化。',
          status: 'open',
          source: 'user',
        }],
      },
    });
    expect(savedIssues.statusCode).toBe(200);
    expect(savedIssues.json()).toMatchObject({ revision: 1, items: [{ id: 'manual-1' }] });

    const workspace = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/script-workspace`,
    });
    expect(workspace.statusCode).toBe(200);
    expect(workspace.json()).toMatchObject({
      schemaVersion: 1,
      projectId,
      plan: { title: '绝食逼我道歉？' },
      outline: { synopsis: '沈清逐步打破沈家旧规。' },
      characters: [{ name: '沈清' }],
      worldBible: { era: '2026年' },
      reviewRevision: 1,
      episodeSummaries: [{ episodeNumber: 1, status: 'reviewing' }],
      batchSummaries: [
        {
          startEpisode: 1,
          endEpisode: 5,
          status: 'proofreading',
          completedEpisodes: 0,
          unresolvedHardIssues: 0,
          unresolvedSoftIssues: 1,
        },
        { startEpisode: 6, endEpisode: 10, status: 'ready' },
      ],
    });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/script-review-issues/manual-1`,
      payload: { expectedRevision: 1, status: 'ignored' },
    });
    expect(patched.json()).toMatchObject({
      revision: 2,
      item: { id: 'manual-1', status: 'ignored' },
    });
    const open = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/script-review-issues?episodeNumber=1&status=open`,
    });
    expect(open.json()).toEqual({ revision: 2, items: [] });

    const reviewed = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/script-episodes/1/review`,
      payload: { expectedRevision: 2 },
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json()).toMatchObject({
      revision: 3,
      report: { hardFailed: true },
      items: expect.arrayContaining([
        expect.objectContaining({ code: 'TOO_SHORT', source: 'deterministic', status: 'open' }),
        expect.objectContaining({ id: 'manual-1', source: 'user', status: 'ignored' }),
      ]),
    });
    const hardIssue = reviewed.json().items.find((item: { severity: string }) => item.severity === 'hard');
    const ignoreHard = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/script-review-issues/${hardIssue.id}`,
      payload: { expectedRevision: 3, status: 'ignored' },
    });
    expect(ignoreHard.statusCode).toBe(400);
    expect(ignoreHard.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: expect.stringContaining('不能忽略') },
    });
  });
});
