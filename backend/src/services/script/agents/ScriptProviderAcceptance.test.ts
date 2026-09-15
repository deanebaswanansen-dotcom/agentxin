import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAiCompatibleModelProxy } from '../../../proxy/ModelProxy.js';
import { registerScriptPlanRoutes } from '../../../routes/scriptPlanRoutes.js';
import type { ModelConfig } from '../../../types/index.js';
import type { ScriptPlan } from '../domain.js';
import { FileScriptStore } from '../FileScriptStore.js';
import { ProxyScriptModelAdapter } from './ProxyScriptModelAdapter.js';
import { ScriptConceptService } from './ScriptConceptService.js';
import { InMemoryScriptCheckpointStore, ScriptDirector } from './ScriptDirector.js';
import { SCRIPT_PLANNING_FIELDS } from './ScriptPlanningAgent.js';
import { ScriptPlanTurnService } from './ScriptPlanTurnService.js';

// Mock only the external HTTP provider. Parsing, recovery, routes and the on-disk
// acceptance boundary remain real so individual layers cannot hide a failure.
const config: ModelConfig = {
  baseUrl: 'https://provider.example/v1',
  modelName: 'acceptance-model',
  apiKey: 'acceptance-private-key-canary',
};
const project = {
  id: 'project-acceptance', name: '123', kind: 'short_drama' as const,
  createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
};
const oldPlan: ScriptPlan = {
  id: 'plan-original', projectId: project.id, status: 'approved', revision: 0,
  title: '作者已确认的旧策划', theme: '西方玄幻', market: 'domestic', channel: 'general',
  genres: ['西方玄幻'], audience: '奇幻观众', coreConflict: '女骑士反抗伪造王命的领主',
  logline: '女骑士用账本揭穿领主的阴谋。', highlights: ['证据反转'], totalEpisodes: 10,
  episodeDurationSeconds: { min: 60, max: 90 }, targetCharsPerEpisode: 1200,
  maxPrimaryCharacters: 6, maxScenesPerEpisode: 3, dialogueDensityPercent: 60,
  language: 'zh-CN', format: 'cn_short_drama', coreRequirements: '账本不可复活死者',
  forbiddenElements: ['穿越'], endingDirection: '归还王冠',
  createdAt: project.createdAt, updatedAt: project.updatedAt,
};

function stream(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

const pendingCleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of pendingCleanup.splice(0).reverse()) await cleanup();
});

async function fixture(body: string, contentType = 'text/event-stream', status = 200, fallback?: string) {
  const fetchMock = vi.fn(async () => new Response(body, {
    status, headers: { 'content-type': contentType },
  }));
  vi.stubGlobal('fetch', fetchMock);
  const directory = await mkdtemp(join(tmpdir(), 'script-provider-acceptance-'));
  pendingCleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = await FileScriptStore.create(directory);
  const before = await store.savePlan(oldPlan, 0);
  const file = join(directory, `${project.id}.json`);
  const bytesBefore = await readFile(file, 'utf8');
  const model = new ProxyScriptModelAdapter(
    { getInternalConfig: async () => ({ ...config, ...(fallback ? { structuredFallbackModelName: fallback } : {}) }) },
    new OpenAiCompatibleModelProxy(),
  );
  const checkpoints = new InMemoryScriptCheckpointStore();
  const director = new ScriptDirector({ store, model, checkpoints });
  const lookup = async () => project;
  const app = Fastify();
  pendingCleanup.push(() => app.close());
  registerScriptPlanRoutes(app,
    new ScriptPlanTurnService(director, checkpoints, lookup),
    new ScriptConceptService(model, lookup),
  );
  return { app, director, store, fetchMock, before, file, bytesBefore, checkpoints };
}

const failures = [
  { label: 'HTML with HTTP 200', body: '<html><title>Gateway login</title></html>', type: 'text/html', calls: 1 },
  { label: 'error JSON with HTTP 200', body: JSON.stringify({ error: { message: 'model_not_found' } }), type: 'application/json', calls: 1 },
  { label: 'HTTP 401', body: JSON.stringify({ error: { message: `invalid key ${config.apiKey}` } }), status: 401, type: 'application/json', calls: 1 },
  { label: 'empty stream', body: 'data: [DONE]\n\n', calls: 1 },
  { label: 'reasoning without content', body: 'data: {"choices":[{"delta":{"reasoning_content":"working"}}]}\n\ndata: [DONE]\n\n', calls: 1 },
  { label: 'whitespace content', body: stream(' \n\t ') + 'data: [DONE]\n\n', calls: 1 },
  { label: 'late error after apparently complete content', body: stream(JSON.stringify(oldPlan)) + `event: error\ndata: {"message":"upstream failed ${config.apiKey}"}\n\n`, calls: 1 },
  { label: 'invalid JSON', body: stream('I cannot produce this story'), calls: 2 },
  { label: 'empty object with an existing valid draft', body: stream('{}'), calls: 2 },
  { label: 'irrelevant object', body: stream('{"message":"no result"}'), calls: 2 },
  { label: 'title without plot or conflict', body: stream('{"title":"未完成的王冠"}'), calls: 2 },
];

