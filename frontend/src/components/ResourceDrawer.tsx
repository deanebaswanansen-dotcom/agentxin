/**
 * 资料抽屉 —— 从左侧覆盖项目树，承载人物/世界观/大纲的 CRUD。
 *
 * 复用 ProjectWorkspaceView（它内部已经实现完整的 chapters/characters/world/outlines
 * 四 tab 增删改查 + 拖拽排序 + 应用内 Modal），这里只是把它包进抽屉并受控 tab。
 *
 * 章节相关的操作（新建/选中/重命名/删除）仍在抽屉内可见，但"选中章节"会触发父组件打开章节抽屉。
 */
import { createPortal } from 'react-dom';
import type { Chapter, Id } from '../types/index.js';
import { Icon } from './Icon.js';
import { ProjectWorkspaceView, type WorkspaceTab } from './ProjectWorkspaceView.js';
import './components.css';

export interface ResourceDrawerProps {
  projectId: Id | null;
  /** 受控 tab（由父组件根据 artifact 跳转设置）。 */
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  /** 选中章节（打开章节抽屉）。 */
  onSelectChapter?: (chapterId: Id) => void;
  onChapterDeleted?: (chapterId: Id) => void;
  onChapterRenamed?: (chapter: Chapter) => void;
  onChapterListChanged?: () => void;
  selectedChapterId?: Id | null;
  /** 刷新令牌（Agent 写入后刷新）。 */
  refreshToken?: number;
  onClose: () => void;
  onError?: (error: unknown) => void;
}

export function ResourceDrawer({
  projectId,
  tab,
  onTabChange,
  onSelectChapter,
  onChapterDeleted,
  onChapterRenamed,
  onChapterListChanged,
  selectedChapterId,
  refreshToken,
  onClose,
  onError,
}: ResourceDrawerProps): JSX.Element | null {
  if (projectId === null) return null;

  return createPortal(
    <div className="nwa-drawer-overlay" onClick={onClose}>
      <div
        className="nwa-drawer nwa-drawer--left"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="项目资料"
        aria-modal="true"
      >
        <div className="nwa-drawer__header">
          <div className="nwa-drawer__title">
            <span className="nwa-drawer__icon"><Icon name="archive" /></span>
            <span>项目资料</span>
          </div>
          <button
            type="button"
            className="nwa-button nwa-button--icon"
            onClick={onClose}
            aria-label="关闭资料抽屉"
            title="关闭"
          >
            <Icon name="x" />
          </button>
        </div>

        <div className="nwa-drawer__body">
          <ProjectWorkspaceView
            projectId={projectId}
            refreshToken={refreshToken}
            selectedChapterId={selectedChapterId}
            onChapterDeleted={onChapterDeleted}
            onChapterRenamed={onChapterRenamed}
            onChapterListChanged={onChapterListChanged}
            onSelectChapter={(id) => {
              onSelectChapter?.(id);
              onClose();
            }}
            onError={onError}
            workspaceTab={tab}
            onWorkspaceTabChange={onTabChange}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default ResourceDrawer;
