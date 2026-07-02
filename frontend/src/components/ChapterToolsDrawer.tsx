/**
 * Chapter tools drawer: secondary chapter tools that should not replace the
 * main editor board.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Chapter } from '../types/index.js';
import { ChapterBlueprintPanel } from './ChapterBlueprintPanel.js';
import { Icon } from './Icon.js';
import './components.css';

export type ChapterToolsTab = 'blueprint' | 'report';

export interface ChapterToolsDrawerProps {
  chapter: Chapter | null;
  initialTab?: ChapterToolsTab;
  onAdoptChapterContent?: (content: string) => void;
  onClose: () => void;
  onError?: (error: unknown) => void;
}

export function ChapterToolsDrawer({
  chapter,
  initialTab = 'blueprint',
  onAdoptChapterContent,
  onClose,
  onError,
}: ChapterToolsDrawerProps): JSX.Element | null {
  const [tab, setTab] = useState<ChapterToolsTab>(initialTab);

  useEffect(() => {
    if (chapter) setTab(initialTab);
  }, [chapter?.id, initialTab]);

  if (chapter === null) return null;

  return createPortal(
    <div className="nwa-drawer-overlay" onClick={onClose}>
      <div
        className="nwa-drawer nwa-drawer--right"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label={`章节工具：${chapter.title}`}
        aria-modal="true"
      >
        <div className="nwa-drawer__header">
          <div className="nwa-drawer__title">
            <span className="nwa-drawer__icon"><Icon name="puzzle" /></span>
            <span>{chapter.title}</span>
          </div>
          <button
            type="button"
            className="nwa-button nwa-button--icon"
            onClick={onClose}
            aria-label="关闭章节工具"
            title="关闭"
          >
            <Icon name="x" />
          </button>
        </div>

        <div className="nwa-drawer__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'blueprint'}
            className={`nwa-drawer__tab${tab === 'blueprint' ? ' nwa-drawer__tab--active' : ''}`}
            onClick={() => setTab('blueprint')}
          >
            蓝图
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'report'}
            className={`nwa-drawer__tab${tab === 'report' ? ' nwa-drawer__tab--active' : ''}`}
            onClick={() => setTab('report')}
          >
            报告
          </button>
        </div>

        <div className="nwa-drawer__body">
          {tab === 'blueprint' ? (
            <ChapterBlueprintPanel
              key={chapter.id}
              chapterId={chapter.id}
              onAdoptChapterContent={onAdoptChapterContent}
              onError={onError}
            />
          ) : (
            <div className="nwa-drawer__hint">
              <p className="nwa-muted">
                字数检查与节奏检查在蓝图页内触发，生成后会保留在对应蓝图工具中。
              </p>
              <button
                type="button"
                className="nwa-button nwa-button--ghost"
                onClick={() => setTab('blueprint')}
              >
                前往蓝图
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default ChapterToolsDrawer;
