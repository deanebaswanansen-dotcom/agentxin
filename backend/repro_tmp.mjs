import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDataStore } from './src/store/FileDataStore.ts';
import { ChapterService } from './src/services/chapter/ChapterService.ts';

// Reproduce the heavy-IO pattern of the property test to surface the underlying
// cause of the intermittent StoreError on write.
const content = '𑲀𑂚ꓥ𔘣⦄𒃕܌㎳';
const dir = await mkdtemp(join(tmpdir(), 'repro-'));
let failures = 0;
for (let run = 1; run <= 120; run += 1) {
  const filePath = join(dir, `store-${run}.json`);
  try {
    const store = await FileDataStore.create(filePath);
    const service = new ChapterService(store);
    const project = await store.createProject('p');
    const chapter = await service.create(project.id, 't');
    const big = content.repeat(300);
    const updated = await service.updateContent(chapter.id, big);
    const reread = await store.getChapter(chapter.id);
    const reloaded = await FileDataStore.create(filePath);
    const after = await reloaded.getChapter(chapter.id);
    if (updated.content !== big || reread?.content !== big || after?.content !== big) {
      console.log(`run ${run}: MISMATCH`);
      failures += 1;
    }
  } catch (e) {
    failures += 1;
    console.log(`run ${run}: ERROR ${e?.constructor?.name}: ${e?.message}`);
    if (e?.cause) {
      console.log(`  cause: ${e.cause?.code ?? ''} ${e.cause?.message ?? e.cause}`);
    }
  }
}
console.log(`done. failures=${failures}`);
await rm(dir, { recursive: true, force: true });
