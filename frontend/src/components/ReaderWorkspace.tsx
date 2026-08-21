import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import apiClient from '../api/apiClient.js';
import { downloadBlobFile } from '../lib/projectExport.js';
import {
  buildReaderBook,
  countReaderWords,
  createStableReaderId,
  filePathOf,
  isAllowedReaderRasterDataUrl,
  isImageFile,
  isSupportedReaderFileName,
  parseReaderFile,
  parseReaderFolder,
  readerBookToReferenceText,
  replaceFirstSelection,
  type ReaderBook,
  type ReaderChapter,
} from '../lib/readerImport.js';
import {
  defaultReaderSettings,
  loadReaderBookmarks,
  loadReaderOutputTarget,
  loadReaderProgress,
  loadReaderRecent,
  loadReaderSession,
  loadReaderSettings,
  loadReaderShelfStore,
  removeReaderBookmark,
  removeReaderShelfItemStore,
  saveReaderOutputTarget,
  saveReaderProgress,
  saveReaderRecent,
  saveReaderSession,
  saveReaderSettings,
  saveReaderShelfItemStore,
  toggleReaderBookmark,
  touchReaderShelfItemStore,
  updateReaderShelfBookStore,
  type ReaderBookmark,
  type ReaderRecentItem,
  type ReaderSettings,
  type ReaderShelfItem,
} from '../lib/readerShelf.js';
import type { Chapter, Id } from '../types/index.js';
import { Icon } from './Icon.js';
import './components.css';

export type ReaderClient = Pick<typeof apiClient, 'chapters' | 'projects' | 'settings' | 'freeChat'>;

export interface ReaderWorkspaceProps {
  projectId: Id | null;
  projectName?: string;
  refreshToken?: number;
  onOpenAgentMode: () => void;
  onError?: (error: unknown) => void;
  onProjectCreated?: (projectId: Id) => void;
  onChapterUpdated?: (chapterId: Id, content: string, revision?: number) => void;
  /**
   * 将文本书送去 Agent 对话做「参考小说分析」：
   * 父组件应切到 agent 模式并把 text 交给 ChatWorkspace 导入。
   */
  onSendToReferenceAnalysis?: (payload: {
    title: string;
    text: string;
    sourceLabel?: string;
  }) => void;
  client?: ReaderClient;
}

type ViewMode = 'home' | 'reader';
type WorkMode = 'read' | 'agent';
type ReaderPanel = 'toc' | 'bookmarks' | 'settings' | null;
type ExtractKind = 'world' | 'outline' | 'character';
type ShelfFilter = 'all' | 'project' | 'text' | 'visual' | 'directory' | 'linked' | 'recent';

interface ActiveSource {
  kind: 'project' | 'shelf';
  id: Id;
}

interface DirectoryEntryHandle {
  kind: 'file' | 'directory';
  name: string;
  getFile?: () => Promise<File>;
  values?: () => AsyncIterable<DirectoryEntryHandle>;
}

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: () => Promise<DirectoryEntryHandle>;
}

interface WritableFileHandle {
  createWritable: () => Promise<{
    write: (data: Blob | string) => Promise<void>;
    close: () => Promise<void>;
  }>;
}

interface OutputDirectoryHandle extends DirectoryEntryHandle {
  getFileHandle?: (name: string, options?: { create?: boolean }) => Promise<WritableFileHandle>;
}

const MAX_DIRECTORY_IMPORT_FILES = 120;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function buildProjectBook(projectId: Id, projectName: string | undefined, chapters: Chapter[]): ReaderBook {
  const sorted = [...chapters].sort((a, b) => a.position - b.position);
  const book = buildReaderBook(
    projectName ?? '当前项目',
    'agent-project',
    sorted.map((chapter) => `${chapter.title}\n\n${chapter.content}`).join('\n\n'),
    'project',
    `project-${projectId}`,
  );
  return {
    ...book,
    linkedProjectId: projectId,
    chapters: sorted.map((chapter, index) => ({
      id: `project-chapter-${chapter.id}`,
      backendChapterId: chapter.id,
      backendRevision: chapter.revision ?? 0,
      title: chapter.title,
      content: chapter.content,
      position: index,
    })),
  };
}

function currentChapterOf(book: ReaderBook | null, index: number): ReaderChapter | null {
  if (!book || book.mediaType !== 'text' || book.chapters.length === 0) return null;
  return book.chapters[Math.min(Math.max(0, index), book.chapters.length - 1)] ?? null;
}

function replaceChapter(
  book: ReaderBook,
  chapterId: string,
  content: string,
  backendRevision?: number,
): ReaderBook {
  return {
    ...book,
    updatedAt: new Date().toISOString(),
    chapters: book.chapters.map((chapter) => (
      chapter.id === chapterId
        ? { ...chapter, content, backendRevision: backendRevision ?? chapter.backendRevision }
        : chapter
    )),
  };
}

function buildExtractionContent(kind: ExtractKind, book: ReaderBook, chapter: ReaderChapter, selectedText: string): string {
  const source = selectedText.trim() || chapter.content.slice(0, 2400);
  const label = kind === 'world' ? '世界观' : kind === 'outline' ? '大纲' : '人物线索';
  return [
    `# 阅读提取：${book.title}${label}`,
    '',
    `来源：${chapter.title}`,
    '',
    '## 原文线索',
    source,
    '',
    '## 待整理',
    kind === 'world'
      ? '- 核心规则\n- 地点与势力\n- 技术或修炼体系'
      : kind === 'outline'
        ? '- 本章目标\n- 冲突推进\n- 后续伏笔'
        : '- 身份\n- 动机\n- 关系\n- 口吻',
  ].join('\n');
}

