import type JSZipClass from 'jszip';

export interface ReaderChapter {
  id: string;
  title: string;
  content: string;
  position: number;
  backendChapterId?: string;
  backendRevision?: number;
}

export interface ReaderPage {
  id: string;
  name: string;
  src: string;
}

export type ReaderBookSource = 'imported' | 'project';
export type ReaderMediaType = 'text' | 'comic' | 'pdf';

export interface ReaderBook {
  id: string;
  source: ReaderBookSource;
  title: string;
  format: string;
  mediaType: ReaderMediaType;
  chapters: ReaderChapter[];
  pages?: ReaderPage[];
  cover?: string;
  pdfDataUrl?: string;
  createdAt: string;
  updatedAt: string;
  linkedProjectId?: string;
}

export interface ParseReaderFileOptions {
  id?: string;
  title?: string;
}

export interface ParseReaderFolderOptions extends ParseReaderFileOptions {
  displayName?: string;
}

const MAX_READER_BOOK_CHARS = 3_000_000;
const TEXT_CHAPTER_PATTERN = /^(第[0-9零一二三四五六七八九十百千万两〇]+[章节卷部篇回集][^\n]{0,60}|序章|前言|引子|楔子|后记|番外[^\n]{0,40})$/u;
const EN_TEXT_CHAPTER_PATTERN = /^(chapter|part|episode|prologue|epilogue)\s+[\w\d-][^\n]{0,60}$/iu;
const SUPPORTED_TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'html', 'htm', 'json', 'epub']);
const IMAGE_FILE_PATTERN = /\.(avif|bmp|gif|jpe?g|png|webp)$/iu;
export const SUPPORTED_READER_FILE_PATTERN = /\.(txt|md|markdown|html|htm|json|epub|pdf|cbz|avif|bmp|gif|jpe?g|png|webp)$/iu;
/** Raster data URLs only: png/jpeg/jpg/gif/webp, optional charset, base64 payload. */
const READER_RASTER_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpe?g|gif|webp)(?:;charset=[^;,]+)?;base64,/iu;

/** True for inline reader images that cannot execute as SVG/HTML. */
export function isAllowedReaderRasterDataUrl(src: string): boolean {
  return READER_RASTER_DATA_URL_PATTERN.test(String(src).trim());
}

interface ParsedHtmlDocument {
  title: string;
  chapters: Array<{ title: string; paragraphs: string[] }>;
}

interface EpubManifestItem {
  href: string;
  mediaType: string;
  properties: string;
}

type JSZipInstance = Awaited<ReturnType<typeof JSZipClass.loadAsync>>;

async function loadJsZip(): Promise<typeof JSZipClass> {
  const module = await import('jszip');
  return module.default;
}

export async function parseReaderFile(file: File, options: ParseReaderFileOptions = {}): Promise<ReaderBook> {
  const format = extensionOf(file.name);
  if (SUPPORTED_TEXT_EXTENSIONS.has(format)) {
    if (format === 'epub') return buildEpubBook(file, options);
    const text = await readFileAsText(file);
    if (format === 'json') return buildJsonBook(text, file.name, options);
    if (format === 'html' || format === 'htm') return buildHtmlBook(text, file.name, options);
    if (format === 'md' || format === 'markdown') return buildMarkdownBook(text, file.name, options);
    return buildTextBook(text, file.name, format, options);
  }
  if (format === 'pdf') return buildPdfBook(file, options);
  if (format === 'cbz') return buildComicArchiveBook(file, options);
  if (isImageFile(file.name)) return buildComicBookFromImages([file], options.title ?? stripExtension(file.name), options);
  throw new Error(`暂不支持 ${format || '未知'} 格式。`);
}

