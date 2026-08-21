/**
 * Chapter editor (task 12.5, Requirements 8.3, 8.4).
 *
 * Displays the selected chapter's content in an editable textarea
 * (Requirement 8.3) and, when the user triggers a save, submits a content
 * update request to the backend via `apiClient.chapters.updateContent`
 * (Requirement 8.4). Backend/runtime failures are surfaced through the
 * injected `onError` callback so the global error UI can show the reason
 * (Requirement 8.6).
 *
 * State ownership: the editor owns its editable content internally, seeded
 * from the `chapter` prop. Selecting a different chapter (a new `chapter.id`)
 * reloads the editor with that chapter's content. The shared {@link apiClient}
 * is injectable via the `client` prop to ease testing.
 *
 * Composition: to let the ChatPanel (task 12.6) insert (continue) or replace
 * (rewrite/polish) generated text at the caret/selection (Requirement 6.4),
 * the editor reports the current selection via `onSelectionChange`, mirrors
 * content via `onContentChange`, and accepts state-driven `contentOverride`
 * and `selectionRequest` props from the app shell.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ForwardedRef,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import apiClient from '../api/apiClient.js';
import {
  listChapterSnapshots,
  saveChapterSnapshot,
  type ChapterSnapshot,
} from '../lib/chapterSnapshots.js';
import type { Chapter, Id } from '../types/index.js';
import { EmptyIllustration } from './EmptyIllustration.js';
import { Icon } from './Icon.js';
import './components.css';

/** A half-open selection range within the editor content: `[start, end)`. */
export interface EditorSelection {
  start: number;
  end: number;
}

export interface EditorSelectionRequest extends EditorSelection {
  revision: number;
}

/** Imperative API exposed via `ref` for composition (e.g. by ChatPanel wiring). */
export interface ChapterEditorHandle {
  /** Current selection range; collapses to the caret when nothing is selected. */
  getSelection(): EditorSelection;
  /** Programmatically set the selection range. */
  setSelection(start: number, end: number): void;
  /** Focus the underlying textarea. */
  focus(): void;
  /** Read the current editable content. */
  getContent(): string;
  /** Replace the editable content (e.g. after a ChatPanel "采用" action). */
  setContent(next: string): void;
  /** Persist unsaved edits before the parent navigates away. */
  saveIfDirty(): Promise<void>;
}

/** Minimal client surface this editor depends on (eases testing). */
export type ChapterEditorClient = Pick<typeof apiClient, 'chapters'>;

export interface ChapterEditorProps {
  /**
   * The chapter to display and edit. `null` renders an empty placeholder
   * state. A change in `chapter.id` reloads the editor content (Requirement 8.3).
   */
  chapter: Chapter | null;
  /** Invoked after a successful save with the saved chapter id and content. */
  onSaved?: (chapterId: Id, content: string) => void;
  /** Invoked when the user clicks the close (X) button. */
  onClose?: () => void;
  /** Invoked with the next content on each edit (for mirroring/composition). */
  onContentChange?: (content: string) => void;
  /** Replaces the editable content from an owning app state update. */
  contentOverride?: string;
  /** Moves focus/selection after an owning app state update. */
  selectionRequest?: EditorSelectionRequest | null;
  /** Reports the current selection range as it changes (for adoption targeting). */
  onSelectionChange?: (selection: EditorSelection) => void;
  /** Surface a backend/runtime error to the global error UI (Requirement 8.6). */
  onError?: (error: unknown) => void;
  /**
   * When set (> 0), unsaved changes are auto-saved after this many ms of
   * inactivity, in addition to the explicit save button / Ctrl+S.
   */
  autoSaveDelayMs?: number;
  /** Injectable client (defaults to the shared {@link apiClient}). */
  client?: ChapterEditorClient;
  /** Placeholder text for an empty editor. */
  placeholder?: string;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

interface EditorHistory {
  past: string[];
  future: string[];
}

const MAX_EDITOR_HISTORY = 100;

function trimHistory(entries: string[]): string[] {
  return entries.slice(-MAX_EDITOR_HISTORY);
}

function trimFuture(entries: string[]): string[] {
  return entries.slice(0, MAX_EDITOR_HISTORY);
}

function countWords(content: string): number {
  const cjkCount = content.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const latinCount = content
    .replace(/[\u3400-\u9fff]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return cjkCount + latinCount;
}

function formatSnapshotTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type MarkdownMode = 'write' | 'split' | 'preview';

function renderInlineMarkdown(text: string, keyPrefix = 'inline'): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*([^*]+)\*\*|\*([^*\n]+)\*)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }

    if (match[2] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-strong-${match.index}`}>{match[2]}</strong>);
    } else {
      nodes.push(<em key={`${keyPrefix}-em-${match.index}`}>{match[3]}</em>);
    }
    cursor = pattern.lastIndex;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes.length > 0 ? nodes : [text];
}

function isMarkdownBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('```') ||
    /^(#{1,3})\s+/.test(line) ||
    /^-{3,}$/.test(trimmed) ||
    /^>\s?/.test(line) ||
    /^\s*[-*]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line)
  );
}