function inferCharacterNames(text: string): string[] {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(/([一-龥]{2,4})(?:说|问|道|喊|想|看|笑|沉默|转身|点头)/g)) {
    const name = match[1];
    if (/^(他们|我们|你们|这个|那个|自己|所有|学院|系统|灵脉)$/.test(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function directoryNameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 1 ? parts[0]! : '手动导入';
}

function bookSectionCount(book: ReaderBook): number {
  if (book.mediaType === 'text') return book.chapters.length;
  if (book.mediaType === 'comic') return book.pages?.length ?? 0;
  return 1;
}

function bookDetail(book: ReaderBook): string {
  if (book.mediaType === 'text') return `${book.format.toUpperCase()} · ${book.chapters.length} 章`;
  if (book.mediaType === 'comic') return `${book.format.toUpperCase()} · ${book.pages?.length ?? 0} 页`;
  return 'PDF 原版查看';
}

function recentDetail(book: ReaderBook, chapterIndex: number): string {
  if (book.mediaType === 'text') return `第 ${chapterIndex + 1} 章`;
  if (book.mediaType === 'comic') return `${book.pages?.length ?? 0} 页漫画`;
  return 'PDF';
}

function buildBookExportText(book: ReaderBook): string {
  if (book.mediaType !== 'text') return bookDetail(book);
  return book.chapters
    .map((chapter) => `${chapter.title}\n\n${chapter.content}`.trim())
    .join('\n\n');
}

function buildBookExportHtml(book: ReaderBook): string {
  const title = escapeHtml(book.title);
  const body = book.mediaType === 'comic'
    ? (book.pages ?? []).map((page) => `<img src="${escapeAttr(page.src)}" alt="${escapeAttr(page.name)}">`).join('\n')
    : book.mediaType === 'pdf'
      ? `<iframe src="${escapeAttr(book.pdfDataUrl ?? '')}" title="${title}"></iframe>`
      : book.chapters.map((chapter) => [
        `<section><h2>${escapeHtml(chapter.title)}</h2>`,
        ...chapter.content.split(/\n{2,}/u).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
        '</section>',
      ].join('\n')).join('\n');
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    `<title>${title}</title>`,
    '<style>body{margin:0;background:#f4efe3;color:#2b241b;font:20px/1.9 "Microsoft YaHei",sans-serif}main{max-width:920px;margin:0 auto;padding:48px 24px}p{text-indent:2em}img{display:block;max-width:100%;margin:0 auto 18px}iframe{width:100%;height:92vh;border:0}</style>',
    '</head><body><main>',
    body,
    '</main></body></html>',
  ].join('');
}

function safeExportFileName(title: string, extension: 'txt' | 'html'): string {
  return `${title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'reader-book'}.${extension}`;
}

async function collectDirectoryFiles(
  directory: DirectoryEntryHandle,
  parentPath = directory.name,
  result: File[] = [],
): Promise<File[]> {
  if (!directory.values) return result;
  for await (const entry of directory.values()) {
    if (result.length >= MAX_DIRECTORY_IMPORT_FILES) return result;
    const entryPath = `${parentPath}/${entry.name}`;
    if (entry.kind === 'directory') {
      await collectDirectoryFiles(entry, entryPath, result);
    } else if (entry.kind === 'file' && entry.getFile && isSupportedReaderFileName(entry.name)) {
      const file = await entry.getFile();
      Object.defineProperty(file, 'webkitRelativePath', {
        configurable: true,
        value: entryPath,
      });
      result.push(file);
    }
  }
  return result;
}

function clampChapterIndex(book: ReaderBook, index: number): number {
  if (book.mediaType !== 'text') return 0;
  return Math.min(Math.max(0, index), Math.max(0, book.chapters.length - 1));
}

export function sanitizeReaderInlineHtml(value: string): string {
  if (typeof DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(`<div>${value}</div>`, 'text/html');
  const root = doc.body?.firstElementChild;
  if (!root) return '';
  root.querySelectorAll('script,style,iframe,object,embed').forEach((node) => node.remove());
  root.querySelectorAll('*').forEach((element) => {
    const tag = element.tagName.toLowerCase();
    if (!['figure', 'img', 'h3'].includes(tag)) {
      element.replaceWith(doc.createTextNode(element.textContent ?? ''));
      return;
    }
    if (tag === 'img' && !isAllowedReaderRasterDataUrl(element.getAttribute('src') ?? '')) {
      element.remove();
      return;
    }
    Array.from(element.attributes).forEach((attr) => {
      if (tag === 'img' && attr.name === 'src') return;
      if (tag === 'img' && attr.name === 'alt') return;
      if (attr.name === 'class' && /^(nwa-reader-inline-image|nwa-reader-subheading)$/u.test(attr.value)) return;
      element.removeAttribute(attr.name);
    });
  });
  return root.innerHTML;
}

function escapeHtml(text: string): string {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replaceAll('"', '&quot;');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function ReaderWorkspace({
  projectId,
  projectName,
  refreshToken,
  onOpenAgentMode,
  onError,
  onProjectCreated,
  onChapterUpdated,
  onSendToReferenceAnalysis,
  client = apiClient,
}: ReaderWorkspaceProps): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const readerSurfaceRef = useRef<HTMLDivElement | null>(null);
  const [shelf, setShelf] = useState<ReaderShelfItem[]>([]);
  const [recent, setRecent] = useState<ReaderRecentItem[]>(() => loadReaderRecent());
  const [projectBook, setProjectBook] = useState<ReaderBook | null>(null);
  const [loadingProject, setLoadingProject] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('home');
  const [workMode, setWorkMode] = useState<WorkMode>('read');
  const [readerPanel, setReaderPanel] = useState<ReaderPanel>(null);
  const [shelfFilter, setShelfFilter] = useState<ShelfFilter>('all');
  const [search, setSearch] = useState('');
  const [readerSearch, setReaderSearch] = useState('');
  const [highlightTerm, setHighlightTerm] = useState('');
  const [activeBook, setActiveBook] = useState<ReaderBook | null>(null);
  const [activeSource, setActiveSource] = useState<ActiveSource | null>(null);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [selectedText, setSelectedText] = useState('');
  const [rewriteInstruction, setRewriteInstruction] = useState('保留原意，提升节奏和画面感。');
  const [rewriteCandidate, setRewriteCandidate] = useState('');
  const [agentBusy, setAgentBusy] = useState(false);
  const [outputDirectoryHandle, setOutputDirectoryHandle] = useState<OutputDirectoryHandle | null>(null);
  const [outputTarget, setOutputTarget] = useState(() => loadReaderOutputTarget());
  const [readerSettings, setReaderSettings] = useState<ReaderSettings>(() => loadReaderSettings());
  const [bookmarkVersion, setBookmarkVersion] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '');
    folderInputRef.current?.setAttribute('directory', '');
  }, []);

  useEffect(() => {
    document.body.classList.toggle('nwa-reader-immersive-root', immersive);
    return () => document.body.classList.remove('nwa-reader-immersive-root');
  }, [immersive]);

  useEffect(() => {
    if (projectId === null) {
      setProjectBook(null);
      return undefined;
    }

    const controller = new AbortController();
    setLoadingProject(true);
    client.chapters
      .list(projectId, controller.signal)
      .then((items) => {
        setProjectBook(buildProjectBook(projectId, projectName, items));
      })
      .catch((error) => {
        if (!isAbort(error)) onError?.(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingProject(false);
      });
    return () => controller.abort();
  }, [client, onError, projectId, projectName, refreshToken]);

  const activeChapter = currentChapterOf(activeBook, chapterIndex);
  const bookmarks = useMemo<ReaderBookmark[]>(
    () => (activeBook ? loadReaderBookmarks(activeBook.id) : []),
    [activeBook, bookmarkVersion],
  );
  const totalWords = useMemo(
    () => activeBook?.chapters.reduce((sum, chapter) => sum + countReaderWords(chapter.content), 0) ?? 0,
    [activeBook],
  );
  const directoryCount = useMemo(
    () => shelf.filter((item) => item.origin?.kind === 'directory').length,
    [shelf],
  );
  const textCount = useMemo(
    () => shelf.filter((item) => item.book.mediaType === 'text').length + (projectBook ? 1 : 0),
    [projectBook, shelf],
  );
  const visualCount = useMemo(
    () => shelf.filter((item) => item.book.mediaType !== 'text').length,
    [shelf],
  );
  const sectionCount = useMemo(
    () => shelf.reduce((sum, item) => sum + bookSectionCount(item.book), projectBook ? bookSectionCount(projectBook) : 0),
    [projectBook, shelf],
  );
  const linkedCount = useMemo(
    () => shelf.filter((item) => item.linkedProjectId || item.book.linkedProjectId).length + (projectBook ? 1 : 0),
    [projectBook, shelf],
  );

  const filteredShelf = useMemo(() => {
    const recentIds = new Set(recent.map((item) => item.bookId));
    const keyword = search.trim().toLowerCase();
    const matchesSearch = (item: ReaderShelfItem) => {
      if (!keyword) return true;
      return [
        item.book.title,
        item.book.format,
        item.book.mediaType,
        item.origin?.path,
        item.origin?.directoryName,
        ...(item.tags ?? []),
      ].filter(Boolean).some((value) => String(value).toLowerCase().includes(keyword));
    };
    const matchesFilter = (item: ReaderShelfItem) => {
      if (shelfFilter === 'all') return true;
      if (shelfFilter === 'project') return false;
      if (shelfFilter === 'text') return item.book.mediaType === 'text';
      if (shelfFilter === 'visual') return item.book.mediaType !== 'text';
      if (shelfFilter === 'directory') return item.origin?.kind === 'directory';
      if (shelfFilter === 'linked') return Boolean(item.linkedProjectId || item.book.linkedProjectId);
      if (shelfFilter === 'recent') return recentIds.has(item.book.id);
      return true;
    };
    return [...shelf]
      .sort((a, b) => Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt))
      .filter((item) => matchesFilter(item) && matchesSearch(item));
  }, [recent, search, shelf, shelfFilter]);
  const projectVisible = projectBook
    && ['all', 'project', 'text', 'linked', 'recent'].includes(shelfFilter)
    && (!search.trim() || projectBook.title.toLowerCase().includes(search.trim().toLowerCase()));

  const refreshReaderLists = useCallback(async () => {
    try {
      setShelf(await loadReaderShelfStore());
    } catch (error) {
      onError?.(error);
    }
    setRecent(loadReaderRecent());
  }, [onError]);

  useEffect(() => {
    void refreshReaderLists();
  }, [refreshReaderLists]);

  const recordPosition = useCallback((book: ReaderBook, index: number) => {
    const bounded = clampChapterIndex(book, index);
    saveReaderProgress(book.id, bounded);
    saveReaderSession(book.id, bounded);
    saveReaderRecent({
      bookId: book.id,
      title: book.title,
      detail: recentDetail(book, bounded),
    });
    setRecent(loadReaderRecent());
  }, []);

  const openBook = useCallback((book: ReaderBook, source: ActiveSource, initialIndex?: number) => {
    const progress = loadReaderProgress(book.id);
    const nextIndex = clampChapterIndex(book, initialIndex ?? progress?.chapterIndex ?? 0);
    setActiveBook(book);
    setActiveSource(source);
    setChapterIndex(nextIndex);
    setSelectedText('');
    setRewriteCandidate('');
    setReaderSearch('');
    setHighlightTerm('');
    setViewMode('reader');
    setWorkMode('read');
    setReaderPanel(null);
    setStatus('');
    recordPosition(book, nextIndex);
  }, [recordPosition]);

  const openShelfBook = useCallback(async (item: ReaderShelfItem, initialIndex?: number) => {
    const touched = await touchReaderShelfItemStore(item.id) ?? item;
    await refreshReaderLists();
    openBook(touched.book, { kind: 'shelf', id: touched.id }, initialIndex);
  }, [openBook, refreshReaderLists]);

  const openProjectBook = useCallback((initialIndex?: number) => {
    if (projectId === null || projectBook === null) return;
    openBook(projectBook, { kind: 'project', id: projectId }, initialIndex);
  }, [openBook, projectBook, projectId]);

  const openRecentItem = useCallback((item: ReaderRecentItem) => {
    const target = shelf.find((entry) => entry.book.id === item.bookId || entry.id === item.bookId);
    if (target) {
      void openShelfBook(target);
      return;
    }
    if (projectBook?.id === item.bookId) openProjectBook();
  }, [openProjectBook, openShelfBook, projectBook, shelf]);

  const continueReading = useCallback(() => {
    const session = loadReaderSession();
    if (!session) return;
    const target = shelf.find((item) => item.book.id === session.bookId || item.id === session.bookId);
    if (target) {
      void openShelfBook(target, session.chapterIndex);
      return;
    }
    if (projectBook?.id === session.bookId) openProjectBook(session.chapterIndex);
  }, [openProjectBook, openShelfBook, projectBook, shelf]);

  const goToChapter = useCallback((nextIndex: number) => {
    if (!activeBook || activeBook.mediaType !== 'text') return;
    const bounded = clampChapterIndex(activeBook, nextIndex);
    setChapterIndex(bounded);
    recordPosition(activeBook, bounded);
    setSelectedText('');
    setRewriteCandidate('');
    setHighlightTerm('');
    readerSurfaceRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [activeBook, recordPosition]);

  const updateActiveBook = useCallback(async (nextBook: ReaderBook) => {
    setActiveBook(nextBook);
    if (activeSource?.kind === 'project') {
      setProjectBook(nextBook);
      return;
    }
    if (activeSource?.kind === 'shelf') {
      await updateReaderShelfBookStore(activeSource.id, () => nextBook);
      await refreshReaderLists();
    }
  }, [activeSource, refreshReaderLists]);

  const importFiles = useCallback(async (files: File[], sourceKind: 'file' | 'directory') => {
    const supported = files.filter((file) => isSupportedReaderFileName(file.name)).slice(0, MAX_DIRECTORY_IMPORT_FILES);
    if (supported.length === 0) {
      setStatus('没有找到可导入的阅读文件。');
      return;
    }
    setStatus(`正在导入 ${supported.length} 个文件...`);
    const directoryName = sourceKind === 'directory' ? directoryNameOf(filePathOf(supported[0]!)) : undefined;
    const imageOnly = supported.every((file) => isImageFile(file.name));
    const markdownOnly = supported.every((file) => ['md', 'markdown'].includes(file.name.split('.').pop()?.toLowerCase() ?? ''));
    const shouldCombineFolder = sourceKind === 'directory' && supported.length > 1 && (imageOnly || markdownOnly);
    const books = shouldCombineFolder
      ? await parseReaderFolder(supported, {
        id: createStableReaderId(supported.map(filePathOf).join('|')),
        displayName: directoryName,
      })
      : await Promise.all(supported.map((file) => parseReaderFile(file, {
        id: createStableReaderId(filePathOf(file)),
      })));

    let firstItem: ReaderShelfItem | null = null;
    for (let index = 0; index < books.length; index += 1) {
      const book = books[index]!;
      const sourceFile = supported[Math.min(index, supported.length - 1)]!;
      const item = await saveReaderShelfItemStore(book, window.localStorage, {
        origin: {
          kind: sourceKind,
          path: shouldCombineFolder ? `${directoryName ?? '导入文件夹'}/` : filePathOf(sourceFile),
          directoryName,
        },
        tags: [
          sourceKind === 'directory' ? '文件夹扫描' : '手动导入',
          book.mediaType === 'text' ? '小说' : '漫画/PDF',
        ],
      });
      firstItem ??= item;
    }
    await refreshReaderLists();
    if (firstItem) openBook(firstItem.book, { kind: 'shelf', id: firstItem.id });
    setStatus(`已导入 ${books.length} 本内容。`);
  }, [openBook, refreshReaderLists]);

  const handleImportFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    try {
      await importFiles(files, 'file');
    } catch (error) {
      onError?.(error);
      setStatus('');
    }
  }, [importFiles, onError]);

  const handleImportFolder = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    try {
      await importFiles(files, 'directory');
    } catch (error) {
      onError?.(error);
      setStatus('');
    }
  }, [importFiles, onError]);

  const handlePickScanDirectory = useCallback(async () => {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) {
      folderInputRef.current?.click();
      return;
    }
    try {
      const directory = await picker();
      const files = await collectDirectoryFiles(directory);
      await importFiles(files, 'directory');
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) onError?.(error);
    }
  }, [importFiles, onError]);

  const handlePickOutputDirectory = useCallback(async () => {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) {
      setStatus('当前浏览器不支持直接选择输出目录，会使用下载方式导出。');
      return;
    }
    try {
      const directory = await picker() as OutputDirectoryHandle;
      setOutputDirectoryHandle(directory);
      setOutputTarget(saveReaderOutputTarget(directory.name));
      setStatus(`输出目录已设为：${directory.name}`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) onError?.(error);
    }
  }, [onError]);

  const handleDeleteShelfItem = useCallback(async (id: string) => {
    await removeReaderShelfItemStore(id);
    await refreshReaderLists();
    if (activeSource?.kind === 'shelf' && activeSource.id === id) {
      setViewMode('home');
      setActiveBook(null);
      setActiveSource(null);
    }
  }, [activeSource, refreshReaderLists]);

  const captureSelection = useCallback(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? '';
    const surface = readerSurfaceRef.current;
    if (!text || !surface || !selection?.anchorNode || !surface.contains(selection.anchorNode)) {
      setSelectedText('');
      return;
    }
    setSelectedText(text.slice(0, 4000));
  }, []);

  const ensureAgentProject = useCallback(async (): Promise<Id> => {
    if (activeSource?.kind === 'project') return activeSource.id;
    if (!activeBook) throw new Error('请先打开一本书。');
    const linked = activeBook.linkedProjectId || shelf.find((item) => item.id === activeSource?.id)?.linkedProjectId;
    if (linked) return linked;

    const created = await client.projects.create(`阅读导入：${activeBook.title}`);
    const nextBook = { ...activeBook, linkedProjectId: created.id };
    if (activeSource?.kind === 'shelf') {
      await updateReaderShelfBookStore(activeSource.id, () => nextBook);
      await refreshReaderLists();
    }
    setActiveBook(nextBook);
    onProjectCreated?.(created.id);
    return created.id;
  }, [activeBook, activeSource, client, onProjectCreated, refreshReaderLists, shelf]);

  const handleRewrite = useCallback(async () => {
    if (!activeBook || !activeChapter || activeBook.mediaType !== 'text') return;
    if (selectedText.trim().length === 0) {
      setStatus('请先在正文中选择一段文字。');
      return;
    }

    setAgentBusy(true);
    setRewriteCandidate('');
    setStatus('Agent 正在重写选段...');
    try {
      const agentProjectId = await ensureAgentProject();
      let full = '';
      const message = [
        '请重写下面这段小说文本。',
        `要求：${rewriteInstruction.trim() || '保留原意，提升可读性。'}`,
        '只输出重写后的正文，不要解释。',
        '',
        selectedText,
      ].join('\n');
      await client.freeChat.stream(
        agentProjectId,
        {
          message,
          context: 'writing',
          chapterId: activeSource?.kind === 'project' ? activeChapter.backendChapterId : undefined,
          sessionHistory: [],
        },
        {
          onDelta: (delta) => {
            full += delta;
            setRewriteCandidate(full);
          },
        },
      );
      setStatus('重写候选已生成。');
    } catch (error) {
      onError?.(error);
      setStatus('');
    } finally {
      setAgentBusy(false);
    }
  }, [
    activeBook,
    activeChapter,
    activeSource,
    client,
    ensureAgentProject,
    onError,
    rewriteInstruction,
    selectedText,
  ]);

  const handleApplyRewrite = useCallback(async () => {
    if (!activeBook || !activeChapter || rewriteCandidate.trim().length === 0) return;
    const nextContent = replaceFirstSelection(activeChapter.content, selectedText, rewriteCandidate);
    if (nextContent === null) {
      setStatus('没有在当前章节找到这段原文，未写回。');
      return;
    }

    try {
      if (activeSource?.kind === 'project' && activeChapter.backendChapterId) {
        const saved = await client.chapters.updateContent(
          activeChapter.backendChapterId,
          nextContent,
          activeChapter.backendRevision ?? 0,
        );
        onChapterUpdated?.(activeChapter.backendChapterId, nextContent, saved.revision);
        const nextBook = replaceChapter(activeBook, activeChapter.id, nextContent, saved.revision);
        await updateActiveBook(nextBook);
      } else {
        const nextBook = replaceChapter(activeBook, activeChapter.id, nextContent);
        await updateActiveBook(nextBook);
      }
      setSelectedText('');
      setRewriteCandidate('');
      setStatus('已应用到当前书。');
    } catch (error) {
      onError?.(error);
    }
  }, [activeBook, activeChapter, activeSource, client, onChapterUpdated, onError, rewriteCandidate, selectedText, updateActiveBook]);

  const handleSendBookToReference = useCallback(
    (book: ReaderBook | null, sourceLabel?: string) => {
      if (!book) {
        onError?.(new Error('请先选择一本文本书。'));
        return;
      }
      if (!onSendToReferenceAnalysis) {
        onError?.(new Error('当前版本未接入参考分析通道。'));
        return;
      }
      try {
        const text = readerBookToReferenceText(book);
        onSendToReferenceAnalysis({
          title: book.title,
          text,
          sourceLabel: sourceLabel ?? `书架 · ${book.format.toUpperCase()}`,
        });
        setStatus(`已将《${book.title}》送去参考分析，请在对话栏勾选章节。`);
        onOpenAgentMode();
      } catch (error) {
        onError?.(error);
      }
    },
    [onError, onOpenAgentMode, onSendToReferenceAnalysis],
  );

  const handleExtract = useCallback(async (kind: ExtractKind) => {
    if (!activeBook || !activeChapter || activeBook.mediaType !== 'text') return;
    setAgentBusy(true);
    try {
      const agentProjectId = await ensureAgentProject();
      const content = buildExtractionContent(kind, activeBook, activeChapter, selectedText);
      if (kind === 'world') {
        await client.settings.worldSettings.create(agentProjectId, {
          title: `阅读提取：${activeBook.title}世界观`,
          content,
        });
      } else if (kind === 'outline') {
        await client.settings.outlines.create(agentProjectId, {
          title: `阅读提取：${activeBook.title}大纲`,
          content,
        });
      } else {
        const names = inferCharacterNames(selectedText || activeChapter.content);
        const targets = names.length > 0 ? names : ['主要人物线索'];
        for (const name of targets) {
          await client.settings.characters.create(agentProjectId, {
            name,
            description: content,
          });
        }
      }
      setStatus('已写入 Agent 资料区。');
      onProjectCreated?.(agentProjectId);
    } catch (error) {
      onError?.(error);
    } finally {
      setAgentBusy(false);
    }
  }, [activeBook, activeChapter, client, ensureAgentProject, onError, onProjectCreated, selectedText]);

  const handleExportActiveBook = useCallback(async (format: 'txt' | 'html') => {
    if (!activeBook) {
      setStatus('请先打开一本书。');
      return;
    }
    const fileName = safeExportFileName(activeBook.title, format);
    const content = format === 'html' ? buildBookExportHtml(activeBook) : buildBookExportText(activeBook);
    const type = format === 'html' ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8';
    try {
      if (outputDirectoryHandle?.getFileHandle) {
        const fileHandle = await outputDirectoryHandle.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(new Blob([content], { type }));
        await writable.close();
        setStatus(`已生成到 ${outputDirectoryHandle.name}/${fileName}`);
        return;
      }
      downloadBlobFile(new Blob([content], { type }), fileName);
      setStatus('浏览器未授权输出目录，已改为下载。');
    } catch (error) {
      onError?.(error);
    }
  }, [activeBook, onError, outputDirectoryHandle]);

  const runReaderSearch = useCallback(() => {
    const keyword = readerSearch.trim();
    if (!keyword || !activeBook || activeBook.mediaType !== 'text') return;
    const foundIndex = activeBook.chapters.findIndex((chapter) => (
      chapter.title.includes(keyword) || chapter.content.includes(keyword)
    ));
    if (foundIndex < 0) {
      setStatus('当前小说里没有找到这个词。');
      return;
    }
    setHighlightTerm(keyword);
    goToChapter(foundIndex);
    window.setTimeout(() => setHighlightTerm(keyword), 0);
  }, [activeBook, goToChapter, readerSearch]);

  const toggleCurrentBookmark = useCallback(() => {
    if (!activeBook || !activeChapter || activeBook.mediaType !== 'text') return;
    toggleReaderBookmark({
      bookId: activeBook.id,
      chapterId: activeChapter.id,
      chapterIndex,
      chapterTitle: activeChapter.title,
      excerpt: activeChapter.content.replace(/\s+/g, ' ').slice(0, 46),
    });
    setBookmarkVersion((value) => value + 1);
  }, [activeBook, activeChapter, chapterIndex]);

  const removeBookmark = useCallback((bookmark: ReaderBookmark) => {
    removeReaderBookmark(bookmark.bookId, bookmark.chapterId);
    setBookmarkVersion((value) => value + 1);
  }, []);

  const updateSetting = useCallback((patch: Partial<ReaderSettings>) => {
    setReaderSettings((current) => {
      const next = saveReaderSettings({ ...current, ...patch });
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    setReaderSettings(saveReaderSettings({ ...defaultReaderSettings, theme: readerSettings.theme }));
  }, [readerSettings.theme]);

  const setImmersiveMode = useCallback((next: boolean) => {
    setImmersive(next);
    setReaderPanel(null);
    if (next && document.fullscreenEnabled && !document.fullscreenElement) {
      void document.documentElement.requestFullscreen().catch(() => undefined);
    }
    if (!next && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (viewMode !== 'reader') return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        if (event.key === 'Escape') setReaderPanel(null);
        return;
      }
      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        if (activeBook?.mediaType === 'text') {
          event.preventDefault();
          goToChapter(chapterIndex + 1);
        }
      }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        if (activeBook?.mediaType === 'text') {
          event.preventDefault();
          goToChapter(chapterIndex - 1);
        }
      }
      if (event.key === 'b' || event.key === 'B') {
        event.preventDefault();
        toggleCurrentBookmark();
      }
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        setImmersiveMode(!immersive);
      }
      if (event.key === 'Escape') {
        if (readerPanel) {
          setReaderPanel(null);
          return;
        }
        if (immersive) setImmersiveMode(false);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [activeBook, chapterIndex, goToChapter, immersive, readerPanel, setImmersiveMode, toggleCurrentBookmark, viewMode]);

  const handleDrop = useCallback(async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length === 0) return;
    try {
      await importFiles(files, files.length > 1 ? 'directory' : 'file');
    } catch (error) {
      onError?.(error);
    }
  }, [importFiles, onError]);

  const session = loadReaderSession();
  const sessionShelfItem = session ? shelf.find((item) => item.book.id === session.bookId || item.id === session.bookId) : null;
  const sessionProjectBook = session?.bookId === projectBook?.id ? projectBook : null;
  const continueTitle = sessionShelfItem?.book.title ?? sessionProjectBook?.title ?? '先导入一本书';
  const continueMeta = sessionShelfItem || sessionProjectBook
    ? recentDetail(sessionShelfItem?.book ?? sessionProjectBook!, session?.chapterIndex ?? 0)
    : '加入书架后，刷新还能继续读。';
  const isCurrentBookmarked = Boolean(activeChapter && bookmarks.some((item) => item.chapterId === activeChapter.id));

  const renderMarkedText = useCallback((text: string) => {
    if (!highlightTerm.trim()) return text;
    const parts = text.split(new RegExp(`(${escapeRegExp(highlightTerm)})`, 'giu'));
    return parts.map((part, index) => (
      part.toLowerCase() === highlightTerm.toLowerCase()
        ? <mark key={`${part}-${index}`}>{part}</mark>
        : part
    ));
  }, [highlightTerm]);

  const renderParagraph = useCallback((paragraph: string, index: number) => {
    const trimmed = paragraph.trim();
    if (/^<(figure|h3)\b/iu.test(trimmed)) {
      return <div key={`html-${index}`} dangerouslySetInnerHTML={{ __html: sanitizeReaderInlineHtml(trimmed) }} />;
    }
    const noIndent = /^[【\[(（]/u.test(trimmed) ? ' no-indent' : '';
    return <p key={`p-${index}`} className={noIndent.trim()}>{renderMarkedText(paragraph)}</p>;
  }, [renderMarkedText]);

  const readerStyle = {
    '--reader-font-size': `${readerSettings.fontSize}px`,
    '--reader-line-height': String(readerSettings.lineHeight),
    '--reader-width': `${readerSettings.readerWidth}px`,
    '--comic-width': `${readerSettings.comicWidth}%`,
  } as CSSProperties;

  return (
    <section
      className={`nwa-reader-mode${viewMode === 'reader' ? ' is-reader-active' : ''}${immersive ? ' is-immersive' : ''}`}
      data-reader-theme={readerSettings.theme}
      style={readerStyle}
      aria-label="书架模式"
    >
      {viewMode === 'home' ? (
        <header className="nwa-reader-mode__header">
          <div className="nwa-reader-brand">
            <span className="nwa-reader-brand__logo">阅</span>
            <div>
              <h2>小说漫画阅读器</h2>
              <p>TXT / MD / EPUB / HTML / JSON / PDF / CBZ / 图片或 MD 文件夹</p>
            </div>
          </div>
          <nav className="nwa-reader-mode__header-nav" aria-label="书架导航">
            <button type="button" className="is-active" onClick={() => setViewMode('home')}>首页</button>
            <button type="button" onClick={() => { setViewMode('home'); setShelfFilter('all'); }}>书架</button>
            <button type="button" onClick={() => { setViewMode('home'); setShelfFilter('recent'); }}>最近阅读</button>
          </nav>
          <div className="nwa-reader-fusion__top-actions">
            <button type="button" className="nwa-button nwa-button--ghost" onClick={() => updateSetting({ theme: readerSettings.theme === 'paper' ? 'dark' : readerSettings.theme === 'dark' ? 'sepia' : 'paper' })}>
              主题
            </button>
            <button type="button" className="nwa-button nwa-button--ghost" onClick={onOpenAgentMode}>
              <Icon name="panelLeft" /> Agent 工作台
            </button>
          </div>
        </header>
      ) : null}

      <input
        ref={fileInputRef}
        className="is-hidden"
        type="file"
        multiple
        accept=".txt,.md,.markdown,.epub,.html,.htm,.json,.pdf,.cbz,image/*"
        onChange={(event) => void handleImportFile(event)}
      />
      <input
        ref={folderInputRef}
        className="is-hidden"
        type="file"
        multiple
        accept=".txt,.md,.markdown,.epub,.html,.htm,.json,.pdf,.cbz,image/*"
        onChange={(event) => void handleImportFolder(event)}
      />

      {viewMode === 'home' ? (
        <main className="nwa-reader-home">
          <section className="nwa-reader-hero">
            <div className="nwa-reader-hero__copy">
              <p className="nwa-reader-eyebrow">Rebuilt Reader</p>
              <h1>这次直接换一套干净的阅读器壳子</h1>
              <p>导入、书架、刷新恢复、正文阅读、漫画连看和 PDF 查看都先放稳，再把不满意的段落交给 Agent。</p>
              <div className="nwa-reader-format-list">
                <span>EPUB / CBZ / PDF / 图片文件夹</span>
                <span>目录、书签、搜索、上一章下一章</span>
                <span>沉浸模式和阅读设置</span>
              </div>
            </div>
            <section
              className={`nwa-reader-drop${dragActive ? ' is-over' : ''}`}
              onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
              onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
              onDragLeave={(event) => { event.preventDefault(); setDragActive(false); }}
              onDrop={(event) => void handleDrop(event)}
            >
              <h2>拖到这里，或者直接选文件</h2>
              <p>单本小说、单本 EPUB、CBZ、PDF，或者整套漫画图片 / Markdown 文档文件夹都可以。</p>
              <div className="nwa-reader-upload-actions">
                <button type="button" className="nwa-reader-primary" onClick={() => fileInputRef.current?.click()}>选择文件</button>
                <button type="button" className="nwa-reader-secondary" onClick={() => folderInputRef.current?.click()}>选择文件夹</button>
              </div>
              {status ? <p className="nwa-reader-status">{status}</p> : null}
            </section>
          </section>

          <section className="nwa-reader-dashboard">
            <article className="nwa-reader-panel">
              <div className="nwa-reader-panel__head">
                <h2>继续阅读</h2>
                <span>{session?.lastOpenedAt ? formatDateTime(session.lastOpenedAt) : '还没有记录'}</span>
              </div>
              <h3>{continueTitle}</h3>
              <p>{continueMeta}</p>
              <button type="button" className="nwa-reader-primary" disabled={!sessionShelfItem && !sessionProjectBook} onClick={continueReading}>
                继续阅读
              </button>
            </article>

            <article className="nwa-reader-panel">
              <div className="nwa-reader-panel__head">
                <h2>阅读统计</h2>
                <span>本地保存</span>
              </div>
              <div className="nwa-reader-stats">
                <div><label>书架总数</label><strong>{shelf.length + (projectBook ? 1 : 0)}</strong></div>
                <div><label>小说</label><strong>{textCount}</strong></div>
                <div><label>漫画 / PDF</label><strong>{visualCount}</strong></div>
                <div><label>章节 / 页数</label><strong>{sectionCount}</strong></div>
              </div>
            </article>

            <article className="nwa-reader-panel nwa-reader-panel--wide" aria-label="书籍列表">
              <div className="nwa-reader-panel__head">
                <h2>书架</h2>
                <span>刷新后仍然保留</span>
              </div>
              <div className="nwa-reader-shelf-toolbar">
                <label className="nwa-reader-search">
                  <Icon name="search" />
                  <input
                    type="search"
                    placeholder="搜索书名、路径、格式"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <button type="button" className="nwa-reader-secondary" onClick={() => void handlePickScanDirectory()}>扫描文件夹</button>
                <button type="button" className="nwa-reader-secondary" onClick={() => void handlePickOutputDirectory()}>输出目录</button>
              </div>
              <div className="nwa-reader-categories" aria-label="书架分类">
                {([
                  ['all', '全部', shelf.length + (projectBook ? 1 : 0)],
                  ['project', '当前项目', projectBook ? 1 : 0],
                  ['text', '小说', textCount],
                  ['visual', '漫画/PDF', visualCount],
                  ['directory', '文件夹扫描', directoryCount],
                  ['linked', '已接入 Agent', linkedCount],
                  ['recent', '最近阅读', recent.length],
                ] as Array<[ShelfFilter, string, number]>).map(([key, label, count]) => (
                  <button
                    key={key}
                    type="button"
                    className={shelfFilter === key ? 'is-active' : ''}
                    onClick={() => setShelfFilter(key)}
                  >
                    <span>{label}</span>
                    <small>{count}</small>
                  </button>
                ))}
              </div>
              <div className="nwa-reader-book-grid">
                {projectVisible ? (
                  <article className="nwa-reader-book-card">
                    <div className="nwa-reader-book-card__cover"><Icon name="archive" /></div>
                    <div className="nwa-reader-book-card__body">
                      <strong>{projectBook.title}</strong>
                      <span>{bookDetail(projectBook)}</span>
                      <small>project://{projectId ?? 'current'}</small>
                    </div>
                    <div className="nwa-reader-book-card__actions">
                      <button type="button" className="nwa-reader-primary" onClick={() => openProjectBook()}>打开</button>
                      {projectBook.mediaType === 'text' && onSendToReferenceAnalysis ? (
                        <button
                          type="button"
                          className="nwa-reader-secondary"
                          onClick={() => handleSendBookToReference(projectBook, '当前项目')}
                        >
                          参考分析
                        </button>
                      ) : null}
                    </div>
                  </article>
                ) : loadingProject ? (
                  <article className="nwa-reader-book-card">
                    <div className="nwa-reader-book-card__body">
                      <strong>当前项目</strong>
                      <span>加载中...</span>
                    </div>
                  </article>
                ) : null}

                {filteredShelf.map((item) => (
                  <article key={item.id} className="nwa-reader-book-card">
                    <div className="nwa-reader-book-card__cover">
                      {item.book.cover ? <img src={item.book.cover} alt={item.book.title} /> : <span>{item.book.title.slice(0, 1)}</span>}
                    </div>
                    <div className="nwa-reader-book-card__body">
                      <strong>{item.book.title}</strong>
                      <span>{bookDetail(item.book)} · {formatDateTime(item.lastOpenedAt)}</span>
                      <small>{item.origin?.path ?? item.origin?.directoryName ?? '本地书架'}</small>
                    </div>
                    <div className="nwa-reader-book-card__actions">
                      <button type="button" className="nwa-reader-primary" onClick={() => void openShelfBook(item)}>打开</button>
                      {item.book.mediaType === 'text' && onSendToReferenceAnalysis ? (
                        <button
                          type="button"
                          className="nwa-reader-secondary"
                          onClick={() =>
                            handleSendBookToReference(
                              item.book,
                              item.origin?.path ?? item.origin?.directoryName ?? '本地书架',
                            )
                          }
                        >
                          参考分析
                        </button>
                      ) : null}
                      <button type="button" className="nwa-reader-secondary" onClick={() => void handleDeleteShelfItem(item.id)}>删除</button>
                    </div>
                  </article>
                ))}
              </div>
              {filteredShelf.length === 0 && !projectVisible ? <p className="nwa-reader-empty">没有匹配的书籍。</p> : null}
            </article>

            <article className="nwa-reader-panel">
              <div className="nwa-reader-panel__head">
                <h2>最近阅读</h2>
                <span>最近 12 条</span>
              </div>
              <div className="nwa-reader-recent-list">
                {recent.length === 0 ? <p className="nwa-reader-empty">最近还没有阅读记录。</p> : null}
                {recent.map((item) => (
                  <button key={`${item.bookId}-${item.savedAt}`} type="button" onClick={() => openRecentItem(item)}>
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.detail}</small>
                    </span>
                    <em>{formatDateTime(item.savedAt)}</em>
                  </button>
                ))}
              </div>
            </article>

            <article className="nwa-reader-panel">
              <div className="nwa-reader-panel__head">
                <h2>路径与输出</h2>
                <span>{outputDirectoryHandle?.name ?? outputTarget?.name ?? '下载目录'}</span>
              </div>
              <p>当前书：{activeBook?.title ?? '未打开'}</p>
              <div className="nwa-reader-upload-actions">
                <button type="button" className="nwa-reader-secondary" disabled={!activeBook} onClick={() => void handleExportActiveBook('txt')}>导出 TXT</button>
                <button type="button" className="nwa-reader-secondary" disabled={!activeBook} onClick={() => void handleExportActiveBook('html')}>导出 HTML</button>
                <button
                  type="button"
                  className="nwa-reader-secondary"
                  disabled={!activeBook || activeBook.mediaType !== 'text' || !onSendToReferenceAnalysis}
                  onClick={() => handleSendBookToReference(activeBook, '当前阅读')}
                  title="送去 Agent 对话做参考小说分析（可勾选章节）"
                >
                  送去参考分析
                </button>
              </div>
            </article>
          </section>
        </main>
      ) : (
        <section className="nwa-reader-view">
          {readerPanel ? <button type="button" className="nwa-reader-overlay" aria-label="关闭面板" onClick={() => setReaderPanel(null)} /> : null}

          {readerPanel === 'toc' ? (
            <aside className="nwa-reader-side-panel">
              <div className="nwa-reader-panel__head">
                <h2>目录</h2>
                <button type="button" className="nwa-reader-secondary" onClick={() => setReaderPanel(null)}>关闭</button>
              </div>
              <nav className="nwa-reader-side-list" aria-label="目录">
                {activeBook?.mediaType === 'text' ? activeBook.chapters.map((chapter, index) => (
                  <button key={chapter.id} type="button" className={index === chapterIndex ? 'is-active' : ''} onClick={() => { goToChapter(index); setReaderPanel(null); }}>
                    {chapter.title}
                  </button>
                )) : <p className="nwa-reader-empty">这个格式不需要章节目录。</p>}
              </nav>
            </aside>
          ) : null}

          {readerPanel === 'bookmarks' ? (
            <aside className="nwa-reader-side-panel">
              <div className="nwa-reader-panel__head">
                <h2>书签</h2>
                <button type="button" className="nwa-reader-secondary" onClick={() => setReaderPanel(null)}>关闭</button>
              </div>
              <div className="nwa-reader-side-list" aria-label="书签">
                {bookmarks.length === 0 ? <p className="nwa-reader-empty">当前还没有书签。</p> : null}
                {bookmarks.map((bookmark) => (
                  <div key={`${bookmark.bookId}-${bookmark.chapterId}`} className="nwa-reader-bookmark-row">
                    <button type="button" onClick={() => { goToChapter(bookmark.chapterIndex); setReaderPanel(null); }}>
                      <strong>{bookmark.chapterTitle}</strong>
                      <small>{bookmark.excerpt}</small>
                    </button>
                    <button type="button" className="nwa-reader-secondary" onClick={() => removeBookmark(bookmark)}>删除</button>
                  </div>
                ))}
              </div>
            </aside>
          ) : null}

          {readerPanel === 'settings' ? (
            <aside className="nwa-reader-settings-panel">
              <div className="nwa-reader-panel__head">
                <h2>阅读设置</h2>
                <button type="button" className="nwa-reader-secondary" onClick={() => setReaderPanel(null)}>关闭</button>
              </div>
              <label><span>字体大小</span><input type="range" min="16" max="30" value={readerSettings.fontSize} onChange={(event) => updateSetting({ fontSize: Number(event.target.value) })} /></label>
              <label><span>行距</span><input type="range" min="1.5" max="2.4" step="0.1" value={readerSettings.lineHeight} onChange={(event) => updateSetting({ lineHeight: Number(event.target.value) })} /></label>
              <label><span>正文宽度</span><input type="range" min="720" max="1100" step="10" value={readerSettings.readerWidth} onChange={(event) => updateSetting({ readerWidth: Number(event.target.value) })} /></label>
              <label><span>漫画宽度</span><input type="range" min="70" max="100" value={readerSettings.comicWidth} onChange={(event) => updateSetting({ comicWidth: Number(event.target.value) })} /></label>
              <button type="button" className="nwa-reader-secondary" onClick={resetSettings}>恢复默认</button>
            </aside>
          ) : null}

          {workMode === 'agent' && activeBook?.mediaType === 'text' ? (
            <aside className="nwa-reader-agent-panel" aria-label="阅读 Agent">
              <div className="nwa-reader-panel__head">
                <h2>阅读 Agent</h2>
                <button type="button" className="nwa-reader-secondary" onClick={() => setWorkMode('read')}>关闭</button>
              </div>
              <div className="nwa-reader-agent-selection">
                <span>选中文段</span>
                <p>{selectedText || '在正文中拖选一段文字。'}</p>
              </div>
              <div className="nwa-reader-agent-actions">
                <button type="button" className="nwa-reader-secondary" disabled={agentBusy || !activeChapter} onClick={() => void handleExtract('world')}>提取世界观</button>
                <button type="button" className="nwa-reader-secondary" disabled={agentBusy || !activeChapter} onClick={() => void handleExtract('outline')}>提取大纲</button>
                <button type="button" className="nwa-reader-secondary" disabled={agentBusy || !activeChapter} onClick={() => void handleExtract('character')}>提取人物</button>
              </div>
              <label className="nwa-reader-agent-field">
                <span>重写要求</span>
                <textarea value={rewriteInstruction} onChange={(event) => setRewriteInstruction(event.target.value)} />
              </label>
              <button type="button" className="nwa-reader-primary" disabled={agentBusy || selectedText.trim().length === 0} onClick={() => void handleRewrite()}>
                {agentBusy ? '处理中...' : '重写选段'}
              </button>
              {rewriteCandidate ? (
                <div className="nwa-reader-agent-selection">
                  <span>改写候选</span>
                  <p>{rewriteCandidate}</p>
                  <button type="button" className="nwa-reader-primary" disabled={agentBusy} onClick={() => void handleApplyRewrite()}>应用改写</button>
                </div>
              ) : null}
            </aside>
          ) : null}

          <main className="nwa-reader-main">
            <div className="nwa-reader-toolbar">
              <div className="nwa-reader-toolbar__left">
                <button type="button" className="nwa-reader-secondary" onClick={() => { setViewMode('home'); setImmersiveMode(false); }}>首页</button>
                <button type="button" className="nwa-reader-secondary" onClick={() => { setViewMode('home'); setShelfFilter('all'); setImmersiveMode(false); }}>书架</button>
                <button type="button" className="nwa-reader-secondary" onClick={() => setReaderPanel('toc')}>目录</button>
                <div className="nwa-reader-toolbar__title">
                  <p className="nwa-reader-eyebrow">Focus Reader</p>
                  <h1>{activeBook?.title ?? '未打开内容'}</h1>
                </div>
              </div>
              <div className="nwa-reader-toolbar__right">
                <button type="button" role="tab" aria-selected={workMode === 'read'} className={workMode === 'read' ? 'nwa-reader-primary' : 'nwa-reader-secondary'} onClick={() => setWorkMode('read')}>阅读</button>
                <button type="button" role="tab" aria-selected={workMode === 'agent'} className={workMode === 'agent' ? 'nwa-reader-primary' : 'nwa-reader-secondary'} disabled={activeBook?.mediaType !== 'text'} onClick={() => setWorkMode('agent')}>Agent</button>
                <button type="button" className="nwa-reader-secondary" disabled={activeBook?.mediaType !== 'text'} onClick={toggleCurrentBookmark}>{isCurrentBookmarked ? '取消书签' : '加入书签'}</button>
                <button type="button" className="nwa-reader-secondary" onClick={() => setReaderPanel('bookmarks')}>书签</button>
                <button type="button" className="nwa-reader-secondary" onClick={() => setImmersiveMode(!immersive)}>{immersive ? '退出沉浸' : '沉浸模式'}</button>
                <button type="button" className="nwa-reader-secondary" onClick={() => setReaderPanel('settings')}>阅读设置</button>
              </div>
            </div>

            <div className="nwa-reader-meta" aria-label="全书统计">
              <div className="nwa-reader-meta__line">
                <span>
                  {activeBook ? (
                    activeBook.mediaType === 'text'
                      ? `${activeBook.format.toUpperCase()} · 第 ${chapterIndex + 1} / ${activeBook.chapters.length} 章 · ${totalWords.toLocaleString()} 字`
                      : bookDetail(activeBook)
                  ) : '等待导入'}
                </span>
                <div className="nwa-reader-inline-search">
                  <input
                    type="text"
                    placeholder="搜索当前小说"
                    value={readerSearch}
                    disabled={activeBook?.mediaType !== 'text'}
                    onChange={(event) => setReaderSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') runReaderSearch();
                    }}
                  />
                  <button type="button" className="nwa-reader-secondary" disabled={activeBook?.mediaType !== 'text'} onClick={runReaderSearch}>搜索</button>
                </div>
              </div>
              {activeBook?.mediaType === 'text' ? (
                <div className="nwa-reader-progress">
                  <div>
                    <label htmlFor="readerChapterRange">章节跳转</label>
                    <strong>第 {chapterIndex + 1} / {activeBook.chapters.length} 章</strong>
                  </div>
                  <input
                    id="readerChapterRange"
                    type="range"
                    min="1"
                    max={Math.max(1, activeBook.chapters.length)}
                    value={chapterIndex + 1}
                    onChange={(event) => goToChapter(Number(event.target.value) - 1)}
                  />
                </div>
              ) : null}
              {status ? <p className="nwa-reader-status">{status}</p> : null}
            </div>

            <div className="nwa-reader-scroller" ref={readerSurfaceRef} onMouseUp={captureSelection} onKeyUp={captureSelection}>
              <div className="nwa-reader-surface">
                {activeBook?.mediaType === 'text' && activeChapter ? (
                  <article className="nwa-reader-chapter-card">
                    <h2>{activeChapter.title}</h2>
                    <div className="nwa-reader-chapter-text">
                      {activeChapter.content.split(/\n{2,}/u).filter(Boolean).map(renderParagraph)}
                    </div>
                    <div className="nwa-reader-end-nav" aria-label="章节末尾导航">
                      <button type="button" className="nwa-reader-secondary" disabled={chapterIndex <= 0} onClick={() => goToChapter(chapterIndex - 1)}>
                        <span>上一章</span>
                        <strong>{chapterIndex <= 0 ? '已经是第一章' : activeBook.chapters[chapterIndex - 1]?.title}</strong>
                      </button>
                      <button type="button" className="nwa-reader-secondary" disabled={chapterIndex >= activeBook.chapters.length - 1} onClick={() => goToChapter(chapterIndex + 1)}>
                        <span>下一章</span>
                        <strong>{chapterIndex >= activeBook.chapters.length - 1 ? '已经是最后一章' : activeBook.chapters[chapterIndex + 1]?.title}</strong>
                      </button>
                    </div>
                  </article>
                ) : null}

                {activeBook?.mediaType === 'comic' ? (
                  <article className="nwa-reader-comic-card">
                    {(activeBook.pages ?? []).map((page) => (
                      <img key={page.id} src={page.src} alt={page.name} loading="lazy" />
                    ))}
                  </article>
                ) : null}

                {activeBook?.mediaType === 'pdf' ? (
                  <article className="nwa-reader-pdf-card">
                    <iframe src={activeBook.pdfDataUrl} title={activeBook.title} />
                  </article>
                ) : null}
              </div>
            </div>
          </main>

          {immersive ? <button type="button" className="nwa-reader-immersive-exit" onClick={() => setImmersiveMode(false)}>退出沉浸</button> : null}
        </section>
      )}
    </section>
  );
}

export default ReaderWorkspace;