export async function parseReaderFolder(files: File[], options: ParseReaderFolderOptions = {}): Promise<ReaderBook[]> {
  const supported = sortFilesByPath(files.filter((file) => isSupportedReaderFileName(file.name)));
  if (supported.length === 0) throw new Error('没有找到可导入的阅读文件。');
  const imageFiles = supported.filter((file) => isImageFile(file.name));
  const markdownFiles = supported.filter((file) => ['md', 'markdown'].includes(extensionOf(file.name)));
  const nonMarkdownText = supported.filter((file) => !['md', 'markdown'].includes(extensionOf(file.name)) && !isImageFile(file.name));

  if (imageFiles.length > 0 && imageFiles.length === supported.length) {
    return [await buildComicBookFromImages(imageFiles, options.displayName ?? inferFolderName(imageFiles), options)];
  }

  if (markdownFiles.length > 0 && markdownFiles.length === supported.length) {
    return [await buildMarkdownBookFromFolder(markdownFiles, options)];
  }

  const books: ReaderBook[] = [];
  for (const file of [...markdownFiles, ...nonMarkdownText, ...imageFiles]) {
    books.push(await parseReaderFile(file, {
      id: createStableReaderId(filePathOf(file)),
    }));
  }
  return books;
}

export function isSupportedReaderFileName(fileName: string): boolean {
  return SUPPORTED_READER_FILE_PATTERN.test(fileName);
}

/**
 * 把阅读器文本书转成参考分析用的纯文本（带章节标题，便于后端分章）。
 * 仅支持 mediaType === 'text' 且有章节正文的书。
 */
export function readerBookToReferenceText(book: ReaderBook): string {
  if (book.mediaType !== 'text') {
    throw new Error('仅文本类书籍可送去参考分析（漫画/PDF 不支持）。');
  }
  const chapters = book.chapters.filter((ch) => ch.content.trim().length > 0);
  if (chapters.length === 0) {
    throw new Error('这本书没有可用正文，无法做参考分析。');
  }
  const parts = chapters.map((ch, index) => {
    const title = (ch.title || `第${index + 1}章`).trim();
    // 保证标题行能被参考分析的章节识别命中
    const heading = /第.+[章节卷回]|Chapter\s+\d+/i.test(title)
      ? title
      : `第${index + 1}章 ${title}`;
    return `${heading}\n\n${ch.content.trim()}`;
  });
  const text = parts.join('\n\n');
  // 仅拦截空书；后端 import 还有更严格的最短字数校验
  if (text.replace(/\s/g, '').length < 20) {
    throw new Error('正文过短，无法做参考分析。');
  }
  return text;
}

/** 参考分析支持的本地文件扩展名（含 EPUB）。 */
export function isReferenceImportFileName(fileName: string): boolean {
  const ext = extensionOf(fileName);
  return ['txt', 'md', 'markdown', 'html', 'htm', 'epub'].includes(ext);
}

export function isImageFile(fileName: string): boolean {
  return IMAGE_FILE_PATTERN.test(String(fileName || ''));
}

export function filePathOf(file: File): string {
  const withPath = file as File & { webkitRelativePath?: string };
  return withPath.webkitRelativePath || file.name;
}

export function buildReaderBook(
  title: string,
  format: string,
  content: string,
  source: ReaderBookSource = 'imported',
  id = createReaderId('book'),
): ReaderBook {
  const now = new Date().toISOString();
  return {
    id,
    source,
    title: cleanTitle(title, '未命名书籍'),
    format,
    mediaType: 'text',
    chapters: splitReaderChapters(content),
    cover: '',
    createdAt: now,
    updatedAt: now,
  };
}