function MarkdownPreview({ content }: { content: string }): JSX.Element {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: JSX.Element[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === '') {
      index += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre key={`code-${index}`} className="nwa-markdown-preview__code">
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line);
    if (headingMatch !== null) {
      const level = headingMatch[1].length;
      const HeadingTag = `h${Math.min(level + 2, 5)}` as keyof JSX.IntrinsicElements;
      blocks.push(
        <HeadingTag key={`heading-${index}`} className={`nwa-markdown-preview__heading nwa-markdown-preview__heading--${level}`}>
          {renderInlineMarkdown(headingMatch[2])}
        </HeadingTag>,
      );
      index += 1;
      continue;
    }

    if (/^-{3,}$/.test(trimmed)) {
      blocks.push(<hr key={`hr-${index}`} />);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${index}`}>
          {quoteLines.map((quoteLine, quoteIndex) => (
            <p key={`quote-line-${quoteIndex}`}>{renderInlineMarkdown(quoteLine)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ul key={`ul-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`ul-item-${itemIndex}`}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ol key={`ol-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`ol-item-${itemIndex}`}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() !== '' && !isMarkdownBlockStart(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={`paragraph-${index}`}>
        {paragraphLines.flatMap((paragraphLine, paragraphIndex) => [
          paragraphIndex > 0 ? <br key={`paragraph-break-${paragraphIndex}`} /> : null,
          ...renderInlineMarkdown(paragraphLine, `paragraph-${index}-${paragraphIndex}`),
        ])}
      </p>,
    );
  }

  if (blocks.length === 0) {
    return <p className="nwa-markdown-preview__empty">空正文</p>;
  }

  return <>{blocks}</>;
}

/**
 * Self-contained chapter content editor. Displays the selected chapter's
 * content (Requirement 8.3) and persists edits via the API client on save
 * (Requirement 8.4). Forwards a {@link ChapterEditorHandle} so callers can
 * read/set the content and selection imperatively.
 */
function ChapterEditorInner(
  {
    chapter,
    onSaved,
    onClose,
    onContentChange,
    contentOverride,
    selectionRequest,
    onSelectionChange,
    onError,
    autoSaveDelayMs,
    client = apiClient,
    placeholder = '在此撰写章节正文…',
  }: ChapterEditorProps,
  ref: ForwardedRef<ChapterEditorHandle>,
): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [content, setContentState] = useState<string>(chapter?.content ?? '');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [historySnapshot, setHistorySnapshot] = useState<EditorHistory>({ past: [], future: [] });
  const [snapshotModalOpen, setSnapshotModalOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<ChapterSnapshot[]>([]);
  const [markdownMode, setMarkdownMode] = useState<MarkdownMode>('write');
  const contentRef = useRef(content);
  const historyRef = useRef<EditorHistory>({ past: [], future: [] });
  const lastSavedContentRef = useRef(chapter?.content ?? '');
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  // Set when the selected chapter changes, so the layout effect below knows to
  // reset scroll/caret to the top *after* the new content is committed to the
  // DOM (a textarea value change otherwise pushes the caret to the end).
  const justSwitchedChapter = useRef(false);

  const chapterId = chapter?.id ?? null;
  const chapterIdRef = useRef<Id | null>(chapterId);
  chapterIdRef.current = chapterId;

  const updateHistory = useCallback((next: EditorHistory) => {
    historyRef.current = next;
    setHistorySnapshot(next);
  }, []);

  // Load the selected chapter's content into the editor (Requirement 8.3).
  // Keyed on the chapter id so switching chapters resets the editor, while
  // ongoing edits to the current chapter are preserved.
  useEffect(() => {
    const next = chapter?.content ?? '';
    contentRef.current = next;
    lastSavedContentRef.current = next;
    setContentState(next);
    setDirty(false);
    setSnapshotModalOpen(false);
    setSnapshots(chapter?.id ? listChapterSnapshots(chapter.id) : []);
    const emptyHistory = { past: [], future: [] };
    historyRef.current = emptyHistory;
    setHistorySnapshot(emptyHistory);
    justSwitchedChapter.current = true;
    // We intentionally reset only when the selected chapter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId]);

  // After the (new chapter's) content is committed to the DOM, reset scroll
  // position and caret to the top so a newly opened chapter never inherits the
  // previous chapter's scroll offset (the "chapter 2 starts from the middle"
  // bug). Gated by `justSwitchedChapter` so ordinary typing/adoption — which
  // also change `content` — never moves the user's caret.
  useLayoutEffect(() => {
    if (!justSwitchedChapter.current) return;
    justSwitchedChapter.current = false;
    const el = textareaRef.current;
    if (el === null) return;
    el.scrollTop = 0;
    try {
      el.setSelectionRange(0, 0);
    } catch {
      // setSelectionRange can throw on detached nodes; ignore.
    }
  }, [content]);

  useLayoutEffect(() => {
    if (contentOverride === undefined || contentOverride === contentRef.current) return;
    const current = contentRef.current;
    const currentHistory = historyRef.current;
    updateHistory({
      past: trimHistory([...currentHistory.past, current]),
      future: [],
    });
    contentRef.current = contentOverride;
    setContentState(contentOverride);
    setDirty(contentOverride !== lastSavedContentRef.current);
  }, [contentOverride, updateHistory]);

  useEffect(() => {
    if (selectionRequest === null || selectionRequest === undefined) return;
    const timer = window.setTimeout(() => {
      const el = textareaRef.current;
      if (el === null) return;
      const max = contentRef.current.length;
      const start = Math.max(0, Math.min(selectionRequest.start, max));
      const end = Math.max(start, Math.min(selectionRequest.end, max));
      el.focus();
      el.setSelectionRange(start, end);
      onSelectionChange?.({ start, end });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [onSelectionChange, selectionRequest]);

  const commitEditableContent = useCallback(
    (next: string) => {
      contentRef.current = next;
      setContentState(next);
      setDirty(true);
      onContentChange?.(next);
    },
    [onContentChange],
  );

  const moveCaretToEnd = useCallback(
    (next: string) => {
      window.setTimeout(() => {
        const el = textareaRef.current;
        if (el === null) return;
        const position = next.length;
        el.focus();
        el.setSelectionRange(position, position);
        onSelectionChange?.({ start: position, end: position });
      }, 0);
    },
    [onSelectionChange],
  );

  const restoreEditorSelection = useCallback(
    (start: number, end: number) => {
      window.setTimeout(() => {
        const el = textareaRef.current;
        if (el === null) return;
        el.focus();
        el.setSelectionRange(start, end);
        onSelectionChange?.({ start, end });
      }, 0);
    },
    [onSelectionChange],
  );

  const replaceEditorRange = useCallback(
    (start: number, end: number, replacement: string, nextSelection: EditorSelection) => {
      const current = contentRef.current;
      const next = `${current.slice(0, start)}${replacement}${current.slice(end)}`;
      if (next !== current) {
        const currentHistory = historyRef.current;
        updateHistory({
          past: trimHistory([...currentHistory.past, current]),
          future: [],
        });
        commitEditableContent(next);
      }
      restoreEditorSelection(nextSelection.start, nextSelection.end);
    },
    [commitEditableContent, restoreEditorSelection, updateHistory],
  );

  const formatInlineSelection = useCallback(
    (prefix: string, suffix: string, placeholder: string) => {
      const current = contentRef.current;
      const el = textareaRef.current;
      const start = el?.selectionStart ?? current.length;
      const end = el?.selectionEnd ?? current.length;
      const selected = current.slice(start, end);
      const body = selected.length > 0 ? selected : placeholder;
      const replacement = `${prefix}${body}${suffix}`;
      replaceEditorRange(start, end, replacement, {
        start: start + prefix.length,
        end: start + prefix.length + body.length,
      });
    },
    [replaceEditorRange],
  );

  const formatHeading = useCallback(() => {
    const current = contentRef.current;
    const el = textareaRef.current;
    const position = el?.selectionStart ?? current.length;
    const lineStart = current.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
    const nextBreak = current.indexOf('\n', position);
    const lineEnd = nextBreak === -1 ? current.length : nextBreak;
    const line = current.slice(lineStart, lineEnd);
    const body = line.replace(/^#{1,6}\s+/, '') || '小节标题';
    const replacement = `## ${body}`;
    replaceEditorRange(lineStart, lineEnd, replacement, {
      start: lineStart + 3,
      end: lineStart + 3 + body.length,
    });
  }, [replaceEditorRange]);

  const formatLinePrefix = useCallback(
    (prefix: string, placeholder: string) => {
      const current = contentRef.current;
      const el = textareaRef.current;
      const start = el?.selectionStart ?? current.length;
      const end = el?.selectionEnd ?? current.length;
      const lineStart = current.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
      const nextBreak = current.indexOf('\n', end);
      const lineEnd = nextBreak === -1 ? current.length : nextBreak;
      const selectedBlock = current.slice(lineStart, lineEnd) || placeholder;
      const replacement = selectedBlock
        .split('\n')
        .map((line) => {
          const cleanLine = line.replace(/^\s*(>\s?|[-*]\s+|\d+\.\s+)/, '');
          return `${prefix}${cleanLine || placeholder}`;
        })
        .join('\n');
      replaceEditorRange(lineStart, lineEnd, replacement, {
        start: lineStart + prefix.length,
        end: lineStart + replacement.length,
      });
    },
    [replaceEditorRange],
  );

  const applyContent = useCallback(
    (next: string, recordHistory = true) => {
      const current = contentRef.current;
      if (next === current) return;
      if (recordHistory) {
        const currentHistory = historyRef.current;
        updateHistory({
          past: trimHistory([...currentHistory.past, current]),
          future: [],
        });
      }
      commitEditableContent(next);
    },
    [commitEditableContent, updateHistory],
  );

  const undo = useCallback(() => {
    const currentHistory = historyRef.current;
    const previous = currentHistory.past[currentHistory.past.length - 1];
    if (previous === undefined) return;
    updateHistory({
      past: currentHistory.past.slice(0, -1),
      future: trimFuture([contentRef.current, ...currentHistory.future]),
    });
    commitEditableContent(previous);
    moveCaretToEnd(previous);
  }, [commitEditableContent, moveCaretToEnd, updateHistory]);

  const redo = useCallback(() => {
    const currentHistory = historyRef.current;
    const next = currentHistory.future[0];
    if (next === undefined) return;
    updateHistory({
      past: trimHistory([...currentHistory.past, contentRef.current]),
      future: currentHistory.future.slice(1),
    });
    commitEditableContent(next);
    moveCaretToEnd(next);
  }, [commitEditableContent, moveCaretToEnd, updateHistory]);

  const restoreSnapshot = useCallback(
    (snapshot: ChapterSnapshot) => {
      applyContent(snapshot.content);
      setSnapshotModalOpen(false);
    },
    [applyContent],
  );

  const reportSelection = useCallback(() => {
    const el = textareaRef.current;
        if (el === null || onSelectionChange === undefined) return;
    onSelectionChange({ start: el.selectionStart, end: el.selectionEnd });
  }, [onSelectionChange]);

  // Serialize saves and keep flushing until the latest edit is persisted. This
  // matters when navigation is requested while an autosave is still running:
  // the in-flight version is awaited first, then any text typed after it is
  // saved in a second request before navigation may continue.
  const persistLatest = useCallback(async (force = false) => {
    if (chapterId === null) return;
    const targetChapterId = chapterId;
    let forceNextSave = force;

    while (chapterIdRef.current === targetChapterId) {
      const existingSave = saveInFlightRef.current;
      if (existingSave !== null) {
        await existingSave;
        forceNextSave = false;
        continue;
      }

      const current = contentRef.current;
      const previousSavedContent = lastSavedContentRef.current;
      if (!forceNextSave && current === previousSavedContent) {
        setDirty(false);
        return;
      }
      forceNextSave = false;

      const selectedChapter = chapter?.id === targetChapterId ? chapter : null;
      const request = (async () => {
        await client.chapters.updateContent(targetChapterId, current);
        if (selectedChapter !== null && previousSavedContent !== current) {
          saveChapterSnapshot(
            { id: selectedChapter.id, title: selectedChapter.title, content: previousSavedContent },
            '保存前',
          );
          setSnapshots(listChapterSnapshots(targetChapterId));
        }
        if (chapterIdRef.current === targetChapterId) {
          lastSavedContentRef.current = current;
          setDirty(contentRef.current !== current);
        }
        onSaved?.(targetChapterId, current);
      })();

      saveInFlightRef.current = request;
      setSaving(true);
      try {
        await request;
      } catch (error) {
        if (!isAbort(error)) onError?.(error);
        throw error;
      } finally {
        if (saveInFlightRef.current === request) {
          saveInFlightRef.current = null;
          setSaving(false);
        }
      }
    }
  }, [chapter, chapterId, client, onSaved, onError]);

  // Explicit saves report errors in the editor but do not create unhandled
  // promise rejections in click/keyboard/autosave event handlers.
  const save = useCallback(async () => {
    try {
      await persistLatest(true);
    } catch {
      // persistLatest already reported the error; keep the editor dirty.
    }
  }, [persistLatest]);

  useImperativeHandle(
    ref,
    (): ChapterEditorHandle => ({
      getSelection() {
        const el = textareaRef.current;
        if (el === null) {
          const length = contentRef.current.length;
          return { start: length, end: length };
        }
        return { start: el.selectionStart, end: el.selectionEnd };
      },
      setSelection(start, end) {
        const el = textareaRef.current;
        if (el === null) return;
        el.focus();
        el.setSelectionRange(start, end);
      },
      focus() {
        textareaRef.current?.focus();
      },
      getContent() {
        return contentRef.current;
      },
      setContent(next) {
        applyContent(next);
      },
      async saveIfDirty() {
        await persistLatest();
      },
    }),
    [applyContent, persistLatest],
  );

  // Optional debounced autosave for unsaved changes.
  useEffect(() => {
    if (autoSaveDelayMs === undefined || autoSaveDelayMs <= 0) return;
    if (chapterId === null || !dirty || saving) return;
    const handle = window.setTimeout(() => {
      void save();
    }, autoSaveDelayMs);
    return () => window.clearTimeout(handle);
  }, [autoSaveDelayMs, chapterId, dirty, saving, save]);

  const canUndo = historySnapshot.past.length > 0;
  const canRedo = historySnapshot.future.length > 0;
  const wordCount = countWords(content);
  const snapshotModal = snapshotModalOpen && chapterId !== null
    ? createPortal(
        <div className="nwa-modal-overlay">
          <div className="nwa-modal" role="dialog" aria-label="章节版本历史" aria-modal="true">
            <div className="nwa-modal-header">
              <h2><Icon name="refresh" /> 版本历史</h2>
              <button
                type="button"
                className="nwa-modal-close"
                onClick={() => setSnapshotModalOpen(false)}
                aria-label="关闭版本历史"
              >
                <Icon name="x" />
              </button>
            </div>
            <div className="nwa-modal-body">
              {snapshots.length === 0 ? (
                <p className="nwa-empty">还没有保存前快照。</p>
              ) : (
                <ul className="nwa-snapshot-list" aria-label="章节快照">
                  {snapshots.map((snapshot) => (
                    <li key={snapshot.id} className="nwa-snapshot-list__item">
                      <div className="nwa-snapshot-list__meta">
                        <strong>{snapshot.reason}</strong>
                        <span>{formatSnapshotTime(snapshot.createdAt)}</span>
                      </div>
                      <p>{snapshot.content.slice(0, 160) || '空正文'}</p>
                      <button
                        type="button"
                        className="nwa-button nwa-button--ghost"
                        onClick={() => restoreSnapshot(snapshot)}
                      >
                        恢复到编辑器
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <section className="nwa-panel" aria-label="章节编辑器" style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="nwa-row">
        <h2 className="nwa-panel__title nwa-grow" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {chapter !== null ? chapter.title : '章节编辑器'}
          {chapter !== null && dirty ? <span className="nwa-muted" style={{ fontSize: '12px' }}>未保存</span> : null}
        </h2>
        {chapter !== null ? (
          <span className="nwa-editor-count" aria-label="章节字数">
            {wordCount.toLocaleString()} 字
          </span>
        ) : null}
        <button
          type="button"
          className="nwa-button nwa-button--ghost"
          disabled={chapterId === null}
          onClick={() => setSnapshotModalOpen(true)}
        >
          历史 {snapshots.length}
        </button>
        <button
          type="button"
          className="nwa-button nwa-button--icon"
          disabled={!canUndo}
          onClick={undo}
          aria-label="撤销"
          title="撤销"
        >
          <Icon name="undo" />
        </button>
        <button
          type="button"
          className="nwa-button nwa-button--icon"
          disabled={!canRedo}
          onClick={redo}
          aria-label="重做"
          title="重做"
        >
          <Icon name="redo" />
        </button>
        <button
          type="button"
          className="nwa-button nwa-button--outline"
          disabled={chapterId === null || saving}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {onClose && (
          <button
            type="button"
            className="nwa-button nwa-button--icon"
            onClick={onClose}
            aria-label="关闭"
            title="关闭编辑器"
            style={{ padding: '4px 8px', minWidth: 'auto' }}
          >
            <Icon name="x" />
          </button>
        )}
      </div>
      {chapter === null ? (
        <div className="nwa-empty-visual">
          <EmptyIllustration variant="editor" />
          <p className="nwa-empty">请选择一个章节开始编辑。</p>
        </div>
      ) : (
        <div className="nwa-markdown-editor">
          <div className="nwa-markdown-toolbar" aria-label="Markdown 工具栏">
            <div className="nwa-markdown-toolbar__formats">
              <button
                type="button"
                className="nwa-button nwa-button--icon"
                aria-label="插入标题"
                title="插入标题"
                onMouseDown={(event) => event.preventDefault()}
                onClick={formatHeading}
              >
                <Icon name="formatHeading" />
              </button>
              <button
                type="button"
                className="nwa-button nwa-button--icon"
                aria-label="加粗"
                title="加粗"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => formatInlineSelection('**', '**', '重点文字')}
              >
                <Icon name="formatBold" />
              </button>
              <button
                type="button"
                className="nwa-button nwa-button--icon"
                aria-label="斜体"
                title="斜体"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => formatInlineSelection('*', '*', '强调文字')}
              >
                <Icon name="formatItalic" />
              </button>
              <button
                type="button"
                className="nwa-button nwa-button--icon"
                aria-label="引用"
                title="引用"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => formatLinePrefix('> ', '引用内容')}
              >
                <Icon name="formatQuote" />
              </button>
              <button
                type="button"
                className="nwa-button nwa-button--icon"
                aria-label="列表"
                title="列表"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => formatLinePrefix('- ', '列表项')}
              >
                <Icon name="formatList" />
              </button>
            </div>
            <div className="nwa-markdown-mode" role="group" aria-label="Markdown 显示模式">
              {(['write', 'split', 'preview'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`nwa-button nwa-button--ghost${markdownMode === mode ? ' is-active' : ''}`}
                  aria-pressed={markdownMode === mode}
                  onClick={() => setMarkdownMode(mode)}
                >
                  {mode === 'write' ? <Icon name="edit" /> : mode === 'split' ? <Icon name="panelRight" /> : <Icon name="bookOpen" />}
                  {mode === 'write' ? '编辑' : mode === 'split' ? '分屏' : '预览'}
                </button>
              ))}
            </div>
          </div>
          <div className={`nwa-markdown-workspace nwa-markdown-workspace--${markdownMode}`}>
            <div className="nwa-markdown-pane nwa-markdown-pane--editor">
              <textarea
                ref={textareaRef}
                className="nwa-textarea"
                aria-label="章节正文"
                value={content}
                placeholder={placeholder}
                onChange={(e) => applyContent(e.target.value)}
                onSelect={reportSelection}
                onKeyUp={reportSelection}
                onClick={reportSelection}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault();
                    void save();
                    return;
                  }
                  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
                    e.preventDefault();
                    undo();
                    return;
                  }
                  if (
                    ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') ||
                    ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'z')
                  ) {
                    e.preventDefault();
                    redo();
                  }
                }}
              />
            </div>
            <div className="nwa-markdown-pane nwa-markdown-pane--preview" aria-label="Markdown 预览">
              <MarkdownPreview content={content} />
            </div>
          </div>
        </div>
      )}
      {snapshotModal}
    </section>
  );
}

export const ChapterEditor = forwardRef<ChapterEditorHandle, ChapterEditorProps>(ChapterEditorInner);
ChapterEditor.displayName = 'ChapterEditor';

export default ChapterEditor;
