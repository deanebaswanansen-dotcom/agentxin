import { describe, expect, it } from 'vitest';

import {
  buildProjectDocxBlob,
  buildProjectTextExport,
  sanitizeDownloadName,
} from './projectExport.js';

const chapters = [
  { title: '第二章', content: '后续正文', position: 2 },
  { title: '第一章', content: '开篇正文', position: 1 },
];

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
    expect(buildProjectTextExport('书名', chapters, 'markdown')).toContain('## 第 1 章 第一章');
    expect(buildProjectTextExport('书名', chapters, 'markdown')).toContain('## 第 2 章 第二章');
    expect(buildProjectTextExport('书名', chapters, 'txt')).toContain('第 1 章 第一章');
  });

  it('sanitizes Windows-hostile download names', () => {
    expect(sanitizeDownloadName('  a:b/c*d?e"f<g>h|  ')).toBe('a_b_c_d_e_f_g_h_');
    expect(sanitizeDownloadName('   ')).toBe('novel');
  });

  it('builds a valid DOCX package with document XML', async () => {
    const blob = buildProjectDocxBlob('书名', chapters);
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    const text = await readBlobAsText(blob);
    expect(text.startsWith('PK')).toBe(true);
    expect(text).toContain('[Content_Types].xml');
    expect(text).toContain('word/document.xml');
    expect(text).toContain('第 1 章 第一章');
    expect(text).toContain('开篇正文');
  });
});