export function splitReaderChapters(content: string): ReaderChapter[] {
  const lines = normalizePlainText(content).split('\n');
  const chapters: ReaderChapter[] = [];
  let currentTitle = '正文';
  let currentLines: string[] = [];

  const flush = () => {
    const body = currentLines.join('\n').trim();
    if (!body && chapters.length > 0) return;
    chapters.push({
      id: createReaderId('chapter'),
      title: cleanTitle(currentTitle, `第 ${chapters.length + 1} 章`),
      content: body,
      position: chapters.length,
    });
    currentLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (isChapterHeading(line)) {
      if (currentLines.some((item) => item.trim())) flush();
      currentTitle = line.replace(/^#{1,6}\s*/u, '');
      currentLines = [];
      continue;
    }
    currentLines.push(rawLine);
  }

  if (currentLines.some((item) => item.trim()) || chapters.length === 0) flush();
  return chapters.filter((chapter) => chapter.content.length > 0 || chapters.length === 1);
}

export function createReaderId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

export function createStableReaderId(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `book-${(hash >>> 0).toString(36)}`;
}

export function countReaderWords(content: string): number {
  const cjkCount = content.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const latinCount = content
    .replace(/[\u3400-\u9fff]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return cjkCount + latinCount;
}

export function normalizePlainText(content: string): string {
  return String(content ?? '')
    .replace(/^\ufeff/u, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export function replaceFirstSelection(
  content: string,
  selectedText: string,
  replacement: string,
): string | null {
  const target = selectedText.trim();
  if (target.length === 0) return null;
  const index = content.indexOf(target);
  if (index < 0) return null;
  return `${content.slice(0, index)}${replacement.trim()}${content.slice(index + target.length)}`;
}

function buildBookBase(
  title: string,
  format: string,
  mediaType: ReaderMediaType,
  options: ParseReaderFileOptions,
): Omit<ReaderBook, 'chapters'> {
  const now = new Date().toISOString();
  return {
    id: options.id ?? createReaderId('book'),
    source: 'imported',
    title: cleanTitle(options.title ?? title, '未命名书籍'),
    format,
    mediaType,
    cover: '',
    createdAt: now,
    updatedAt: now,
  };
}

async function buildTextBook(
  text: string,
  fileName: string,
  format: string,
  options: ParseReaderFileOptions,
): Promise<ReaderBook> {
  const normalized = normalizePlainText(text);
  validateBookSize(normalized);
  return {
    ...buildBookBase(stripExtension(fileName), format, 'text', options),
    chapters: splitReaderChapters(normalized),
  };
}

async function buildMarkdownBook(text: string, fileName: string, options: ParseReaderFileOptions): Promise<ReaderBook> {
  const chapters = splitMarkdownIntoChapters(text, stripExtension(fileName));
  validateBookSize(chapters.map((chapter) => chapter.content).join('\n\n'));
  return {
    ...buildBookBase(stripExtension(fileName), 'md', 'text', options),
    chapters,
  };
}

async function buildMarkdownBookFromFolder(files: File[], options: ParseReaderFolderOptions): Promise<ReaderBook> {
  const chapters: ReaderChapter[] = [];
  for (const file of sortFilesByPath(files)) {
    const parsed = splitMarkdownIntoChapters(await readFileAsText(file), stripExtension(file.name));
    chapters.push(...parsed.map((chapter) => ({
      ...chapter,
      title: `${stripExtension(file.name)} · ${chapter.title}`,
    })));
  }
  const reindexed = reindexChapters(chapters);
  validateBookSize(reindexed.map((chapter) => chapter.content).join('\n\n'));
  return {
    ...buildBookBase(options.displayName ?? inferFolderName(files), 'md-folder', 'text', options),
    chapters: reindexed,
  };
}

async function buildHtmlBook(text: string, fileName: string, options: ParseReaderFileOptions): Promise<ReaderBook> {
  const parsed = parseHtmlDocument(text, stripExtension(fileName));
  const chapters = parsed.chapters.map((chapter, index) => ({
    id: createReaderId('chapter'),
    title: cleanTitle(chapter.title, `章节 ${index + 1}`),
    content: chapter.paragraphs.join('\n\n'),
    position: index,
  }));
  validateBookSize(chapters.map((chapter) => chapter.content).join('\n\n'));
  return {
    ...buildBookBase(parsed.title || stripExtension(fileName), 'html', 'text', options),
    chapters,
  };
}

async function buildJsonBook(text: string, fileName: string, options: ParseReaderFileOptions): Promise<ReaderBook> {
  const parsed = parseStructuredJson(text, stripExtension(fileName));
  const chapters = parsed.chapters.map((chapter, index) => ({
    id: createReaderId('chapter'),
    title: cleanTitle(chapter.title, `章节 ${index + 1}`),
    content: chapter.paragraphs.join('\n\n'),
    position: index,
  }));
  validateBookSize(chapters.map((chapter) => chapter.content).join('\n\n'));
  return {
    ...buildBookBase(parsed.title || stripExtension(fileName), 'json', 'text', options),
    chapters,
  };
}

async function buildEpubBook(file: File, options: ParseReaderFileOptions): Promise<ReaderBook> {
  const parsed = await parseEpub(file);
  const chapters = parsed.chapters.map((chapter, index) => ({
    id: createReaderId('chapter'),
    title: cleanTitle(chapter.title, `章节 ${index + 1}`),
    content: chapter.paragraphs.join('\n\n'),
    position: index,
  }));
  validateBookSize(chapters.map((chapter) => chapter.content).join('\n\n'));
  return {
    ...buildBookBase(parsed.title || stripExtension(file.name), 'epub', 'text', options),
    chapters,
    cover: parsed.cover,
  };
}

async function buildPdfBook(file: File, options: ParseReaderFileOptions): Promise<ReaderBook> {
  const base = buildBookBase(stripExtension(file.name), 'pdf', 'pdf', options);
  return {
    ...base,
    chapters: [],
    pdfDataUrl: await fileToDataUrl(file),
  };
}

async function buildComicArchiveBook(file: File, options: ParseReaderFileOptions): Promise<ReaderBook> {
  const JSZip = await loadJsZip();
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir && isImageFile(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));
  if (entries.length === 0) throw new Error('CBZ 内没有检测到图片文件。');
  const pages: ReaderPage[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const bytes = await entry.async('uint8array');
    pages.push({
      id: `page-${index + 1}`,
      name: basename(entry.name),
      src: bytesToDataUrl(bytes, getImageMimeType(entry.name)),
    });
  }
  return {
    ...buildBookBase(stripExtension(file.name), 'cbz', 'comic', options),
    chapters: [],
    pages,
    cover: pages[0]?.src ?? '',
  };
}

async function buildComicBookFromImages(
  files: File[],
  title: string,
  options: ParseReaderFileOptions,
): Promise<ReaderBook> {
  const sorted = sortFilesByPath(files.filter((file) => isImageFile(file.name)));
  if (sorted.length === 0) throw new Error('没有检测到图片文件。');
  const pages: ReaderPage[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const file = sorted[index]!;
    pages.push({
      id: `page-${index + 1}`,
      name: filePathOf(file),
      src: await fileToDataUrl(file),
    });
  }
  return {
    ...buildBookBase(title || inferFolderName(sorted), sorted.length === 1 ? 'image' : 'images', 'comic', options),
    chapters: [],
    pages,
    cover: pages[0]?.src ?? '',
  };
}

async function readFileAsText(file: File): Promise<string> {
  if (typeof file.arrayBuffer === 'function') {
    return decodeTextBuffer(await file.arrayBuffer());
  }
  if (typeof FileReader !== 'undefined') {
    return decodeTextBuffer(await readFileAsArrayBuffer(file));
  }
  if (typeof file.text === 'function') {
    return file.text();
  }
  throw new Error('当前环境不支持读取本地文件。');
}

function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败。'));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('文件读取结果不是二进制缓冲区。'));
    };
    reader.readAsArrayBuffer(file);
  });
}

function decodeTextBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const utf8 = decodeWithEncoding(bytes, 'utf-8', true);
  if (utf8 !== null && !utf8.includes('\uFFFD')) return utf8;
  return decodeWithEncoding(bytes, 'gb18030', false) ?? new TextDecoder('utf-8').decode(bytes);
}

function decodeWithEncoding(bytes: Uint8Array, encoding: string, fatal: boolean): string | null {
  try {
    return new TextDecoder(encoding, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败。'));
    reader.readAsDataURL(file);
  });
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function splitMarkdownIntoChapters(text: string, fallbackTitle: string): ReaderChapter[] {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const chapters: ReaderChapter[] = [];
  let title = fallbackTitle;
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const content = buffer.map(cleanInlineMarkdown).filter(Boolean).join('\n\n').trim();
    if (!content && chapters.length > 0) return;
    chapters.push({
      id: createReaderId('chapter'),
      title: cleanTitle(title, `章节 ${chapters.length + 1}`),
      content,
      position: chapters.length,
    });
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      const match = line.match(/^(#{1,6})\s+(.+)$/u);
      if (match) {
        const level = match[1]!.length;
        if (level <= 2) {
          if (buffer.some((item) => item.trim())) flush();
          title = cleanInlineMarkdown(match[2]!);
        } else {
          buffer.push(cleanInlineMarkdown(match[2]!));
        }
        continue;
      }
    }
    if (line.trim()) buffer.push(line);
  }
  if (buffer.some((item) => item.trim()) || chapters.length === 0) flush();
  return chapters;
}

function parseHtmlDocument(html: string, fallbackTitle: string): ParsedHtmlDocument {
  if (typeof DOMParser === 'undefined') {
    return { title: fallbackTitle, chapters: [{ title: fallbackTitle, paragraphs: [normalizePlainText(html)].filter(Boolean) }] };
  }
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script,style,noscript,iframe').forEach((node) => node.remove());
  const title = normalizeDomText(doc.querySelector('title')?.textContent)
    || normalizeDomText(doc.querySelector('h1')?.textContent)
    || fallbackTitle;
  const blocks: Array<{ type: 'heading' | 'paragraph'; text: string }> = [];
  walkHtmlBlocks(doc.body || doc.documentElement, blocks);
  return { title, chapters: buildChaptersFromBlocks(blocks, title) };
}

function walkHtmlBlocks(root: Node | null, blocks: Array<{ type: 'heading' | 'paragraph'; text: string }>): void {
  if (!root) return;
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = normalizeDomText(node.textContent);
      if (text) blocks.push({ type: 'paragraph', text });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (/^h[1-3]$/u.test(tag)) {
      const text = normalizeDomText(element.textContent);
      if (text) blocks.push({ type: 'heading', text });
      return;
    }
    if (['p', 'li', 'blockquote', 'pre'].includes(tag)) {
      const text = normalizeDomText(element.textContent);
      if (text) blocks.push({ type: 'paragraph', text });
      return;
    }
    walkHtmlBlocks(element, blocks);
  });
}

