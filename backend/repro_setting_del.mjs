import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDataStore } from './src/store/FileDataStore.ts';
import { SettingService } from './src/services/setting/SettingService.ts';

let eperm = 0;
let other = 0;
const ITER = 120;
for (let i = 0; i < ITER; i++) {
  const dir = await mkdtemp(join(tmpdir(), 'setting-del-repro-'));
  try {
    const store = await FileDataStore.create(join(dir, 'store.json'));
    const service = new SettingService(store);
    const project = await store.createProject('p');
    const pid = project.id;
    const ids = [];
    for (let k = 0; k < 5; k++) {
      const c = await service.characters.create(pid, 'n' + k, 'd' + k);
      ids.push(c.id);
    }
    const target = ids[i % ids.length];
    await service.characters.remove(target);
    const after = await service.characters.list(pid);
    if (after.some((e) => e.id === target)) throw new Error('target survived');
    if (after.length !== ids.length - 1) throw new Error('wrong length');
  } catch (e) {
    const msg = String(e?.cause?.code ?? e?.message ?? e);
    if (msg.includes('EPERM') || String(e).includes('EPERM')) eperm++;
    else { other++; console.log('iter', i, 'NON-EPERM error:', e); }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
console.log(`Done ${ITER} iters. EPERM failures=${eperm}, other failures=${other}`);
