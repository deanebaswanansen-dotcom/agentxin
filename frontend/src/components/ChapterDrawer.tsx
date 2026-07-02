/**
 * 章节详情抽屉 —— 从右侧滑出，承载正文编辑 / 蓝图 / 报告。
 *
 * 复用：
 *  - ChapterEditor（正文 tab，imperative handle 完整保留，用于"采用"写回）
 *  - ChapterBlueprintPanel（蓝图 tab，含蓝图生成/场景写作/字数节奏检查/合并整章）
 *
 * 抽屉通过 forwardRef 暴露 editorRef，让父组件（App）的 handleAdopt 能定位到抽屉内的编辑器。
 */
import { forwardRef, useEffect, useRef, useState, type ForwardedRef } from 'react';
import { createPortal } from 'react-dom';
import type { Chapter, Id } from '../types/index.js';
import {
  ChapterEditor,
  type ChapterEditorHandle,
  type EditorSelection,
} from './ChapterEditor.js';
import { ChapterBlueprintPanel } from './ChapterBlueprintPanel.js';
import { Icon } from './Icon.js';
import './components.css';

export type ChapterDrawerTab = 'content' | 'blueprint' | 'report';

export interface ChapterDrawerProps {
  /** 当前章节；为 null 时不显示抽屉。 */
  chapter: Chapter | null;
  /** 当抽屉内编辑器内容变化时同步给父组件（用于对话采用定位）。 */
  onContentChange?: (content: string) => void;
  onSelectionChange?: (selection: EditorSelection) => void;
  /** 编辑器保存成功。 */
  onSaved?: (chapterId: Id, content: string) => void;
  /** 蓝图模块"采用整章"时把内容写回（经父组件统一处理）。 */
  onAdoptChapterContent?: (content: string) => void;
  /** 关闭抽屉。 */
  onClose: () => void;
  onError?: (error: unknown) => void;
}

function ChapterDrawerInner(
  {
    chapter,
    onContentChange,
    onSelectionChange,
    onSaved,
    onAdoptChapterContent,
    onClose,
    onError,
  }: ChapterDrawerProps,
  ref: ForwardedRef<ChapterEditorHandle>,
): JSX.Element | null {
  const [tab, setTab] = useState<ChapterDrawerTab>('content');
  const editorRef = useRef<ChapterEditorHandle | null>(null);

  // 把内部的 editorRef 同时转发给父组件传入的 ref
  useEffect(() => {
    if (typeof ref === 'function') {
      ref(editorRef.current);
    } else if (ref) {
      (ref as React.MutableRefObject<ChapterEditorHandle | null>).current = editorRef.current;
    }
  });

  // 章节切换时回到正文 tab
  useEffect(() => {
    if (chapter) setTab('content');
  }, [chapter?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (chapter === null) return null;

  const TABS: Array<{ key: ChapterDrawerTab; label: string }> = [
    { key: 'content', label: '正文' },
    { key: 'blueprint', label: '蓝图' },
    { key: 'report', label: '报告' },
  ];

  return createPortal(
    <div className="nwa-drawer-overlay" onClick={onClose}>
      <div
        className="nwa-drawer nwa-drawer--right"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`章节详情：${chapter.title}`}
        aria-modal="true"
      >
        <div className="nwa-drawer__header">
          <div className="nwa-drawer__title">
            <span className="nwa-drawer__icon"><Icon name="fileText" /></span>
            <span>{chapter.title}</span>
          </div>
          <button
            type="button"
            className="nwa-button nwa-button--icon"
            onClick={onClose}
            aria-label="关闭抽屉"
            title="关闭"
          >
            <Icon name="x" />
          </button>
        </div>

        <div className="nwa-drawer__tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`nwa-drawer__tab${tab === t.key ? ' nwa-drawer__tab--active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="nwa-drawer__body">
          {tab === 'content' ? (
            <ChapterEditor
              ref={editorRef}
              chapter={chapter}
              onContentChange={onContentChange}
              onSelectionChange={onSelectionChange}
              onSaved={onSaved}
              onError={onError}
              autoSaveDelayMs={1500}
            />
          ) : null}

          {tab === 'blueprint' ? (
            <ChapterBlueprintPanel
              key={chapter.id}
              chapterId={chapter.id}
              onAdoptChapterContent={onAdoptChapterContent}
              onError={onError}
            />
          ) : null}

          {tab === 'report' ? (
            <div className="nwa-drawer__hint">
              <p className="nwa-muted">
                字数检查与节奏检查在「蓝图」标签内触发；生成后可在此查看，或直接在蓝图标签操作。
                切换到「蓝图」标签开始。
              </p>
              <button
                type="button"
                className="nwa-button nwa-button--ghost"
                onClick={() => setTab('blueprint')}
              >
                前往蓝图
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export const ChapterDrawer = forwardRef<ChapterEditorHandle, ChapterDrawerProps>(ChapterDrawerInner);
ChapterDrawer.displayName = 'ChapterDrawer';

export default ChapterDrawer;
