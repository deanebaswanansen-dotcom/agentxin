import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServer } from '../../../backend/dist/index.js';
import { MemoryService } from '../../../backend/dist/services/memory/MemoryService.js';
import { createClientScopedDataStore } from '../../../backend/dist/store/ClientScopedDataStore.js';
import {
  createClientScopedLongNovelConfigStore,
  createClientScopedMemoryStore,
  createClientScopedReferenceStore,
} from '../../../backend/dist/store/ClientScopedAuxiliaryStores.js';
import {
  agentJobStore,
  hydrateClientData,
  jobKey,
  persistClientData,
  readClientId,
} from './_shared/netlifyData.mjs';

const JOB_ID_PATTERN = /^[a-f0-9-]{16,64}$/;

function parseSseBlock(block) {
  let event = 'message';
  const data = [];
  for (const rawLine of block.replace(/\r\n/g, '\n').split('\n')) {
    if (rawLine.startsWith(':') || rawLine.length === 0) continue;
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  return { event, data: data.join('\n') };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function failure(message) {
  return { error: { code: 'PROVIDER_ERROR', message } };
}

function boundedRunRequest(runRequest) {
  if (runRequest?.task !== 'long_novel' && runRequest?.task !== 'full_novel') {
    return runRequest;
  }
  const requested = Number(runRequest?.options?.chapters ?? 1);
  if (!Number.isFinite(requested) || requested <= 1) return runRequest;
  const totalChapters =
    runRequest?.options?.totalChapters ?? runRequest?.options?.planSummary?.chapterCount ?? requested;
  return {
    ...runRequest,
    options: { ...runRequest.options, chapters: 1, totalChapters },
  };
}

async function createApp(clientDataDir) {
  const store = createClientScopedDataStore(join(clientDataDir, 'projects'));
  const memoryStore = await createClientScopedMemoryStore(join(clientDataDir, 'memory'));
  const referenceStore = await createClientScopedReferenceStore(join(clientDataDir, 'references'));
  const longNovelStore = await createClientScopedLongNovelConfigStore(
    join(clientDataDir, 'long-novel'),
  );
  return buildServer(
    store,
    undefined,
    new MemoryService(memoryStore),
    referenceStore,
    longNovelStore,
  );
}

export default async (request) => {
  process.env.NETLIFY = 'true';
  process.env.NODE_ENV = 'production';

  const clientId = readClientId(request);
  const modelConfig = request.headers.get('x-agentxin-model-config');
  const payload = await request.json().catch(() => undefined);
  const jobId = payload?.jobId;
  const runRequest = payload?.request;
  if (
    clientId === undefined ||
    typeof modelConfig !== 'string' ||
    !JOB_ID_PATTERN.test(jobId ?? '') ||
    typeof runRequest !== 'object' ||
    runRequest === null
  ) {
    return;
  }

  const jobs = agentJobStore();
  const key = jobKey(clientId, jobId);
  const clientDataDir = join(tmpdir(), 'agentxin-background', jobId);
  const state = {
    state: 'running',
    events: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const save = async () => {
    state.updatedAt = new Date().toISOString();
    await jobs.setJSON(key, state);
  };

  await save();
  let app;
  try {
    await hydrateClientData(clientDataDir, clientId);
    app = await createApp(clientDataDir);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    if (port === 0) throw new Error('后台 Agent 服务启动失败。');

    const response = await fetch(`http://127.0.0.1:${port}/api/agent/run-stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Agentxin-Client-Id': clientId,
        'X-Agentxin-Model-Config': modelConfig,
      },
      // Compatibility guard for already-open tabs running older frontend code.
      // One Netlify background invocation must never try to write an entire book.
      body: JSON.stringify(boundedRunRequest(runRequest)),
    });
    if (!response.ok || response.body === null) {
      throw new Error(`后台 Agent 请求失败（HTTP ${response.status}）。`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result;
    let streamError;
    let done = false;

    const consume = async (block) => {
      const event = parseSseBlock(block);
      if (event.event === 'progress') {
        const progress = safeJson(event.data);
        if (progress !== undefined) {
          state.events.push(progress);
          if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
          await save();
        }
      } else if (event.event === 'result') {
        result = safeJson(event.data);
      } else if (event.event === 'error') {
        streamError = safeJson(event.data) ?? failure('后台 Agent 执行失败。');
      } else if (event.event === 'done') {
        done = true;
      }
    };

    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        await consume(block);
        boundary = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) await consume(buffer);

    await persistClientData(clientDataDir, clientId);
    if (streamError !== undefined) {
      state.state = 'failed';
      state.error = streamError;
    } else if (!done || result === undefined) {
      state.state = 'failed';
      state.error = failure('后台 Agent 流未返回最终结果。');
    } else {
      state.state = 'completed';
      state.result = result;
    }
    await save();
  } catch (error) {
    try {
      await persistClientData(clientDataDir, clientId);
    } catch {
      // Preserve the primary error below.
    }
    state.state = 'failed';
    state.error = failure(error instanceof Error ? error.message : '后台 Agent 执行失败。');
    await save();
  } finally {
    await app?.close().catch(() => undefined);
  }
};