describe('provider to planning acceptance', () => {
  it.each(failures)('turn route rejects $label and preserves the approved file', async ({ body, type, status, calls }) => {
    const f = await fixture(body, type, status);
    const response = await f.app.inject({
      method: 'POST', url: '/api/plan/script/turn',
      payload: {
        projectId: project.id, seedPrompt: '西方玄幻', reset: true,
        draft: { title: oldPlan.title, logline: oldPlan.logline, coreConflict: oldPlan.coreConflict },
        answers: SCRIPT_PLANNING_FIELDS.map((field) => ({ field, delegate: true })),
      },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: 'PROVIDER_ERROR' } });
    expect(response.body).not.toContain(config.apiKey);
    if (calls === 1) expect(response.body).toContain('HTTP');
    expect(fetchMockCalls(f)).toBe(calls);
    expect((await f.store.getProjectState(project.id))?.plan).toEqual(f.before);
    expect(await readFile(f.file, 'utf8')).toBe(f.bytesBefore);
  });

  it('direct director calls also reject invalid stories without writing a draft', async () => {
    const f = await fixture(stream('{}'));
    await expect(f.director.run({
      task: 'script_plan', projectId: project.id, seedPrompt: '西方玄幻',
      planningSession: { values: {}, delegatedFields: [...SCRIPT_PLANNING_FIELDS], askedFields: [], questionCount: 0 },
    })).rejects.toThrow();
    expect(fetchMockCalls(f)).toBe(2);
    expect(await readFile(f.file, 'utf8')).toBe(f.bytesBefore);
  });

  it('counts transport retries and structured repair in one four-request budget', async () => {
    const f = await fixture('', 'text/event-stream', 200, 'explicit-fallback');
    let physicalRequests = 0;
    f.fetchMock.mockImplementation(async () => {
      physicalRequests += 1;
      return physicalRequests === 3
        ? new Response(stream('{}'), { headers: { 'content-type': 'text/event-stream' } })
        : new Response('{"error":{"message":"model_not_found"}}', { status: 503 });
    });
    const response = await f.app.inject({
      method: 'POST', url: '/api/plan/script/turn',
      payload: {
        projectId: project.id, seedPrompt: '西方玄幻', reset: true,
        answers: SCRIPT_PLANNING_FIELDS.map((field) => ({ field, delegate: true })),
      },
    });
    expect(response.statusCode).toBe(502);
    expect(response.body).toContain('503');
    expect(response.body).toContain('model_not_found');
    expect(fetchMockCalls(f)).toBe(4);
    expect(await readFile(f.file, 'utf8')).toBe(f.bytesBefore);
  }, 15_000);

  it('concept HTTP failure is not converted to three locally invented proposals', async () => {
    const f = await fixture('<html>Gateway login</html>', 'text/html');
    const response = await f.app.inject({
      method: 'POST', url: '/api/plan/script/concepts',
      payload: { projectId: project.id, seedPrompt: '西方玄幻' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: 'PROVIDER_ERROR' } });
    expect(response.json().proposals).toBeUndefined();
    expect(fetchMockCalls(f)).toBe(1);
    expect(await readFile(f.file, 'utf8')).toBe(f.bytesBefore);
  });

  it('valid fenced story survives a nonstandard content type and keeps metadata out of its title', async () => {
    const story = {
      ...oldPlan, title: '王冠与账本', logline: '女骑士在加冕前公开账本，揭穿伪造王命的领主。',
      coreConflict: '女骑士必须保住账本，对抗掌握军队的领主',
    };
    const f = await fixture(stream(`\u0060\u0060\u0060json\n${JSON.stringify(story)}\n\u0060\u0060\u0060`) + 'data: [DONE]\n\n', 'text/plain');
    const response = await f.app.inject({
      method: 'POST', url: '/api/plan/script/turn',
      payload: {
        projectId: project.id, seedPrompt: '西方玄幻', reset: true,
        draft: { title: '手稿需要核对', coreRequirements: '账本不可复活死者' },
        answers: SCRIPT_PLANNING_FIELDS.map((field) => ({ field, delegate: true })),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ready', plan: { title: story.title, status: 'draft' } });
    expect(fetchMockCalls(f)).toBe(1);
    const saved = (await f.store.getProjectState(project.id))?.plan;
    expect(saved?.revision).toBe(f.before.revision + 1);
    expect(saved?.logline).toBe(story.logline);
    expect(saved?.title).not.toContain('项目名称');
    expect(saved?.title).not.toContain('当前草稿');
  });
});

function fetchMockCalls(f: Awaited<ReturnType<typeof fixture>>): number {
  return f.fetchMock.mock.calls.length;
}
