import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { buildServer } from '../src/index.js';
import { OpenAiCompatibleModelProxy } from '../src/proxy/ModelProxy.js';
import { FileDataStore } from '../src/store/FileDataStore.js';
import { AgentRunStore } from '../src/services/agent/jobs/AgentRunStore.js';
import { FileScriptCheckpointStore } from '../src/services/script/FileScriptCheckpointStore.js';
import { FileScriptStore } from '../src/services/script/FileScriptStore.js';

const CLIENT_ID = 'e'.repeat(64);
const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled']);

interface JobSnapshot {
  id: string;
  status: string;
  events?: unknown[];
  error?: { code?: string; message?: string };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} did not return a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is missing`);
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function run(): Promise<void> {
  const apiKey = process.env.SHORT_DRAMA_E2E_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Set SHORT_DRAMA_E2E_API_KEY in process memory before running acceptance.');
  }
  const modelConfig = encodeURIComponent(JSON.stringify({
    baseUrl: process.env.SHORT_DRAMA_E2E_BASE_URL?.trim() || 'https://api.deepseek.com',
    apiKey,
    modelName: process.env.SHORT_DRAMA_E2E_MODEL?.trim() || 'deepseek-chat',
    temperature: 0.6,
    maxTokens: 16_000,
  }));
  const headers = {
    'x-agentxin-client-id': CLIENT_ID,
    'x-agentxin-model-config': modelConfig,
  };
  const root = await mkdtemp(join(tmpdir(), 'agentxin-short-drama-e2e-'));
  let app: FastifyInstance | undefined;
  const startedAt = Date.now();
  const timings: Record<string, number> = {};

  try {
    const store = await FileDataStore.create(join(root, 'store.json'));
    const agentRuns = await AgentRunStore.create(join(root, 'agent-runs.json'));
    const scripts = await FileScriptStore.create(join(root, 'scripts'));
    const checkpoints = await FileScriptCheckpointStore.create(join(root, 'script-checkpoints'));
    app = buildServer(
      store,
      new OpenAiCompatibleModelProxy(),
      undefined,
      undefined,
      undefined,
      undefined,
      agentRuns,
      scripts,
      checkpoints,
    );

    const jsonRequest = async (
      method: 'GET' | 'POST' | 'PUT',
      url: string,
      payload?: unknown,
    ): Promise<unknown> => {
      const response = await app!.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
      const body = response.json() as unknown;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const safe = object(body, `${method} ${url}`);
        throw new Error(`${method} ${url} failed (${response.statusCode}): ${JSON.stringify(safe.error ?? safe)}`);
      }
      return body;
    };

    const runJob = async (label: string, payload: Record<string, unknown>): Promise<JobSnapshot> => {
      const stageStartedAt = Date.now();
      const created = object(await jsonRequest('POST', '/api/agent/jobs', payload), label) as unknown as JobSnapshot;
      while (!TERMINAL_JOB_STATES.has(created.status)) {
        await delay(750);
        const latest = object(
          await jsonRequest('GET', `/api/agent/jobs/${encodeURIComponent(created.id)}`),
          `${label} poll`,
        ) as unknown as JobSnapshot;
        Object.assign(created, latest);
      }
      timings[label] = Date.now() - stageStartedAt;
      if (created.status !== 'completed') {
        throw new Error(`${label} ended as ${created.status}: ${created.error?.code ?? 'RUN_FAILED'} ${created.error?.message ?? ''}`);
      }
      return created;
    };

    const project = object(await jsonRequest('POST', '/api/projects', {
      name: '真实模型短剧验收',
      kind: 'short_drama',
    }), 'create project');
    const projectId = requiredString(project.id, 'project id');

    const planJob = await runJob('plan', {
      task: 'script_plan',
      projectId,
      prompt: '原创当代都市女频短剧：一名便利店夜班店员用一张错发的彩票，揭穿老板侵吞员工奖金的骗局。只做一集完整闭环。',
    });
    const generatedPlan = object(
      await jsonRequest('GET', `/api/projects/${encodeURIComponent(projectId)}/script-plan`),
      'generated plan',
    );
    const planRevision = Number(generatedPlan.revision);
    const boundedPlan = {
      ...generatedPlan,
      totalEpisodes: 1,
      targetCharsPerEpisode: 300,
      maxPrimaryCharacters: Math.min(4, Number(generatedPlan.maxPrimaryCharacters) || 4),
      maxScenesPerEpisode: 1,
      episodeDurationSeconds: { min: 30, max: 60 },
      dialogueDensityPercent: 60,
      coreRequirements: '单集完整闭环；只用人物圣经中的角色；正文严格控制为300个可见字符左右；只允许1场；结尾必须有明确反转卡点。',
    };
    const savedPlan = object(await jsonRequest(
      'PUT',
      `/api/projects/${encodeURIComponent(projectId)}/script-plan`,
      { expectedRevision: planRevision, value: boundedPlan },
    ), 'save bounded plan');
    const approvedPlan = object(await jsonRequest(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/script-plan/approve`,
      { expectedRevision: Number(savedPlan.revision) },
    ), 'approve plan');

    const outlineJob = await runJob('outline', {
      task: 'script_series_outline',
      projectId,
      prompt: '生成一集全剧总纲和分集卡。',
    });
    const bibleJob = await runJob('bible', {
      task: 'script_bible',
      projectId,
      prompt: '生成精简人物圣经和当代都市世界圣经。',
    });
    const batchJob = await runJob('episode', {
      task: 'script_episode_batch',
      projectId,
      prompt: '生成第1集并通过质量门。',
      scriptBatchOptions: {
        startEpisode: 1,
        episodeCount: 1,
        expectedPlanRevision: Number(approvedPlan.revision),
      },
    });

    const episodes = await jsonRequest(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/script-episodes`,
    );
    if (!Array.isArray(episodes) || episodes.length !== 1) {
      throw new Error(`expected exactly one episode, got ${Array.isArray(episodes) ? episodes.length : 'non-array'}`);
    }
    const episode = object(episodes[0], 'episode summary');
    if (episode.status !== 'completed') throw new Error(`episode status is ${String(episode.status)}`);

    for (const format of ['txt', 'md', 'fountain'] as const) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${encodeURIComponent(projectId)}/script-export?format=${format}`,
        headers,
      });
      if (response.statusCode !== 200 || !response.body.trim()) {
        throw new Error(`${format} export failed or was empty`);
      }
    }

    const checkpointEvents = [planJob, outlineJob, bibleJob, batchJob]
      .reduce((total, job) => total + (job.events?.length ?? 0), 0);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      model: process.env.SHORT_DRAMA_E2E_MODEL?.trim() || 'deepseek-chat',
      totalMilliseconds: Date.now() - startedAt,
      timings,
      checkpointEvents,
      episode: {
        number: episode.episodeNumber,
        status: episode.status,
        visibleChars: episode.visibleChars,
        sceneCount: episode.sceneCount,
      },
      exports: ['txt', 'md', 'fountain'],
    }, null, 2)}\n`);
  } finally {
    await app?.close();
    if (process.env.SHORT_DRAMA_E2E_KEEP_TEMP === '1') {
      process.stderr.write(`Acceptance artifacts kept at: ${root}\n`);
    } else {
      await rm(root, { recursive: true, force: true });
    }
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown acceptance failure';
  process.stderr.write(`Short-drama acceptance failed: ${message}\n`);
  process.exitCode = 1;
});
