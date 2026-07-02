import { beforeEach, describe, expect, it } from 'vitest';
import { buildReaderBook } from './readerImport.js';
import {
  loadReaderProgress,
  loadReaderBookmarks,
  loadReaderOutputTarget,
  loadReaderRecent,
  loadReaderSession,
  loadReaderSettings,
  loadReaderShelf,
  saveReaderOutputTarget,
  saveReaderProgress,
  saveReaderRecent,
  saveReaderSession,
  saveReaderSettings,
  saveReaderShelfItem,
  toggleReaderBookmark,
  updateReaderShelfBook,
} from './readerShelf.js';

describe('readerShelf', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('persists imported books and reading progress', () => {
    const book = buildReaderBook('测试书', 'txt', '第1章\n\n正文');
    saveReaderShelfItem(book);
    saveReaderProgress(book.id, 2);

    expect(loadReaderShelf()).toHaveLength(1);
    expect(loadReaderShelf()[0]?.book.title).toBe('测试书');
    expect(loadReaderProgress(book.id)?.chapterIndex).toBe(2);
  });

  it('updates the stored book content', () => {
    const book = buildReaderBook('测试书', 'txt', '正文');
    saveReaderShelfItem(book);
    updateReaderShelfBook(book.id, (current) => ({
      ...current,
      chapters: [{ ...current.chapters[0]!, content: '新正文' }],
    }));

    expect(loadReaderShelf()[0]?.book.chapters[0]?.content).toBe('新正文');
  });

  it('persists origin metadata and output target', () => {
    const book = buildReaderBook('扫描书', 'txt', '正文');
    saveReaderShelfItem(book, window.localStorage, {
      origin: { kind: 'directory', path: 'books/扫描书.txt', directoryName: 'books' },
      tags: ['文件夹扫描'],
    });
    saveReaderOutputTarget('exports');

    expect(loadReaderShelf()[0]?.origin?.path).toBe('books/扫描书.txt');
    expect(loadReaderOutputTarget()?.name).toBe('exports');
  });

  it('persists session, recent items, bookmarks, and settings', () => {
    const book = buildReaderBook('测试书', 'txt', '第1章\n\n正文');
    saveReaderSession(book.id, 1);
    saveReaderRecent({ bookId: book.id, title: book.title, detail: '第 2 章' });
    toggleReaderBookmark({
      bookId: book.id,
      chapterId: book.chapters[0]!.id,
      chapterIndex: 0,
      chapterTitle: book.chapters[0]!.title,
      excerpt: '正文',
    });
    saveReaderSettings({ theme: 'dark', fontSize: 24, lineHeight: 2, readerWidth: 960, comicWidth: 92 });

    expect(loadReaderSession()?.bookId).toBe(book.id);
    expect(loadReaderRecent()[0]?.detail).toBe('第 2 章');
    expect(loadReaderBookmarks(book.id)[0]?.excerpt).toBe('正文');
    expect(loadReaderSettings()).toMatchObject({ theme: 'dark', fontSize: 24, lineHeight: 2, readerWidth: 960, comicWidth: 92 });
  });
});