function buildChaptersFromBlocks(
  blocks: Array<{ type: 'heading' | 'paragraph'; text: string }>,
  fallbackTitle: string,
): Array<{ title: string; paragraphs: string[] }> {
  const chapters: Array<{ title: string; paragraphs: string[] }> = [];
  let current = { title: fallbackTitle, paragraphs: [] as string[] };
  for (const block of blocks) {
    if (block.type === 'heading') {
      if (!current.paragraphs.length && current.title === fallbackTitle) {
        current = { ...current, title: block.text };
        continue;
      }
      if (current.paragraphs.length) chapters.push(current);
      current = { title: block.text, paragraphs: [] };
      continue;
    }
    current.paragraphs.push(block.text);
  }
  if (current.paragraphs.length || chapters.length === 0) chapters.push(current);
  return chapters;
}

function parseStructuredJson(jsonText: string, fallbackTitle: string): ParsedHtmlDocument {
  const payload = JSON.parse(String(jsonText || '')) as unknown;
  if (Array.isArray(payload)) {
    return { title: fallbackTitle, chapters: [{ title: fallbackTitle, paragraphs: payload.map(stringifyParagraph).filter(Boolean) }] };
  }
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title : fallbackTitle;
    if (typeof record.content === 'string') {
      return { title, chapters: [{ title, paragraphs: splitPlainParagraphs(record.content) }] };
    }
    if (Array.isArray(record.paragraphs)) {
      return { title, chapters: [{ title, paragraphs: record.paragraphs.map(stringifyParagraph).filter(Boolean) }] };
    }
    if (Array.isArray(record.chapters)) {
      const chapters = record.chapters.map((chapter, index) => {
        const item = chapter as Record<string, unknown>;
        return {
          title: typeof item.title === 'string' ? item.title : `章节 ${index + 1}`,
          paragraphs: Array.isArray(item.paragraphs)
            ? item.paragraphs.map(stringifyParagraph).filter(Boolean)
            : splitPlainParagraphs(String(item.content || '')),
        };
      }).filter((chapter) => chapter.paragraphs.length > 0);
      if (chapters.length > 0) return { title, chapters };
    }
  }
  throw new Error('JSON 结构未识别，支持 content / paragraphs / chapters。');
}

