import { describe, it, expect, vi, afterEach } from 'vitest';
import fc from 'fast-check';
import {
  ApiClientError,
  createApiClient,
  isApiClientError,
  migrateStoredModelConfig,
  parseSseEvents,
  runAgentBackgroundJob,
  runPersistentAgentJob,
  runPlanBackgroundJob,
  type SseEvent,
} from './apiClient.js';
import type {
  AgentRunRequest,
  AgentRunResult,
  ApiError,
  ModelConfig,
  WritingRequestBody,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// fetch mocking helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, init?: { status?: number; statusText?: string }): Response {
  const status = init?.status ?? 200;
  // 204/205/304 are "null body status" codes; a body (even '') is invalid.
  const nullBodyStatus = status === 204 || status === 205 || status === 304;
  const payload = nullBodyStatus || body === undefined ? null : JSON.stringify(body);
  return new Response(payload, {
    status,
    statusText: init?.statusText ?? '',
    headers: { 'Content-Type': 'application/json' },
  });
}

function htmlResponse(body = '<!doctype html><html></html>'): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}

/** Build a Response whose body is a ReadableStream emitting the given chunks. */
function sseResponse(chunks: string[], init?: { status?: number }): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function installFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init)),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.useRealTimers();
  client().modelConfig.clear();
  try {
    window.localStorage.removeItem('nwa.modelConfig.v1');
  } catch {
    // ignore
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const client = () => createApiClient('/api');

// ---------------------------------------------------------------------------
// Request building + success parsing
// ---------------------------------------------------------------------------

describe('apiClient request building', () => {
  it('loads the aggregate short-drama state in one request', async () => {
    const state = {
      schemaVersion: 1 as const,
      projectId: 'project-1',
      characters: [],
      episodeOutlines: [],
      episodes: [],
      continuity: { currentState: [], openThreads: [], wardrobeLedger: [] },
      reviewRevision: 0,
      reviewIssues: [],
      updatedAt: '2026-08-15T00:00:00.000Z',
    };
    const mock = installFetch((url, init) => {
      expect(url).toBe('/api/projects/project-1/script-state');
      expect(init?.method).toBe('GET');
      return jsonResponse(state);
    });

    await expect(client().script.state.get('project-1')).resolves.toEqual(state);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('loads the product workspace and completes a proofreading issue workflow', async () => {
    const issue = {
      id: 'issue-1',
      projectId: 'project-1',
      episodeNumber: 1,
      code: 'MISSING_HOOK',
      severity: 'soft' as const,
      category: 'hook' as const,
      message: '结尾缺少卡点。',
      status: 'open' as const,
      source: 'deterministic' as const,
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
    };
    const workspace = {
      schemaVersion: 1 as const,
      projectId: 'project-1',
      characters: [],
      episodeSummaries: [],
      batchSummaries: [],
      reviewRevision: 2,
      reviewIssues: [issue],
      updatedAt: '2026-08-15T00:00:00.000Z',
    };
    const mock = installFetch((url, init) => {
      if (url.endsWith('/script-workspace')) return jsonResponse(workspace);
      if (url.endsWith('/script-episodes/1/review')) {
        expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 2 });
        return jsonResponse({
          revision: 3,
          items: [issue],
          report: {
            hardFailed: false,
            issues: [],
            blockingIssues: [],
            advisoryIssues: [],
            visibleChars: 1200,
            dialogueDensityPercent: 60,
          },
        });
      }
      if (url.endsWith('/script-review-issues/issue-1')) {
        expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 3, status: 'fixed' });
        return jsonResponse({ revision: 4, item: { ...issue, status: 'fixed' } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(client().script.workspace.get('project-1')).resolves.toEqual(workspace);
    await expect(client().script.episodes.review('project-1', 1, 2)).resolves.toMatchObject({ revision: 3 });
    await expect(client().script.reviews.updateStatus('project-1', 'issue-1', 'fixed', 3))
      .resolves.toMatchObject({ revision: 4, item: { status: 'fixed' } });
    expect(mock.mock.calls.map((call) => [call[0], call[1]?.method])).toEqual([
      ['/api/projects/project-1/script-workspace', 'GET'],
      ['/api/projects/project-1/script-episodes/1/review', 'POST'],
      ['/api/projects/project-1/script-review-issues/issue-1', 'PATCH'],
    ]);
  });

  it('downloads script exports as blobs and keeps the UTF-8 server filename', async () => {
    const mock = installFetch((url, init) => {
      expect(url).toBe('/api/projects/project-1/script-export?format=md&startEpisode=6&episodeCount=5');
      expect(init?.method).toBe('GET');
      return new Response('# 第六集', {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': "attachment; filename*=UTF-8''%E5%A4%9C%E7%8F%AD%E7%9C%9F%E7%9B%B8-6-10.md",
        },
      });
    });

    const file = await client().script.exportFile('project-1', 'md', {
      startEpisode: 6,
      episodeCount: 5,
    });
    expect(file.filename).toBe('夜班真相-6-10.md');
    expect(file.contentType).toBe('text/markdown; charset=utf-8');
    expect(file.blob.size).toBeGreaterThan(0);
    expect(file.blob.type.replace(/;\s*/g, ';')).toBe('text/markdown;charset=utf-8');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('allows a whole-book export to wait behind long-running final writes', async () => {
    vi.useFakeTimers();
    installFetch((_url, init) => new Promise<Response>((resolve, reject) => {
      const finish = setTimeout(() => resolve(new Response('整本正文', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })), 60_000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(finish);
        reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }));

    const exportRequest = client().script.exportFile('project-1', 'txt');
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(exportRequest).resolves.toMatchObject({
      filename: 'short-drama-project-1.txt',
      contentType: 'text/plain; charset=utf-8',
    });
  });

  it('uses a safe fallback export filename when Content-Disposition is unavailable', async () => {
    installFetch(() => new Response('正文', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));

    const file = await client().script.exportFile('project/unsafe', 'fountain');
    expect(file.filename).toBe('short-drama-project_unsafe.fountain');
  });

  it('rejects an HTML SPA fallback instead of downloading it as a script', async () => {
    installFetch(() => htmlResponse());

    await expect(client().script.exportFile('project-1', 'txt')).rejects.toMatchObject({
      code: 'STORE_ERROR',
      message: expect.stringContaining('网页内容'),
    });
  });

  it('loads and saves the versioned short-drama plan through the script namespace', async () => {
    const plan = {
      id: 'plan-1',
      projectId: 'project-1',
      status: 'draft' as const,
      revision: 2,
      title: '绝食逼我道歉？我当面吃香喝辣',
      theme: '打破情绪勒索',
      market: 'domestic' as const,
      channel: 'female' as const,
      genres: ['都市', '家庭'],
      audience: '女性用户',
      coreConflict: '新媳妇对抗家族情绪勒索',
      logline: '新媳妇用美食拆穿绝食骗局。',
      highlights: ['当面烧烤'],
      totalEpisodes: 60,
      episodeDurationSeconds: { min: 60, max: 90 },
      targetCharsPerEpisode: 1200,
      maxPrimaryCharacters: 10,
      maxScenesPerEpisode: 3,
      dialogueDensityPercent: 60,
      language: 'zh-CN' as const,
      format: 'cn_short_drama' as const,
      coreRequirements: '每集有反转和卡点',
      forbiddenElements: [],
      endingDirection: '家庭秩序重建',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    };
    const mock = installFetch((url, init) => {
      expect(url).toBe('/api/projects/project-1/script-plan');
      if (init?.method === 'PUT') return jsonResponse({ ...plan, revision: 3 });
      return jsonResponse(plan);
    });

    await expect(client().script.plan.get('project-1')).resolves.toEqual(plan);
    await expect(client().script.plan.save('project-1', plan, 2)).resolves.toMatchObject({ revision: 3 });
    expect(JSON.parse(String(mock.mock.calls[1]?.[1]?.body))).toEqual({ expectedRevision: 2, value: plan });
  });

  it('requests AI short-drama concepts with the current model configuration', async () => {
    const proposals = [{ title: '选题一' }, { title: '选题二' }, { title: '选题三' }];
    const mock = installFetch((url) => {
      expect(url).toBe('/api/plan/script/concepts');
      return jsonResponse({ proposals });
    });

    await expect(client().script.plan.concepts('project-1', '家庭情绪勒索'))
      .resolves.toEqual({ proposals });
    const request = mock.mock.calls[0]?.[1];
    expect(request?.method).toBe('POST');
    expect(JSON.parse(String(request?.body))).toEqual({
      projectId: 'project-1', seedPrompt: '家庭情绪勒索',
    });
  });

  it('starts and resumes a five-episode script job with checkpoint-safe options', async () => {
    const running = {
      id: 'job-1',
      projectId: 'project-1',
      task: 'script_episode_batch' as const,
      status: 'running' as const,
      continuable: false,
      checkpoint: { episodeNumber: 1, node: 'draft' as const, attempt: 1, artifactRevision: 0 },
    };
    const mock = installFetch((url) => {
      if (url.endsWith('/resume')) return jsonResponse({ ...running, status: 'queued' });
      return jsonResponse(running);
    });

    await expect(
      client().script.jobs.create({
        projectId: 'project-1',
        task: 'script_episode_batch',
        scriptBatchOptions: { startEpisode: 1, episodeCount: 5, expectedPlanRevision: 3 },
      }),
    ).resolves.toEqual(running);
    await expect(client().script.jobs.resume('job-1')).resolves.toMatchObject({ status: 'queued' });
    expect(mock.mock.calls.map((call) => [call[0], call[1]?.method])).toEqual([
      ['/api/agent/jobs', 'POST'],
      ['/api/agent/jobs/job-1/resume', 'POST'],
    ]);
  });

  it('runs production planning in a background job and polls the result', async () => {
    const result = {
      status: 'ready' as const,
      round: 1,
      message: '已形成方案。',
      brief: '西方玄幻计划',
      planSummary: { genre: '西方玄幻', chapterCount: 10 },
    };
    const mock = installFetch((url, init) => {
      if (url.endsWith('/agent-job-background')) {
        return jsonResponse(undefined, { status: 202 });
      }
      if (url.includes('/agent-job?jobId=') && init?.method === 'DELETE') {
        return jsonResponse(undefined, { status: 204 });
      }
      if (url.includes('/agent-job?jobId=')) {
        return jsonResponse({ state: 'completed', result });
      }
      return jsonResponse({ error: { code: 'NOT_FOUND', message: 'unexpected path' } }, { status: 404 });
    });

    await expect(
      runPlanBackgroundJob('/api', { seedPrompt: '西方玄幻' }),
    ).resolves.toEqual(result);
    const start = mock.mock.calls.find((call) => String(call[0]).endsWith('/agent-job-background'));
    expect(JSON.parse(String(start?.[1]?.body))).toMatchObject({
      kind: 'plan',
      request: { seedPrompt: '西方玄幻' },
    });
  });

  it('consumes planning decisions over SSE so long model waits stay active', async () => {
    const result = {
      status: 'asking' as const,
      round: 1,
      message: '只补一个关键问题。',
      questions: [
        {
          id: 'ending_cost',
          question: '胜利需要付出什么代价？',
          options: [
            { id: 'memory', label: '失去记忆' },
            { id: 'title', label: '失去爵位' },
          ],
        },
      ],
    };
    const mock = installFetch(() =>
      sseResponse([
        ': heartbeat\n\n',
        'event: progress\ndata: {"message":"决策中"}\n\n',
        `event: result\ndata: ${JSON.stringify(result)}\n\n`,
        'event: done\n\n',
      ]),
    );

    await expect(
      client().agent.planTurn({ seedPrompt: '西方玄幻' }),
    ).resolves.toEqual(result);
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe('/api/agent/plan/turn-stream');
    expect((init?.headers as Record<string, string>).Accept).toBe('text/event-stream');
  });

  it('consumes reference analysis over SSE so multi-pass extraction stays active', async () => {
    const result = {
      reference: { id: 'ref-1', title: '样例', depth: 'standard', status: 'ready' },
      profile: {},
      analysisProjectId: 'project-1',
      analysisProjectName: '小说拆解 · 样例',
      artifacts: [],
      chaptersAnalyzed: 2,
      chaptersSelected: 2,
      message: '完成',
    };
    const mock = installFetch(() =>
      sseResponse([
        ': heartbeat\n\n',
        'event: progress\ndata: {"message":"拆解中"}\n\n',
        `event: result\ndata: ${JSON.stringify(result)}\n\n`,
        'event: done\n\n',
      ]),
    );

    await expect(
      client().references.analyze('ref-1', { chapterIds: ['chapter-1', 'chapter-2'] }),
    ).resolves.toEqual(result);
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe('/api/references/ref-1/analyze-stream');
    expect((init?.headers as Record<string, string>).Accept).toBe('text/event-stream');
  });

  it('migrates retired DeepSeek model aliases without touching custom gateways', () => {
    expect(
      migrateStoredModelConfig({
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'secret',
        modelName: 'deepseek-chat',
      }),
    ).toMatchObject({ baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash' });
    expect(
      migrateStoredModelConfig({
        baseUrl: 'https://gateway.example.com/v1',
        apiKey: 'secret',
        modelName: 'deepseek-chat',
      }).modelName,
    ).toBe('deepseek-chat');
  });

  it('persists model config to localStorage, sends it as a request header, and clears it', async () => {
    const api = client();
    const config: ModelConfig = {
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-secret-key',
      modelName: 'novel-model',
      structuredFallbackModelName: 'novel-model-pro',
      temperature: 0.75,
      topP: 0.85,
    };

    await expect(api.modelConfig.get()).resolves.toEqual({
      baseUrl: '',
      modelName: '',
      apiKeyMasked: '',
      temperature: 1,
      topP: 1,
    });
    const mock = installFetch((url) => {
      if (String(url).includes('/model-config')) {
        return jsonResponse({
          baseUrl: config.baseUrl,
          modelName: config.modelName,
          structuredFallbackModelName: config.structuredFallbackModelName,
          apiKeyMasked: '****-key',
          temperature: 0.75,
          topP: 0.85,
        });
      }
      return jsonResponse([]);
    });
    await expect(api.modelConfig.save(config)).resolves.toEqual({
      baseUrl: 'https://api.example.com',
      modelName: 'novel-model',
      structuredFallbackModelName: 'novel-model-pro',
      apiKeyMasked: '****-key',
      temperature: 0.75,
      topP: 0.85,
    });
    expect(window.localStorage.getItem('nwa.modelConfig.v1')).toContain('sk-secret-key');

    await api.projects.list();
    const listCall = mock.mock.calls.find((call) => String(call[0]).includes('/projects'));
    const listHeaders = listCall?.[1]?.headers as Record<string, string>;
    expect(listHeaders['X-Agentxin-Model-Config']).toBeUndefined();
    expect(listHeaders['X-Agentxin-Client-Id']).toMatch(/^[a-f0-9]{64}$/);

    await api.agent.run({ task: 'novel', mode: 'draft', prompt: '测试模型任务' });
    const agentCall = mock.mock.calls.find((call) => String(call[0]).endsWith('/agent/run'));
    const agentHeaders = agentCall?.[1]?.headers as Record<string, string>;
    expect(JSON.parse(decodeURIComponent(agentHeaders['X-Agentxin-Model-Config']))).toEqual(config);

    await api.modelConfig.test();
    const testCall = mock.mock.calls.find((call) => String(call[0]).endsWith('/model-config/test'));
    const testHeaders = testCall?.[1]?.headers as Record<string, string>;
    expect(JSON.parse(decodeURIComponent(testHeaders['X-Agentxin-Model-Config']))).toEqual(config);
    expect(testCall?.[1]?.body).toBe('{}');

    // New client instance still hydrates from localStorage
    const api2 = createApiClient('/api');
    await expect(api2.modelConfig.get()).resolves.toEqual({
      baseUrl: 'https://api.example.com',
      modelName: 'novel-model',
      structuredFallbackModelName: 'novel-model-pro',
      apiKeyMasked: '****-key',
      temperature: 0.75,
      topP: 0.85,
    });

    api.modelConfig.clear();
    await expect(api.modelConfig.get()).resolves.toEqual({
      baseUrl: '',
      modelName: '',
      apiKeyMasked: '',
      temperature: 1,
      topP: 1,
    });
    expect(window.localStorage.getItem('nwa.modelConfig.v1')).toBeNull();
  });

  it('issues a POST with JSON body for project creation and parses the result', async () => {
    const mock = installFetch(() => jsonResponse({ id: 'p1' }, { status: 201 }));
    const result = await client().projects.create('我的小说');

    expect(result).toEqual({ id: 'p1' });
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe('/api/projects');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ name: '我的小说' });
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init?.headers as Record<string, string>)['X-Agentxin-Client-Id']).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it('encodes id path segments', async () => {
    const mock = installFetch(() => jsonResponse(undefined, { status: 204 }));
    await client().chapters.remove('a/b c');
    expect(mock.mock.calls[0][0]).toBe('/api/chapters/a%2Fb%20c');
  });

  it('returns parsed chapter list on GET', async () => {
    const chapters = [
      { id: 'c1', projectId: 'p1', title: 'T', content: '', position: 0 },
    ];
    installFetch(() => jsonResponse(chapters));
    await expect(client().chapters.list('p1')).resolves.toEqual(chapters);
  });

  it('rejects HTML fallback responses from static hosting', async () => {
    installFetch(() => htmlResponse());
    const err: ApiClientError = await client().projects.list().catch((e) => e);

    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.code).toBe('STORE_ERROR');
    expect(err.message).toContain('非 JSON 响应');
  });
});

// ---------------------------------------------------------------------------
// Unified error handling
// ---------------------------------------------------------------------------

describe('apiClient unified error handling', () => {
  it('throws ApiClientError carrying a valid backend ApiError verbatim', async () => {
    const apiError: ApiError = { error: { code: 'NOT_FOUND', message: '项目不存在' } };
    installFetch(() => jsonResponse(apiError, { status: 404 }));

    const err = await client()
      .projects.rename('missing', 'x')
      .catch((e) => e);
    expect(isApiClientError(err)).toBe(true);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('项目不存在');
    expect(err.status).toBe(404);
    expect(err.apiError).toEqual(apiError);
  });

  it('synthesizes an ApiError when the body is not in ApiError shape', async () => {
    installFetch(() => jsonResponse({ oops: true }, { status: 400 }));
    const err: ApiClientError = await client().projects.create('x').catch((e) => e);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('synthesizes a STORE_ERROR for unmapped 5xx statuses', async () => {
    installFetch(() => jsonResponse(undefined, { status: 500, statusText: 'Internal Error' }));
    const err: ApiClientError = await client().projects.list().catch((e) => e);
    expect(err.code).toBe('STORE_ERROR');
    expect(err.status).toBe(500);
  });

  it('maps known statuses to codes when body lacks a code', async () => {
    const cases: Array<[number, string]> = [
      [400, 'VALIDATION_ERROR'],
      [404, 'NOT_FOUND'],
      [409, 'CONFLICT'],
      [502, 'PROVIDER_ERROR'],
      [504, 'PROVIDER_ERROR'],
    ];
    for (const [status, code] of cases) {
      installFetch(() => jsonResponse('', { status }));
      const err: ApiClientError = await client().projects.list().catch((e) => e);
      expect(err.code).toBe(code);
      vi.unstubAllGlobals();
    }
  });
});

describe('Netlify background Agent jobs', () => {
  it('submits credentials once, polls by client id, and returns progress plus result', async () => {
    const config: ModelConfig = {
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-browser-only',
      modelName: 'novel-model',
    };
    await client().modelConfig.save(config);
    const result: AgentRunResult = {
      task: 'novel',
      mode: 'draft',
      projectId: 'p1',
      summary: '完成',
      steps: ['完成'],
      artifacts: [],
    };
    const progress = vi.fn();
    const mock = installFetch((url, init) => {
      if (url.endsWith('/agent-job-background')) {
        return new Response(null, { status: 202 });
      }
      if (url.endsWith('/api/projects')) {
        return jsonResponse([]);
      }
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({
        state: 'completed',
        events: [{ phase: 'setup', message: '后台已启动' }],
        result,
      });
    });
    const request: AgentRunRequest = {
      task: 'novel',
      mode: 'draft',
      prompt: '测试',
    };

    await expect(runAgentBackgroundJob('/api', request, { onProgress: progress })).resolves.toEqual(
      result,
    );
    expect(progress).toHaveBeenCalledWith({ phase: 'setup', message: '后台已启动' });

    const start = mock.mock.calls.find((call) => String(call[0]).endsWith('/agent-job-background'));
    const poll = mock.mock.calls.find(
      (call) => String(call[0]).includes('/agent-job?jobId=') && call[1]?.method !== 'DELETE',
    );
    const refresh = mock.mock.calls.find((call) => String(call[0]).endsWith('/api/projects'));
    expect((start?.[1]?.headers as Record<string, string>)['X-Agentxin-Model-Config']).toBeDefined();
    expect((poll?.[1]?.headers as Record<string, string>)['X-Agentxin-Model-Config']).toBeUndefined();
    expect((poll?.[1]?.headers as Record<string, string>)['X-Agentxin-Client-Id']).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect((refresh?.[1]?.headers as Record<string, string>)['X-Agentxin-Refresh-Data']).toBe('true');
  });

  it('splits a multi-chapter run into one persisted Netlify job per chapter', async () => {
    await client().modelConfig.save({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-browser-only',
      modelName: 'novel-model',
    });
    let starts = 0;
    const startedBodies: AgentRunRequest[] = [];
    const progress = vi.fn();
    installFetch(async (url, init) => {
      if (url.endsWith('/agent-job-background')) {
        starts += 1;
        startedBodies.push(JSON.parse(String(init?.body)).request as AgentRunRequest);
        return new Response(null, { status: 202 });
      }
      if (url.endsWith('/api/projects')) return jsonResponse([]);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return jsonResponse({
        state: 'completed',
        events: [{ phase: 'chapter', message: '本章完成', current: 1, total: 1 }],
        result: {
          task: 'long_novel',
          mode: 'draft',
          projectId: 'p1',
          chapterId: `c${starts}`,
          summary: '本批完成',
          steps: [`第${starts}章完成`],
          artifacts: [{ kind: 'chapter', id: `c${starts}`, title: `第${starts}章` }],
        },
      });
    });

    const result = await runAgentBackgroundJob(
      '/api',
      {
        task: 'long_novel',
        mode: 'draft',
        prompt: '测试',
        options: { chapters: 3, totalChapters: 10 },
      },
      { onProgress: progress },
    );

    expect(starts).toBe(3);
    expect(startedBodies.map((body) => body.options?.chapters)).toEqual([1, 1, 1]);
    expect(startedBodies.map((body) => body.options?.totalChapters)).toEqual([10, 10, 10]);
    expect(startedBodies.slice(1).map((body) => body.projectId)).toEqual(['p1', 'p1']);
    expect(progress.mock.calls.map(([event]) => [event.current, event.total])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(result.artifacts).toHaveLength(3);
    expect(result.summary).toContain('3/3');
  });
});

describe('persistent backend Agent jobs', () => {
  it('creates a server job and replays persisted progress while polling', async () => {
    const progress = vi.fn();
    let polls = 0;
    const result: AgentRunResult = {
      task: 'long_novel', mode: 'draft', projectId: 'p1', summary: '完成', steps: [], artifacts: [],
    };
    const mock = installFetch((url, init) => {
      if (String(url).endsWith('/agent/jobs') && init?.method === 'POST') {
        return jsonResponse({ id: 'job-1', status: 'queued', events: [] }, { status: 202 });
      }
      polls += 1;
      return jsonResponse(polls === 1
        ? { id: 'job-1', status: 'running', events: [{ phase: 'chapter', message: '第1章完成' }] }
        : { id: 'job-1', status: 'completed', events: [{ phase: 'chapter', message: '第1章完成' }], result });
    });

    await expect(runPersistentAgentJob('/api', {
      task: 'long_novel', mode: 'draft', prompt: '写一章', projectId: 'p1',
    }, { onProgress: progress })).resolves.toEqual(result);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls.map((call) => String(call[0]))).toEqual([
      '/api/agent/jobs', '/api/agent/jobs/job-1', '/api/agent/jobs/job-1',
    ]);
  });

  it('automatically resumes an interrupted persistent job', async () => {
    const result: AgentRunResult = {
      task: 'long_novel', mode: 'draft', projectId: 'p1', summary: '继续完成', steps: [], artifacts: [],
    };
    let resumed = false;
    installFetch((url, init) => {
      if (String(url).endsWith('/agent/jobs') && init?.method === 'POST') {
        return jsonResponse({ id: 'job-1', status: 'queued', events: [] }, { status: 202 });
      }
      if (String(url).endsWith('/resume') && init?.method === 'POST') {
        resumed = true;
        return jsonResponse({ id: 'job-1', status: 'queued', events: [] });
      }
      return jsonResponse(resumed
        ? { id: 'job-1', status: 'completed', events: [], result }
        : {
          id: 'job-1',
          status: 'waiting_user',
          events: [],
          error: { code: 'RUN_INTERRUPTED', message: '服务已重启，请重新连接以继续任务。' },
        });
    });

    await expect(runPersistentAgentJob('/api', {
      task: 'long_novel', mode: 'draft', prompt: '写一章', projectId: 'p1',
    })).resolves.toEqual(result);
    expect(resumed).toBe(true);
  });

  it('keeps polling after one silent status request times out', async () => {
    vi.useFakeTimers();
    const progress = vi.fn();
    let polls = 0;
    const result: AgentRunResult = {
      task: 'long_novel', mode: 'draft', projectId: 'p1', summary: '完成', steps: [], artifacts: [],
    };
    installFetch((url, init) => {
      if (String(url).endsWith('/agent/jobs') && init?.method === 'POST') {
        return jsonResponse({ id: 'job-1', status: 'queued', events: [] }, { status: 202 });
      }
      polls += 1;
      if (polls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      }
      return jsonResponse({ id: 'job-1', status: 'completed', events: [], result });
    });

    const pending = runPersistentAgentJob('/api', {
      task: 'long_novel', mode: 'draft', prompt: '写一章', projectId: 'p1',
    }, { onProgress: progress });
    await vi.advanceTimersByTimeAsync(46_100);

    await expect(pending).resolves.toEqual(result);
    expect(polls).toBe(2);
    expect(progress.mock.calls.map(([event]) => event.message)).toEqual([
      '后台仍在生成，页面连接较慢，正在自动重连…',
      '已恢复连接，任务继续运行。',
    ]);
  });
});

// ---------------------------------------------------------------------------
// SSE parsing (pure function)
// ---------------------------------------------------------------------------

describe('parseSseEvents', () => {
  it('parses complete events and retains a trailing partial block', () => {
    const { events, rest } = parseSseEvents(
      'event: delta\ndata: "hi"\n\nevent: delta\ndata: "the',
    );
    expect(events).toEqual<SseEvent[]>([{ event: 'delta', data: '"hi"' }]);
    expect(rest).toBe('event: delta\ndata: "the');
  });

  it('handles CRLF line endings and multi-line data', () => {
    const { events } = parseSseEvents('event: x\r\ndata: a\r\ndata: b\r\n\r\n');
    expect(events).toEqual<SseEvent[]>([{ event: 'x', data: 'a\nb' }]);
  });

  it('defaults the event name to message and ignores comments', () => {
    const { events } = parseSseEvents(': keep-alive\ndata: hello\n\n');
    expect(events).toEqual<SseEvent[]>([{ event: 'message', data: 'hello' }]);
  });
});

// ---------------------------------------------------------------------------
// write() SSE streaming
// ---------------------------------------------------------------------------

const writeBody: WritingRequestBody = { operation: 'continue', instruction: '续写' };

describe('apiClient.write SSE streaming', () => {
  it('forwards deltas in order and resolves with the concatenated text', async () => {
    installFetch(() =>
      sseResponse([
        'event: delta\ndata: "Hello "\n\n',
        'event: delta\ndata: "world"\n\n',
        'event: done\ndata:\n\n',
      ]),
    );

    const deltas: string[] = [];
    const full = await client().write('p1', 'c1', writeBody, {
      onDelta: (d) => deltas.push(d),
    });

    expect(deltas).toEqual(['Hello ', 'world']);
    expect(full).toBe('Hello world');
  });

  it('strips leaked think blocks from streamed writing deltas', async () => {
    installFetch(() =>
      sseResponse([
        'event: delta\ndata: "第一段<th"\n\n',
        'event: delta\ndata: "ink>内部推理"\n\n',
        'event: delta\ndata: "</think>第二段"\n\n',
        'event: done\ndata:\n\n',
      ]),
    );

    const deltas: string[] = [];
    const full = await client().write('p1', 'c1', writeBody, {
      onDelta: (d) => deltas.push(d),
    });

    expect(deltas).toEqual(['第一段', '第二段']);
    expect(full).toBe('第一段第二段');
  });

  it('reassembles deltas split across network chunks', async () => {
    installFetch(() =>
      sseResponse([
        'event: delta\nda',
        'ta: "ab"\n\nevent: del',
        'ta\ndata: "cd"\n\nevent: done\n\n',
      ]),
    );
    const full = await client().write('p1', 'c1', writeBody);
    expect(full).toBe('abcd');
  });

  it('rejects a truncated stream that closes without a done sentinel', async () => {
    installFetch(() => sseResponse(['event: delta\ndata: "partial"\n\n']));
    const err: ApiClientError = await client().write('p1', 'c1', writeBody).catch((e) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.message).toContain('提前结束');
  });

  it('rejects with ApiClientError on an event: error frame', async () => {
    const apiError: ApiError = {
      error: { code: 'PROVIDER_ERROR', message: '提供商超时' },
    };
    installFetch(() =>
      sseResponse([
        'event: delta\ndata: "partial"\n\n',
        `event: error\ndata: ${JSON.stringify(apiError)}\n\n`,
      ]),
    );

    const err: ApiClientError = await client()
      .write('p1', 'c1', writeBody)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.message).toBe('提供商超时');
  });

  it('converts a non-success HTTP write response into ApiClientError', async () => {
    const apiError: ApiError = {
      error: { code: 'MODEL_NOT_CONFIGURED', message: '请先配置模型' },
    };
    installFetch(() => jsonResponse(apiError, { status: 409 }));
    const err: ApiClientError = await client()
      .write('p1', 'c1', writeBody)
      .catch((e) => e);
    expect(err.code).toBe('MODEL_NOT_CONFIGURED');
    expect(err.message).toBe('请先配置模型');
  });

  it('posts the writing body with SSE Accept header', async () => {
    const mock = installFetch(() => sseResponse(['event: done\ndata:\n\n']));
    await client().write('p 1', 'c/1', writeBody);
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe('/api/projects/p%201/chapters/c%2F1/write');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Accept).toBe('text/event-stream');
    expect(JSON.parse(String(init?.body))).toEqual(writeBody);
  });
});

describe('apiClient imports', () => {
  it('posts dropped novel files to the import endpoint', async () => {
    const mock = installFetch(() =>
      jsonResponse({
        projectId: 'p1',
        sourceName: 'book',
        filesImported: 1,
        chaptersCreated: 1,
        charactersCreated: 1,
        worldSettingsCreated: 1,
        outlinesCreated: 1,
        firstChapterId: 'c1',
        summary: 'ok',
        artifacts: [],
      }),
    );

    await client().imports.organizeNovel('p/1', {
      sourceName: 'book',
      files: [{ path: 'book.md', content: '# 第一章\n正文' }],
    });

    const [url, init] = mock.mock.calls[0];
    expect(url).toBe('/api/projects/p%2F1/import/novel');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      sourceName: 'book',
      files: [{ path: 'book.md', content: '# 第一章\n正文' }],
    });
  });
});

// ---------------------------------------------------------------------------
// Property: SSE deltas are forwarded losslessly and in order
// ---------------------------------------------------------------------------

describe('apiClient.write delta integrity (property)', () => {
  it('concatenated forwarded deltas equal the source regardless of chunk boundaries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.string().filter((value) => !/<\s*\/?\s*(think|thinking|reasoning)/i.test(value)),
          { minLength: 0, maxLength: 20 },
        ),
        fc.integer({ min: 1, max: 64 }),
        async (sourceDeltas, chunkSize) => {
          // Build the full SSE wire text, then re-slice into arbitrary chunks.
          const frames =
            sourceDeltas.map((d) => `event: delta\ndata: ${JSON.stringify(d)}\n\n`).join('') +
            'event: done\ndata:\n\n';
          const chunks: string[] = [];
          for (let i = 0; i < frames.length; i += chunkSize) {
            chunks.push(frames.slice(i, i + chunkSize));
          }

          installFetch(() => sseResponse(chunks));
          const received: string[] = [];
          const full = await client().write('p', 'c', writeBody, {
            onDelta: (d) => received.push(d),
          });
          vi.unstubAllGlobals();

          // Empty-string deltas are dropped (no-op), so compare non-empty source.
          const nonEmpty = sourceDeltas.filter((d) => d.length > 0);
          expect(received.join('')).toBe(nonEmpty.join(''));
          expect(full).toBe(nonEmpty.join(''));
        },
      ),
      { numRuns: 100 },
    );
  });
});
