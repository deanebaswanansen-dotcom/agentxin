import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  parseReaderFile,
  parseReaderFolder,
  readerBookToReferenceText,
  replaceFirstSelection,
  splitReaderChapters,
} from './readerImport.js';

describe('readerImport', () => {
  it('splits plain text novels into chapters', () => {
    const chapters = splitReaderChapters('第1章 初见\n\n甲。\n\n第2章 转折\n\n乙。');
    expect(chapters).toHaveLength(2);
    expect(chapters[0]?.title).toBe('第1章 初见');
    expect(chapters[1]?.content).toBe('乙。');
  });

  it('parses HTML as sanitized reader text', async () => {
    const file = new File([
      '<h1>第1章 标题</h1><p>正文 &amp; 线索</p><script>window.bad=1</script>',
    ], 'demo.html', { type: 'text/html' });
    const book = await parseReaderFile(file);
    expect(book.title).toBe('第1章 标题');
    expect(book.chapters[0]?.title).toBe('第1章 标题');
    expect(book.chapters[0]?.content).toContain('正文 & 线索');
    expect(book.chapters[0]?.content).not.toContain('window.bad');
  });

  it('decodes GB18030 text files', async () => {
    const gb18030 = new Uint8Array([
      0xB5, 0xDA, 0x31, 0xD5, 0xC2, 0x0A, 0x0A, 0xB2, 0xE2, 0xCA, 0xD4,
    ]);
    const file = new File([gb18030], 'gbk.txt', { type: 'text/plain' });

    const book = await parseReaderFile(file);

    expect(book.chapters[0]?.title).toBe('第1章');
    expect(book.chapters[0]?.content).toBe('测试');
  });

  it('parses EPUB files into text chapters', async () => {
    const zip = new JSZip();
    zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
    zip.file('OEBPS/content.opf', [
      '<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>EPUB 测试</dc:title></metadata><manifest>',
      '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>',
      '</manifest><spine><itemref idref="c1"/></spine></package>',
    ].join(''));
    zip.file(
      'OEBPS/ch1.xhtml',
      '<html><body><h1>第1章 EPUB</h1><p>EPUB 正文用于参考分析，这里写得稍长一点以满足最短字数要求，方便联调。</p><p>第二段继续补充情节线索与环境描写，确保导出文本足够长。</p></body></html>',
    );
    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });

    const book = await parseReaderFile(new File([blob], 'demo.epub', { type: 'application/epub+zip' }));

    expect(book.format).toBe('epub');
    expect(book.title).toBe('EPUB 测试');
    expect(book.chapters[0]?.title).toBe('第1章 EPUB');
    expect(book.chapters[0]?.content).toContain('EPUB 正文');

    const refText = readerBookToReferenceText(book);
    expect(refText).toContain('第1章 EPUB');
    expect(refText).toContain('EPUB 正文');
  });

  it('parses CBZ files into ordered comic pages', async () => {
    const zip = new JSZip();
    zip.file('002.png', new Uint8Array([2, 2, 2]));
    zip.file('001.png', new Uint8Array([1, 1, 1]));
    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.comicbook+zip' });

    const book = await parseReaderFile(new File([blob], 'comic.cbz', { type: 'application/vnd.comicbook+zip' }));

    expect(book.mediaType).toBe('comic');
    expect(book.pages?.map((page) => page.name)).toEqual(['001.png', '002.png']);
  });

  it('combines markdown folders into one ordered book', async () => {
    const first = new File(['# 第一章\n\n甲'], '01.md', { type: 'text/markdown' });
    const second = new File(['# 第二章\n\n乙'], '02.md', { type: 'text/markdown' });
    Object.defineProperty(first, 'webkitRelativePath', { configurable: true, value: '文集/01.md' });
    Object.defineProperty(second, 'webkitRelativePath', { configurable: true, value: '文集/02.md' });

    const books = await parseReaderFolder([second, first], { displayName: '文集' });

    expect(books).toHaveLength(1);
    expect(books[0]?.format).toBe('md-folder');
    expect(books[0]?.chapters.map((chapter) => chapter.title)).toEqual(['01 · 第一章', '02 · 第二章']);
  });

  it('replaces the first exact selected segment', () => {
    expect(replaceFirstSelection('甲乙甲乙', '甲乙', '丙')).toBe('丙甲乙');
    expect(replaceFirstSelection('甲乙', '丁', '丙')).toBeNull();
  });
});