async function parseEpub(file: File): Promise<{ title: string; chapters: Array<{ title: string; paragraphs: string[] }>; cover: string }> {
  const JSZip = await loadJsZip();
  const zip = await JSZip.loadAsync(file);
  const containerXml = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerXml) throw new Error('EPUB 缺少 META-INF/container.xml。');
  const opfPath = containerXml.match(/full-path="([^"]+)"/u)?.[1];
  if (!opfPath) throw new Error('无法定位 EPUB 的 OPF 文件。');
  const opfContent = await zip.file(opfPath)?.async('text');
  if (!opfContent) throw new Error(`未找到 OPF 文件：${opfPath}`);
  const { manifest, spine, metadataTitle, coverHref } = parseOpf(opfContent);
  const cover = coverHref ? await loadZipImageAsDataUrl(zip, resolvePath(opfPath, coverHref)) : '';
  const chapters: Array<{ title: string; paragraphs: string[] }> = [];

  for (const id of spine) {
    const item = manifest[id];
    if (!item || !/html|xhtml/iu.test(item.mediaType)) continue;
    const entryPath = resolvePath(opfPath, item.href);
    const htmlContent = await zip.file(entryPath)?.async('text');
    if (!htmlContent) continue;
    const doc = new DOMParser().parseFromString(htmlContent, 'application/xhtml+xml');
    await inlineEpubImages(doc, zip, entryPath);
    const title = normalizeDomText(doc.querySelector('h1,h2,h3')?.textContent)
      || normalizeDomText(doc.querySelector('title')?.textContent)
      || `章节 ${chapters.length + 1}`;
    const paragraphs = extractEpubParagraphs(doc.body ?? doc.querySelector('body') ?? doc.documentElement);
    if (paragraphs.length > 0) chapters.push({ title, paragraphs });
  }

  if (chapters.length === 0) throw new Error('EPUB 中未提取到正文内容。');
  return { title: metadataTitle || stripExtension(file.name), chapters, cover };
}

function parseOpf(opfContent: string): {
  manifest: Record<string, EpubManifestItem>;
  spine: string[];
  metadataTitle: string;
  coverHref: string;
} {
  const doc = new DOMParser().parseFromString(opfContent, 'application/xml');
  const manifest: Record<string, EpubManifestItem> = {};
  let coverId = '';
  let coverHref = '';
  Array.from(doc.getElementsByTagName('*')).forEach((element) => {
    if (element.localName === 'meta' && element.getAttribute('name') === 'cover') {
      coverId = element.getAttribute('content') || '';
    }
  });
  Array.from(doc.getElementsByTagName('*')).forEach((element) => {
    if (element.localName !== 'item') return;
    const id = element.getAttribute('id');
    if (!id) return;
    const item = {
      href: element.getAttribute('href') || '',
      mediaType: element.getAttribute('media-type') || '',
      properties: element.getAttribute('properties') || '',
    };
    manifest[id] = item;
    const looksLikeCover = item.properties.includes('cover-image') || id === coverId || /cover/iu.test(id) || /cover/iu.test(item.href);
    if (!coverHref && looksLikeCover && /^image\//iu.test(item.mediaType)) coverHref = item.href;
  });
  const spine = Array.from(doc.getElementsByTagName('*'))
    .filter((element) => element.localName === 'itemref')
    .map((element) => element.getAttribute('idref') || '')
    .filter(Boolean);
  const metadataTitle = Array.from(doc.getElementsByTagName('*'))
    .find((element) => element.localName === 'title')?.textContent?.trim() ?? '';
  return { manifest, spine, metadataTitle, coverHref };
}

async function inlineEpubImages(doc: Document, zip: JSZipInstance, basePath: string): Promise<void> {
  const images = Array.from(doc.querySelectorAll('img, image'));
  for (const image of images) {
    const source = image.getAttribute('src') || image.getAttribute('href') || image.getAttribute('xlink:href') || '';
    if (!source || source.startsWith('data:') || /^https?:/iu.test(source)) continue;
    const dataUrl = await loadZipImageAsDataUrl(zip, resolvePath(basePath, source));
    if (!dataUrl) continue;
    if (image.tagName.toLowerCase() === 'image') image.setAttribute('href', dataUrl);
    else image.setAttribute('src', dataUrl);
  }
}

async function loadZipImageAsDataUrl(zip: JSZipInstance, path: string): Promise<string> {
  const entry = zip.file(path);
  if (!entry) return '';
  const bytes = await entry.async('uint8array');
  return bytesToDataUrl(bytes, getImageMimeType(path));
}

function extractEpubParagraphs(root: Element | null): string[] {
  if (!root) return [];
  const paragraphs: string[] = [];
  const selectors = 'p,li,blockquote,pre,h3,img,image';
  const nodes = Array.from(root.querySelectorAll(selectors));
  for (const node of nodes) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'img' || tag === 'image') {
      const src = node.getAttribute('src') || node.getAttribute('href') || node.getAttribute('xlink:href') || '';
      if (isAllowedReaderRasterDataUrl(src)) paragraphs.push(`<figure class="nwa-reader-inline-image"><img src="${escapeAttr(src)}" alt="${escapeAttr(node.getAttribute('alt') || '')}"></figure>`);
      continue;
    }
    const text = normalizeDomText(node.textContent);
    if (text) paragraphs.push(tag === 'h3' ? `<h3 class="nwa-reader-subheading">${escapeHtml(text)}</h3>` : text);
  }
  return paragraphs;
}

