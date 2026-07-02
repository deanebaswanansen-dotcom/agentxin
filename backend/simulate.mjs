import http from 'node:http';

const req = (method, path, body) => new Promise((resolve, reject) => {
  const r = http.request({
    hostname: 'localhost',
    port: 3000,
    path,
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {}
  }, res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => resolve(data));
  });
  r.on('error', reject);
  if (body) r.write(JSON.stringify(body));
  r.end();
});

async function main() {
  const p = JSON.parse(await req('GET', '/api/projects'))[0];
  const c = JSON.parse(await req('GET', `/api/projects/${p.id}/chapters`))[0];
  console.log('Testing Project:', p.name, 'Chapter:', c.title);
  
  console.log('\n--- Run 1 ---');
  let res1 = await req('POST', `/api/projects/${p.id}/chapters/${c.id}/write`, {
    operation: 'continue',
    instruction: '描写一下林远此时的心情。',
    sessionHistory: []
  });
  console.log('Run 1 response length:', res1.length);
  
  console.log('\n--- Run 2 ---');
  let res2 = await req('POST', `/api/projects/${p.id}/chapters/${c.id}/write`, {
    operation: 'continue',
    instruction: '描写一下环境，灯光昏暗。',
    sessionHistory: []
  });
  console.log('Run 2 response length:', res2.length);
}
main();
