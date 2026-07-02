import type { ReaderBook } from './readerImport.js';

export interface ReaderShelfItem {
  id: string;
  book: ReaderBook;
  savedAt: string;
  lastOpenedAt: string;
  linkedProjectId?: string;
  origin?: ReaderShelfOrigin;
  tags?: string[];
}

export interface ReaderProgress {
  bookId: string;
  chapterIndex: number;
  updatedAt: string;
}

export interface ReaderSession {
  bookId: string;
  chapterIndex: number;
  lastOpenedAt: string;
}

export interface ReaderRecentItem {
  bookId: string;
  title: string;
  detail: string;
  savedAt: string;
}

export interface ReaderBookmark {
  bookId: string;
  chapterId: string;
  chapterIndex: number;
  chapterTitle: string;
  excerpt: string;
  savedAt: string;
}

export interface ReaderSettings {
  theme: 'paper' | 'dark' | 'sepia';
  fontSize: number;
  lineHeight: number;
  readerWidth: number;
  comicWidth: number;
}

export interface ReaderShelfOrigin {
  kind: 'file' | 'directory' | 'project';
  path?: string;
  directoryName?: string;
}

export interface ReaderOutputTarget {
  name: string;
  updatedAt: string;
}

const SHELF_KEY = 'nwa:reader-shelf:v1';
const PROGRESS_KEY = 'nwa:reader-progress:v1';
const OUTPUT_TARGET_KEY = 'nwa:reader-output-target:v1';
const SESSION_KEY = 'nwa:reader-session:v1';
const RECENT_KEY = 'nwa:reader-recent:v1';
const BOOKMARK_KEY = 'nwa:reader-bookmarks:v1';
const SETTINGS_KEY = 'nwa:reader-settings:v1';
const DB_NAME = 'agentxin-reader-library';
const DB_VERSION = 1;
const DB_STORE = 'books';
const DB_MIGRATION_KEY = 'nwa:reader-idb-migrated:v1';

export const defaultReaderSettings: ReaderSettings = {
  theme: 'paper',
  fontSize: 20,
  lineHeight: 1.9,
  readerWidth: 920,
  comicWidth: 88,
};

export function loadReaderShelf(storage: Storage = window.localStorage): ReaderShelfItem[] {
  return readJson<ReaderShelfItem[]>(storage, SHELF_KEY, []).filter(isShelfItem);
}

export function saveReaderShelfItem(
  book: ReaderBook,
  storage: Storage = window.localStorage,
  metadata: Pick<ReaderShelfItem, 'origin' | 'tags'> = {},
): ReaderShelfItem {
  const now = new Date().toISOString();
  const current = loadReaderShelf(storage);
  const existingIndex = current.findIndex((item) => item.id === book.id);
  const item: ReaderShelfItem = {
    id: book.id,
    book: { ...book, updatedAt: now },
    savedAt: existingIndex >= 0 ? current[existingIndex]!.savedAt : now,
    lastOpenedAt: now,
    linkedProjectId: book.linkedProjectId ?? current[existingIndex]?.linkedProjectId,
    origin: metadata.origin ?? current[existingIndex]?.origin,
    tags: metadata.tags ?? current[existingIndex]?.tags,
  };
  const next = existingIndex >= 0
    ? current.map((entry, index) => (index === existingIndex ? item : entry))
    : [item, ...current];
  storage.setItem(SHELF_KEY, JSON.stringify(next));
  return item;
}

export function touchReaderShelfItem(
  id: string,
  storage: Storage = window.localStorage,
): ReaderShelfItem | null {
  const current = loadReaderShelf(storage);
  const item = current.find((entry) => entry.id === id);
  if (!item) return null;
  const nextItem = { ...item, lastOpenedAt: new Date().toISOString() };
  storage.setItem(
    SHELF_KEY,
    JSON.stringify(current.map((entry) => (entry.id === id ? nextItem : entry))),
  );
  return nextItem;
}

export function updateReaderShelfBook(
  id: string,
  updater: (book: ReaderBook) => ReaderBook,
  storage: Storage = window.localStorage,
): ReaderShelfItem | null {
  const current = loadReaderShelf(storage);
  const item = current.find((entry) => entry.id === id);
  if (!item) return null;
  const now = new Date().toISOString();
  const nextBook = updater(item.book);
  const nextItem: ReaderShelfItem = {
    ...item,
    book: { ...nextBook, updatedAt: now },
    linkedProjectId: nextBook.linkedProjectId ?? item.linkedProjectId,
    lastOpenedAt: now,
  };
  storage.setItem(
    SHELF_KEY,
    JSON.stringify(current.map((entry) => (entry.id === id ? nextItem : entry))),
  );
  return nextItem;
}

export function removeReaderShelfItem(id: string, storage: Storage = window.localStorage): void {
  storage.setItem(SHELF_KEY, JSON.stringify(loadReaderShelf(storage).filter((item) => item.id !== id)));
}