function cleanInlineMarkdown(text: string): string {
  return String(text || '')
    .replace(/!\[[^\]]*\]\([^)]+\)/gu, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/[*_~`>#-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function splitPlainParagraphs(content: string): string[] {
  return normalizePlainText(content).split(/\n{2,}/u).map((item) => item.trim()).filter(Boolean);
}

function stringifyParagraph(item: unknown): string {
  if (typeof item === 'string') return normalizePlainText(item);
  if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
    return normalizePlainText((item as { text: string }).text);
  }
  return normalizePlainText(String(item || ''));
}

function reindexChapters(chapters: ReaderChapter[]): ReaderChapter[] {
  return chapters.map((chapter, index) => ({
    ...chapter,
    id: createReaderId('chapter'),
    position: index,
  }));
}

function validateBookSize(content: string): void {
  if (content.length > MAX_READER_BOOK_CHARS) {
    throw new Error('单本书超过 3,000,000 字符，请先拆分后导入。');
  }
}

function isChapterHeading(line: string): boolean {
  const normalized = String(line || '').trim().replace(/^#{1,6}\s*/u, '');
  return TEXT_CHAPTER_PATTERN.test(normalized) || EN_TEXT_CHAPTER_PATTERN.test(normalized);
}

function normalizeDomText(text: string | null | undefined): string {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sortFilesByPath(files: File[]): File[] {
  return [...files].sort((left, right) => (
    filePathOf(left).localeCompare(filePathOf(right), undefined, { numeric: true, sensitivity: 'base' })
  ));
}

function inferFolderName(files: File[]): string {
  const firstPath = files[0] ? filePathOf(files[0]) : '';
  return firstPath.split('/')[0] || '导入文件夹';
}

function extensionOf(fileName: string): string {
  return String(fileName || '').split('.').pop()?.toLowerCase() ?? '';
}

function stripExtension(fileName: string): string {
  return basename(fileName).replace(/\.[^.]+$/u, '');
}

function basename(fileName: string): string {
  return String(fileName || '').split('/').pop() || String(fileName || '');
}

function getImageMimeType(fileName: string): string {
  const ext = extensionOf(fileName);
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'avif') return 'image/avif';
  return 'application/octet-stream';
}

function resolvePath(basePath: string, relativePath: string): string {
  if (!basePath.includes('/')) return relativePath.replace(/^\.\//u, '');
  const parts = basePath.split('/');
  parts.pop();
  for (const segment of relativePath.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

function cleanTitle(value: unknown, fallback: string): string {
  const title = String(value ?? '').replace(/\s+/g, ' ').trim();
  return title.length > 0 ? Array.from(title).slice(0, 80).join('') : fallback;
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
