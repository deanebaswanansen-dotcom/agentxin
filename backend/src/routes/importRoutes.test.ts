import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../index.js';
import { FileDataStore } from '../store/FileDataStore.js';

describe('import routes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'novel-import-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('organizes dropped Markdown into project bible entries and chapters', async () => {
    const store = await FileDataStore.create(join(dir, 'store.json'));
    const project = await store.createProject('导入项目');
    const app = buildServer(store);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/import/novel`,
      payload: {
        sourceName: '裂缝夜班',
        files: [
          {
            path: '裂缝夜班.md',
            content: [
              '# 世界观',
              '灵潮复苏后，城市地下出现裂缝。',
              '',
              '# 人物',
              '- 林辰：夜班程序员，能看见裂缝日志。',
              '- 白先生：守序者导师，负责监控裂缝。',
              '',
              '## 第一章 夜班日志',
              '<think>先分析冲突</think>',
              '林辰在便利店夜班发现服务器日志发光。',
              '',
              '## 第二章 天台来信',
              '白先生在天台交给林辰第一份任务。',
            ].join('\n'),
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { chaptersCreated: number; charactersCreated: number; firstChapterId?: string };
    expect(body.chaptersCreated).toBe(2);
    expect(body.charactersCreated).toBe(2);
    expect(body.firstChapterId).toBeTruthy();

    const worlds = await store.listWorldSettings(project.id);
    const characters = await store.listCharacters(project.id);
    const outlines = await store.listOutlines(project.id);
    const chapters = await store.listChapters(project.id);

    expect(worlds[0]?.content).toContain('灵潮复苏');
    expect(characters.map((item) => item.name)).toEqual(['林辰', '白先生']);
    expect(outlines[0]?.content).toContain('第一章 夜班日志');
    expect(chapters.map((item) => item.title)).toEqual(['第一章 夜班日志', '第二章 天台来信']);
    expect(chapters[0]?.content).not.toContain('<think>');
    expect(chapters[0]?.content).toContain('林辰在便利店夜班');

    await app.close();
  });
});
