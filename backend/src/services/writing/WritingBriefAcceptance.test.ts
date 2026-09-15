import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelProxy } from '../../proxy/ModelProxy.js';
import { registerChapterRoutes } from '../../routes/chapterRoutes.js';
import { registerWritingRoutes } from '../../routes/writingRoutes.js';
import { FileDataStore } from '../../store/FileDataStore.js';
import type { WriteBrief } from '../../types/WriteBrief.js';
import { ChapterService } from '../chapter/ChapterService.js';
import { ModelConfigService } from '../modelConfig/ModelConfigService.js';
import { WritingService } from './WritingService.js';

describe('novel writing → SSE brief → HTTP adoption → durable provenance', () => {
  let directory: string;
  let file: string;
  let app: FastifyInstance;
  let store: FileDataStore;
  let projectId: string;
  let chapterId: string;
  let characterId: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'writing-brief-acceptance-'));
    file = join(directory, 'store.json');
    store = await FileDataStore.create(file);
    projectId = (await store.createProject('任务书验收')).id;
    const previous = await store.createChapter(projectId, '第一章');
    await store.updateChapterContent(previous.id, '阿青把钥匙留在了门外。');
    chapterId = (await store.createChapter(projectId, '第二章')).id;
    await store.updateChapterContent(chapterId, '第二章原文');
    characterId = (await store.createCharacter(projectId, '阿青', '不识水性')).id;
    const config = new ModelConfigService(store);
    await config.save({ baseUrl: 'https://example.invalid/v1', apiKey: 'test-only', modelName: 'fixture' });
    const proxy: ModelProxy = { streamCompletion: () => (async function* () { yield { kind: 'content' as const, text: '候选正文' }; })() };
    app = Fastify({ logger: false });
    registerWritingRoutes(app, new WritingService(store, config, proxy));
    registerChapterRoutes(app, new ChapterService(store));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function generate(): Promise<WriteBrief> {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/chapters/${chapterId}/write`,
      payload: { operation: 'continue', instruction: '不得让阿青游泳渡河。' } });
    expect(response.body).toContain('event: done');
    expect(response.body).not.toContain('event: error');
    return JSON.parse(response.body.match(/event: write_brief\ndata: (.*)\n\n/)![1]) as WriteBrief;
  }

  it('saves the author-confirmed candidate once and preserves the exact used brief across restart', async () => {
    const brief = await generate();
    const payload = { content: '第二章原文\n候选正文', writeBrief: brief };
    const response = await app.inject({ method: 'POST', url: `/api/chapters/${chapterId}/generated-content`, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ content: payload.content, revision: brief.target.revision + 1 });
    const reopened = await FileDataStore.create(file);
    const view = await new ChapterService(reopened).getWriteBrief(chapterId);
    expect(view).toMatchObject({ status: 'current', origin: 'generation', brief });
    expect((await reopened.getChapter(chapterId))!.generatedCandidate?.brief).toEqual(brief);
    const savedBytes = await readFile(file, 'utf8');
    const duplicate = await app.inject({ method: 'POST', url: `/api/chapters/${chapterId}/generated-content`, payload });
    expect(duplicate.statusCode).toBe(409);
    expect(await readFile(file, 'utf8')).toBe(savedBytes);
  });

  it.each(['edit', 'add', 'remove'])('rejects %s of source characters after generation without touching the file', async (change) => {
    const brief = await generate();
    if (change === 'edit') await store.updateCharacter(characterId, { description: '作者修订：受伤不能奔跑' });
    if (change === 'add') await store.createCharacter(projectId, '新人物', '必须参加这一幕');
    if (change === 'remove') await store.deleteCharacter(characterId);
    const before = await readFile(file, 'utf8');
    const response = await app.inject({ method: 'POST', url: `/api/chapters/${chapterId}/generated-content`,
      payload: { content: '迟到候选', writeBrief: brief } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('rejects a different target or malformed brief and keeps genuine manual saves available', async () => {
    const brief = await generate();
    const otherProject = await store.createProject('另一项目');
    const other = await store.createChapter(otherProject.id, '另一章');
    const before = await readFile(file, 'utf8');
    const wrongTarget = await app.inject({ method: 'POST', url: `/api/chapters/${other.id}/generated-content`,
      payload: { content: '不应写入', writeBrief: brief } });
    expect(wrongTarget.statusCode).toBe(400);
    const forged = await app.inject({ method: 'POST', url: `/api/chapters/${chapterId}/generated-content`,
      payload: { content: '不应写入', writeBrief: { ...brief, forbidden: [{ text: '伪造要求', sourceKeys: ['missing'] }] } } });
    expect(forged.statusCode).toBe(400);
    expect(await readFile(file, 'utf8')).toBe(before);
    const manual = await app.inject({ method: 'PATCH', url: `/api/chapters/${chapterId}/content`,
      payload: { content: '作者手写', expectedRevision: brief.target.revision } });
    expect(manual.statusCode).toBe(200);
    expect(manual.json().generatedCandidate).toBeUndefined();
    const preview = await app.inject({ method: 'GET', url: `/api/chapters/${chapterId}/write-brief` });
    expect(preview.json()).toMatchObject({ status: 'current', origin: 'preview' });
  });
});
