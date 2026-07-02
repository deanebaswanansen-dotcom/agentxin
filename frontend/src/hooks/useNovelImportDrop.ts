import { useCallback, useState, type DragEvent } from 'react';
import apiClient from '../api/apiClient.js';
import type { Id, ImportNovelFile } from '../types/index.js';

interface DroppedFileSystemEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath?: string;
}

interface DroppedFileEntry extends DroppedFileSystemEntry {
  file(success: (file: File) => void, failure?: (error: DOMException) => void): void;
}

interface DroppedDirectoryEntry extends DroppedFileSystemEntry {
  createReader(): {
    readEntries(
      success: (entries: DroppedFileSystemEntry[]) => void,
      failure?: (error: DOMException) => void,
    ): void;
  };
}

interface EntryDataTransferItem {
  webkitGetAsEntry?: () => DroppedFileSystemEntry | null;
}

interface UseNovelImportDropOptions {
  selectedProjectId: Id | null;
  reportError: (error: unknown) => void;
  bumpProjectList: () => void;
  loadChapter: (projectId: Id, chapterId: Id) => Promise<void>;
  selectProject: (projectId: Id) => void;
  selectCreatedProject: (projectId: Id, projectName: string) => void;
  openChaptersTab: () => void;
}

function isSupportedNovelPath(path: string): boolean {
  return /\.(md|markdown|txt)$/i.test(path);
}

function fileToImportFile(file: File, path?: string): Promise<ImportNovelFile | null> {
  const sourcePath = path || (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  if (!isSupportedNovelPath(sourcePath)) return Promise.resolve(null);
  return file.text().then((content) => ({ path: sourcePath, content }));
}

function readFileEntry(entry: DroppedFileEntry, pathPrefix: string): Promise<ImportNovelFile | null> {
  return new Promise((resolve, reject) => {
    entry.file(
      (file) => {
        void fileToImportFile(file, `${pathPrefix}${entry.name}`).then(resolve, reject);
      },
      reject,
    );
  });
}

function readDirectoryEntries(entry: DroppedDirectoryEntry): Promise<DroppedFileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: DroppedFileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const readBatch = (): void => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(entries);
            return;
          }
          entries.push(...batch);
          readBatch();
        },
        reject,
      );
    };
    readBatch();
  });
}

async function readEntry(entry: DroppedFileSystemEntry, pathPrefix = ''): Promise<ImportNovelFile[]> {
  if (entry.isFile) {
    const file = await readFileEntry(entry as DroppedFileEntry, pathPrefix);
    return file ? [file] : [];
  }
  if (entry.isDirectory) {
    const children = await readDirectoryEntries(entry as DroppedDirectoryEntry);
    const nested = await Promise.all(children.map((child) => readEntry(child, `${pathPrefix}${entry.name}/`)));
    return nested.flat();
  }
  return [];
}

async function collectDroppedNovelFiles(dataTransfer: DataTransfer): Promise<ImportNovelFile[]> {
  const itemEntries = Array.from(dataTransfer.items)
    .map((item) => (item as unknown as EntryDataTransferItem).webkitGetAsEntry?.() ?? null)
    .filter(isDroppedEntry);

  if (itemEntries.length > 0) {
    const nested = await Promise.all(itemEntries.map((entry) => readEntry(entry)));
    return nested.flat();
  }

  const files = await Promise.all(Array.from(dataTransfer.files).map((file) => fileToImportFile(file)));
  return files.filter((file): file is ImportNovelFile => file !== null);
}

function inferDroppedSourceName(files: ImportNovelFile[]): string {
  const first = files[0]?.path ?? '导入小说';
  const firstPart = first.split(/[\\/]/).filter(Boolean)[0] ?? first;
  return firstPart.replace(/\.(md|markdown|txt)$/i, '') || '导入小说';
}

function hasDraggedFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

function isDroppedEntry(value: unknown): value is DroppedFileSystemEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isFile' in value &&
    'isDirectory' in value &&
    'name' in value
  );
}

export function useNovelImportDrop({
  selectedProjectId,
  reportError,
  bumpProjectList,
  loadChapter,
  selectProject,
  selectCreatedProject,
  openChaptersTab,
}: UseNovelImportDropOptions) {
  const [importDragActive, setImportDragActive] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState('');

  const runImport = useCallback(
    async (files: ImportNovelFile[]) => {
      if (files.length === 0) {
        setImportMessage('没有识别到可整理的 Markdown 或 TXT 文件。');
        return;
      }
      setImportBusy(true);
      const sourceName = inferDroppedSourceName(files);
      try {
        let projectId = selectedProjectId;
        if (projectId === null) {
          const created = await apiClient.projects.create(sourceName);
          projectId = created.id;
          selectCreatedProject(created.id, sourceName);
        }

        const result = await apiClient.imports.organizeNovel(projectId, {
          sourceName,
          files,
        });
        bumpProjectList();
        openChaptersTab();
        setImportMessage(result.summary);
        if (result.firstChapterId !== undefined) {
          await loadChapter(projectId, result.firstChapterId);
        } else {
          selectProject(projectId);
        }
        window.setTimeout(() => setImportMessage(''), 4500);
      } catch (error) {
        reportError(error);
      } finally {
        setImportBusy(false);
        setImportDragActive(false);
      }
    },
    [bumpProjectList, loadChapter, openChaptersTab, reportError, selectCreatedProject, selectProject, selectedProjectId],
  );

  const handleDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setImportDragActive(true);
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setImportDragActive(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget === event.target) {
      setImportDragActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setImportDragActive(false);
      const files = await collectDroppedNovelFiles(event.dataTransfer);
      await runImport(files);
    },
    [runImport],
  );

  return {
    importDragActive,
    importBusy,
    importMessage,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