export async function loadReaderShelfStore(storage: Storage = window.localStorage): Promise<ReaderShelfItem[]> {
  const db = await openReaderShelfDb();
  if (!db) return loadReaderShelf(storage);
  await migrateLocalShelfToDb(db, storage);
  const items = await idbGetAll(db);
  return items.filter(isShelfItem).sort((left, right) => Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt));
}

export async function saveReaderShelfItemStore(
  book: ReaderBook,
  storage: Storage = window.localStorage,
  metadata: Pick<ReaderShelfItem, 'origin' | 'tags'> = {},
): Promise<ReaderShelfItem> {
  const db = await openReaderShelfDb();
  if (!db) return saveReaderShelfItem(book, storage, metadata);
  await migrateLocalShelfToDb(db, storage);
  const now = new Date().toISOString();
  const current = await idbGetAll(db);
  const existing = current.find((item) => item.id === book.id);
  const item: ReaderShelfItem = {
    id: book.id,
    book: { ...book, updatedAt: now },
    savedAt: existing?.savedAt ?? now,
    lastOpenedAt: now,
    linkedProjectId: book.linkedProjectId ?? existing?.linkedProjectId,
    origin: metadata.origin ?? existing?.origin,
    tags: metadata.tags ?? existing?.tags,
  };
  await idbPut(db, item);
  return item;
}

export async function touchReaderShelfItemStore(
  id: string,
  storage: Storage = window.localStorage,
): Promise<ReaderShelfItem | null> {
  const db = await openReaderShelfDb();
  if (!db) return touchReaderShelfItem(id, storage);
  await migrateLocalShelfToDb(db, storage);
  const item = await idbGet(db, id);
  if (!item || !isShelfItem(item)) return null;
  const nextItem = { ...item, lastOpenedAt: new Date().toISOString() };
  await idbPut(db, nextItem);
  return nextItem;
}

export async function updateReaderShelfBookStore(
  id: string,
  updater: (book: ReaderBook) => ReaderBook,
  storage: Storage = window.localStorage,
): Promise<ReaderShelfItem | null> {
  const db = await openReaderShelfDb();
  if (!db) return updateReaderShelfBook(id, updater, storage);
  await migrateLocalShelfToDb(db, storage);
  const item = await idbGet(db, id);
  if (!item || !isShelfItem(item)) return null;
  const now = new Date().toISOString();
  const nextBook = updater(item.book);
  const nextItem: ReaderShelfItem = {
    ...item,
    book: { ...nextBook, updatedAt: now },
    linkedProjectId: nextBook.linkedProjectId ?? item.linkedProjectId,
    lastOpenedAt: now,
  };
  await idbPut(db, nextItem);
  return nextItem;
}

export async function removeReaderShelfItemStore(
  id: string,
  storage: Storage = window.localStorage,
): Promise<void> {
  const db = await openReaderShelfDb();
  if (!db) {
    removeReaderShelfItem(id, storage);
    return;
  }
  await migrateLocalShelfToDb(db, storage);
  await idbDelete(db, id);
}

export function loadReaderProgress(
  bookId: string,
  storage: Storage = window.localStorage,
): ReaderProgress | null {
  const records = readJson<Record<string, ReaderProgress>>(storage, PROGRESS_KEY, {});
  return records[bookId] ?? null;
}

export function saveReaderProgress(
  bookId: string,
  chapterIndex: number,
  storage: Storage = window.localStorage,
): ReaderProgress {
  const records = readJson<Record<string, ReaderProgress>>(storage, PROGRESS_KEY, {});
  const progress: ReaderProgress = {
    bookId,
    chapterIndex: Math.max(0, Math.round(chapterIndex)),
    updatedAt: new Date().toISOString(),
  };
  storage.setItem(PROGRESS_KEY, JSON.stringify({ ...records, [bookId]: progress }));
  return progress;
}

export function loadReaderSession(storage: Storage = window.localStorage): ReaderSession | null {
  const session = readJson<ReaderSession | null>(storage, SESSION_KEY, null);
  return session && typeof session.bookId === 'string' ? session : null;
}

