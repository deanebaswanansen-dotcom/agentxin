import { agentJobStore, jobKey, readClientId } from './_shared/netlifyData.mjs';

const JOB_ID_PATTERN = /^[a-f0-9-]{16,64}$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default async (request) => {
  const clientId = readClientId(request);
  const jobId = new URL(request.url).searchParams.get('jobId') ?? '';
  if (clientId === undefined || !JOB_ID_PATTERN.test(jobId)) {
    return json({ error: { code: 'VALIDATION_ERROR', message: '任务标识无效。' } }, 400);
  }

  const store = agentJobStore();
  const key = jobKey(clientId, jobId);
  if (request.method === 'DELETE') {
    await store.delete(key);
    return new Response(null, { status: 204 });
  }
  if (request.method !== 'GET') {
    return json({ error: { code: 'VALIDATION_ERROR', message: '请求方法无效。' } }, 405);
  }

  const job = await store.get(key, { type: 'json' });
  if (job === null) {
    return json({ error: { code: 'NOT_FOUND', message: '后台任务尚未启动或已清理。' } }, 404);
  }
  return json(job);
};
