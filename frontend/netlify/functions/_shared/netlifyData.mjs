import { getStore } from '@netlify/blobs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CLIENT_ID_PATTERN = /^[a-f0-9]{64}$/;
const DATA_KINDS = ['projects', 'memory', 'references', 'long-novel'];

function clientFile(rootDirectory, clientId, kind) {
  return join(rootDirectory, kind, `${clientId}.json`);
}

function blobKey(clientId, kind) {
  return `${clientId}/${kind}.json`;
}

export function readClientId(request) {
  const clientId = request.headers.get('x-agentxin-client-id') ?? '';
  return CLIENT_ID_PATTERN.test(clientId) ? clientId : undefined;
}

export function clientDataStore() {
  return getStore({ name: 'agentxin-client-data', consistency: 'strong' });
}

export function agentJobStore() {
  return getStore({ name: 'agentxin-agent-jobs', consistency: 'strong' });
}

/** Restore one browser library's files before constructing its backend app. */
export async function hydrateClientData(rootDirectory, clientId) {
  const store = clientDataStore();
  await Promise.all(
    DATA_KINDS.map(async (kind) => {
      const content = await store.get(blobKey(clientId, kind));
      if (content === null) return;
      const filePath = clientFile(rootDirectory, clientId, kind);
      await mkdir(join(rootDirectory, kind), { recursive: true });
      await writeFile(filePath, content, 'utf8');
    }),
  );
}

/** Persist only data files that exist; model credentials never enter these files. */
export async function persistClientData(rootDirectory, clientId) {
  const store = clientDataStore();
  await Promise.all(
    DATA_KINDS.map(async (kind) => {
      const filePath = clientFile(rootDirectory, clientId, kind);
      try {
        const content = await readFile(filePath, 'utf8');
        await store.set(blobKey(clientId, kind), content, {
          metadata: { updatedAt: new Date().toISOString() },
        });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }),
  );
}

export function jobKey(clientId, jobId) {
  return `${clientId}/${jobId}.json`;
}