export function saveReaderSession(
  bookId: string,
  chapterIndex: number,
  storage: Storage = window.localStorage,
): ReaderSession {
  const session = {
    bookId,
    chapterIndex: Math.max(0, Math.round(chapterIndex)),
    lastOpenedAt: new Date().toISOString(),
  };
  storage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function loadReaderRecent(storage: Storage = window.localStorage): ReaderRecentItem[] {
  return readJson<ReaderRecentItem[]>(storage, RECENT_KEY, []).filter((item) => (
    item && typeof item.bookId === 'string' && typeof item.title === 'string'
  ));
}

export function saveReaderRecent(
  item: Omit<ReaderRecentItem, 'savedAt'>,
  storage: Storage = window.localStorage,
): ReaderRecentItem {
  const recent = { ...item, savedAt: new Date().toISOString() };
  const next = [
    recent,
    ...loadReaderRecent(storage).filter((entry) => entry.bookId !== item.bookId),
  ].slice(0, 12);
  storage.setItem(RECENT_KEY, JSON.stringify(next));
  return recent;
}

export function loadReaderBookmarks(bookId: string, storage: Storage = window.localStorage): ReaderBookmark[] {
  const records = readJson<Record<string, ReaderBookmark[]>>(storage, BOOKMARK_KEY, {});
  const items = records[bookId];
  return Array.isArray(items) ? items.filter((item) => typeof item.chapterId === 'string') : [];
}

export function toggleReaderBookmark(
  bookmark: Omit<ReaderBookmark, 'savedAt'>,
  storage: Storage = window.localStorage,
): boolean {
  const records = readJson<Record<string, ReaderBookmark[]>>(storage, BOOKMARK_KEY, {});
  const current = Array.isArray(records[bookmark.bookId]) ? records[bookmark.bookId]! : [];
  const exists = current.some((item) => item.chapterId === bookmark.chapterId);
  records[bookmark.bookId] = exists
    ? current.filter((item) => item.chapterId !== bookmark.chapterId)
    : [{ ...bookmark, savedAt: new Date().toISOString() }, ...current];
  storage.setItem(BOOKMARK_KEY, JSON.stringify(records));
  return !exists;
}

export function removeReaderBookmark(
  bookId: string,
  chapterId: string,
  storage: Storage = window.localStorage,
): void {
  const records = readJson<Record<string, ReaderBookmark[]>>(storage, BOOKMARK_KEY, {});
  const current = Array.isArray(records[bookId]) ? records[bookId]! : [];
  records[bookId] = current.filter((item) => item.chapterId !== chapterId);
  storage.setItem(BOOKMARK_KEY, JSON.stringify(records));
}

export function loadReaderSettings(storage: Storage = window.localStorage): ReaderSettings {
  const stored = readJson<Partial<ReaderSettings>>(storage, SETTINGS_KEY, {});
  return normalizeReaderSettings({ ...defaultReaderSettings, ...stored });
}

export function saveReaderSettings(
  next: ReaderSettings,
  storage: Storage = window.localStorage,
): ReaderSettings {
  const normalized = normalizeReaderSettings(next);
  storage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

export function loadReaderOutputTarget(storage: Storage = window.localStorage): ReaderOutputTarget | null {
  const target = readJson<ReaderOutputTarget | null>(storage, OUTPUT_TARGET_KEY, null);
  return target && typeof target.name === 'string' ? target : null;
}

export function saveReaderOutputTarget(
  name: string,
  storage: Storage = window.localStorage,
): ReaderOutputTarget {
  const target = { name, updatedAt: new Date().toISOString() };
  storage.setItem(OUTPUT_TARGET_KEY, JSON.stringify(target));
  return target;
}

function readJson<T>(storage: Storage, key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeReaderSettings(value: ReaderSettings): ReaderSettings {
  const theme = value.theme === 'dark' || value.theme === 'sepia' ? value.theme : 'paper';
  return {
    theme,
    fontSize: clampNumber(value.fontSize, 16, 30, defaultReaderSettings.fontSize),
    lineHeight: clampNumber(value.lineHeight, 1.5, 2.4, defaultReaderSettings.lineHeight),
    readerWidth: clampNumber(value.readerWidth, 720, 1100, defaultReaderSettings.readerWidth),
    comicWidth: clampNumber(value.comicWidth, 70, 100, defaultReaderSettings.comicWidth),
  };
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function openReaderShelfDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || typeof window.indexedDB === 'undefined') return null;
  return new Promise((resolve) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
  });
}

async function migrateLocalShelfToDb(db: IDBDatabase, storage: Storage): Promise<void> {
  if (storage.getItem(DB_MIGRATION_KEY) === '1') return;
  const legacy = loadReaderShelf(storage);
  for (const item of legacy) {
    await idbPut(db, item);
  }
  storage.setItem(DB_MIGRATION_KEY, '1');
}

async function idbGetAll(db: IDBDatabase): Promise<ReaderShelfItem[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const request = tx.objectStore(DB_STORE).getAll();
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result as ReaderShelfItem[] : []);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(db: IDBDatabase, id: string): Promise<ReaderShelfItem | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const request = tx.objectStore(DB_STORE).get(id);
    request.onsuccess = () => resolve(request.result as ReaderShelfItem | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(db: IDBDatabase, item: ReaderShelfItem): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const request = tx.objectStore(DB_STORE).put(item);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? request.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function idbDelete(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const request = tx.objectStore(DB_STORE).delete(id);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? request.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function isShelfItem(value: unknown): value is ReaderShelfItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as ReaderShelfItem;
  return typeof item.id === 'string'
    && typeof item.savedAt === 'string'
    && typeof item.lastOpenedAt === 'string'
    && typeof item.book?.title === 'string'
    && Array.isArray(item.book?.chapters);
}
