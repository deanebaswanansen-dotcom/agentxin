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

// Netlify Functions: returning a `Response` whose body is a ReadableStream marks
// this as a *streaming* function — 60s execution limit (vs 10s for buffered
// responses) and incremental client delivery. The backend SSE routes write to a
// hijacked socket, so we run the real Fastify app on an ephemeral loopback port
// inside the function and proxy through it with a streaming `fetch`. This
// reproduces the local dev path (browser -> Fastify over HTTP) instead of
// buffering through `app.inject()`, which both loses streaming and dies at the
// 10s synchronous timeout (HTTP 502). If the sandbox disallows binding a
// listener we fall back to the old `inject()` transport.

let appPromise;
let runtimePromise;

// Keep this function inside the frontend base directory so Netlify deploys it
// with the same site that serves the Vite SPA.
function readEnv(name, fallback) {
  const netlifyValue = globalThis.Netlify?.env?.get?.(name);
  return netlifyValue ?? process.env[name] ?? fallback;
}

function hydrateBackendEnv() {
  for (const name of [
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
    const clientDataDir = readEnv('CLIENT_DATA_DIR', join(tmpdir(), 'agentxin-clients'));
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
  })();
  return appPromise;
}

// Start the Fastify app on an ephemeral loopback port so the function can stream
// through it. Falls back to the buffered inject() transport if the sandbox
// disallows listening sockets.
async function getRuntime() {
  runtimePromise ??= (async () => {
    const app = await getApp();
    try {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      if (port > 0) return { kind: 'proxy', port };
    } catch (err) {
      console.error(
        '[api] internal listener unavailable, falling back to inject():',
        err?.message ?? err,
      );
    }
    return { kind: 'inject' };
  })();
  return runtimePromise;
}

function apiPathFromRequest(url) {
  let path = url.pathname;
  if (path.startsWith('/.netlify/functions/api')) {
    path = `/api${path.slice('/.netlify/functions/api'.length)}`;
  }
  return path === '' ? '/api' : path;
}

// Hop-by-hop headers must not be forwarded through a proxy (fetch recomputes
// Host/Content-Length; Connection/Transfer-Encoding would corrupt framing).
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
]);

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

// Streaming transport: proxy the request to the in-function Fastify listener and
// forward the upstream ReadableStream straight to the client. Netlify treats the
// returned stream body as a streaming function (60s budget, chunk delivery).
async function proxyRequest(req, target, port) {
  const headers = new Headers();
  for (const [key, value] of req.headers.entries()) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  }

  const payload =
    req.method === 'GET' || req.method === 'HEAD'
      ? undefined
      : Buffer.from(await req.arrayBuffer());

  const upstream = await fetch(`http://127.0.0.1:${port}${target}`, {
    method: req.method,
    headers,
    body: payload,
  });

  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) responseHeaders.set(key, value);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

// Buffered fallback (previous behavior) for sandboxes without a listener.
async function injectRequest(app, req, target) {
  const payload =
    req.method === 'GET' || req.method === 'HEAD'
      ? undefined
      : Buffer.from(await req.arrayBuffer());

  const res = await app.inject({
    method: req.method,
    url: target,
    headers: Object.fromEntries(req.headers.entries()),
    payload,
  });

  return new Response(res.rawPayload ?? res.body, {
    status: res.statusCode,
    headers: toResponseHeaders(res.headers),
  });
}

export default async (req) => {
  const app = await getApp();
  const runtime = await getRuntime();
  const url = new URL(req.url);
  const target = `${apiPathFromRequest(url)}${url.search}`;

  if (runtime.kind === 'proxy') {
    return proxyRequest(req, target, runtime.port);
  }
  return injectRequest(app, req, target);
};

export const config = {
  path: ['/api', '/api/*'],
};
