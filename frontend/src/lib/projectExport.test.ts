import { describe, expect, it } from 'vitest';

import {
  buildProjectDocxBlob,
  buildProjectTextExport,
  downloadBlobFile,
  sanitizeDownloadName,
} from './projectExport.js';

const chapters = [
  { title: '第二章', content: '后续正文', position: 2 },
  { title: '第一章', content: '开篇正文', position: 1 },
];

const resources = {
  characters: [{ name: '林夜', description: '基础服装：黑色校服。' }],
  worldSettings: [{ title: '灵力规则', content: '灵力不可凭空产生。' }],
  outlines: [{ title: '分章人物服装表', content: '第一章：黑色校服', position: 1 }],
};

function readBlobAsText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('读取 Blob 失败'));
    reader.onload = () => {
      resolve(new TextDecoder().decode(reader.result as ArrayBuffer));
    };
    reader.readAsArrayBuffer(blob);
  });
}

describe('project export helpers', () => {
  it('builds ordered Markdown and TXT exports', () => {
    const markdown = buildProjectTextExport('书名', chapters, 'markdown', resources);
    const txt = buildProjectTextExport('书名', chapters, 'txt', resources);
    expect(markdown).toContain('## 第 1 章 第一章');
    expect(markdown).toContain('## 第 2 章 第二章');
    expect(markdown).toContain('#### 分章人物服装表');
    expect(markdown).toContain('基础服装：黑色校服');
    expect(txt).toContain('第 1 章 第一章');
    expect(txt).toContain('大纲：分章人物服装表');
  });

  it('sanitizes Windows-hostile download names', () => {
    expect(sanitizeDownloadName('  a:b/c*d?e"f<g>h|  ')).toBe('a_b_c_d_e_f_g_h_');
    expect(sanitizeDownloadName('   ')).toBe('novel');
    expect(sanitizeDownloadName('CON.txt')).toBe('_CON.txt');
    expect(sanitizeDownloadName('剧本.md. ')).toBe('剧本.md');
  });

  it('keeps the object URL alive while the browser acquires a download', () => {
    vi.useFakeTimers();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const createObjectURL = vi.fn(() => 'blob:script-export');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    downloadBlobFile(new Blob(['正文']), '夜班:真相.md', 5_000);

    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelector('a')?.download).toBe('夜班_真相.md');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(document.querySelector('a')).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:script-export');

    vi.useRealTimers();
  });

  it('builds a valid DOCX package with document XML', async () => {
    const blob = buildProjectDocxBlob('书名', chapters, resources);
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    const text = await readBlobAsText(blob);
    expect(text.startsWith('PK')).toBe(true);
    expect(text).toContain('[Content_Types].xml');
    expect(text).toContain('word/document.xml');
    expect(text).toContain('第 1 章 第一章');
    expect(text).toContain('开篇正文');
    expect(text).toContain('分章人物服装表');
    expect(text).toContain('基础服装：黑色校服');
  });
});
