import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServer } from '../../../backend/dist/index.js';
import { MemoryService } from '../../../backend/dist/services/memory/MemoryService.js';
import { MemoryStore } from '../../../backend/dist/services/memory/MemoryStore.js';
import { FileDataStore } from '../../../backend/dist/store/FileDataStore.js';

let appPromise;

// Keep this function inside the frontend base directory so Netlify deploys it
// with the same site that serves the Vite SPA.
function readEnv(name, fallback) {
  const netlifyValue = globalThis.Netlify?.env?.get?.(name);
  return netlifyValue ?? process.env[name] ?? fallback;
}

function hydrateBackendEnv() {
  for (const name of [
    'APP_AUTH_DISABLED',
    'APP_AUTH_USERNAME',
    'APP_AUTH_PASSWORD',
    'APP_AUTH_PASSWORD_SHA256',
    'APP_SESSION_SECRET',
    'NETLIFY',
    'NODE_ENV',
  ]) {
    const value = globalThis.Netlify?.env?.get?.(name);
    if (value !== undefined) process.env[name] = value;
  }
  process.env.NETLIFY ??= 'true';
  process.env.NODE_ENV ??= 'production';
}

async function getApp() {
  appPromise ??= (async () => {
    hydrateBackendEnv();
    const dataFile = readEnv('DATA_FILE', join(tmpdir(), 'agentxin-store.json'));
    const memoryFile = readEnv('AGENT_MEMORY_FILE', join(tmpdir(), 'agentxin-memory.json'));
    const store = await FileDataStore.create(dataFile);
    const memoryStore = await MemoryStore.create(memoryFile);
    return buildServer(store, undefined, new MemoryService(memoryStore));
  })();
  return appPromise;
}

function apiPathFromRequest(url) {
  let path = url.pathname;
  if (path.startsWith('/.netlify/functions/api')) {
    path = `/api${path.slice('/.netlify/functions/api'.length)}`;
  }
  return path === '' ? '/api' : path;
}

function toResponseHeaders(headers) {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, String(item));
    } else {
      result.set(key, String(value));
    }
  }
  return result;
}

export default async (req) => {
  const app = await getApp();
  const url = new URL(req.url);
  const payload = req.method === 'GET' || req.method === 'HEAD'
    ? undefined
    : Buffer.from(await req.arrayBuffer());

  const res = await app.inject({
    method: req.method,
    url: `${apiPathFromRequest(url)}${url.search}`,
    headers: Object.fromEntries(req.headers.entries()),
    payload,
  });

  return new Response(res.rawPayload ?? res.body, {
    status: res.statusCode,
    headers: toResponseHeaders(res.headers),
  });
};

export const config = {
  path: ['/api', '/api/*'],
};
