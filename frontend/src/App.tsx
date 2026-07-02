/**
 * 小说Agent — VS Code 风三段式工作台。
 *
 * 信息架构：
 *  ┌顶栏: Logo | 项目 > 章节(面包屑) | 资料按钮 | 设置 ─────────────┐
 *  ├左项目树(可折叠) ─┬─ 中间章节编辑板 ─┬─ 右侧 AI 对话栏(可折叠) ┤
 *  └─────────────────┴──────────────────┴─────────────────────────┘
 *   [章节工具抽屉→] 从右滑出: 蓝图/报告
 *   [资料抽屉←] 从左覆盖: 人物/世界观/大纲
 *
 * 状态所有权沿用旧 App：selectedProjectId/Chapter、streamingState、workspaceTab 等。
 * 采用链路：ChatWorkspace onAdoptContent → handleAdoptContent → editorContent 受控更新 + 落库。
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import apiClient from './api/apiClient.js';
import { ChatWorkspace } from './components/ChatWorkspace.js';
import { ChapterEditor } from './components/ChapterEditor.js';
import { ChapterToolsDrawer } from './components/ChapterToolsDrawer.js';
import { ResourceDrawer } from './components/ResourceDrawer.js';
import { ReaderWorkspace } from './components/ReaderWorkspace.js';
import { ProjectTree } from './components/ProjectTree.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { ErrorProvider, useErrorReporter } from './components/ErrorToast.js';
import { Icon } from './components/Icon.js';
import { useDialogFocusTrap } from './components/useDialogFocusTrap.js';
import {
  buildProjectDocxBlob,
  buildProjectTextExport,
  sanitizeDownloadName,
  type ProjectExportFormat,
} from './lib/projectExport.js';
import { useWorkspaceSelection } from './hooks/useWorkspaceSelection.js';
import { usePaneLayout } from './hooks/usePaneLayout.js';
import { useNovelImportDrop } from './hooks/useNovelImportDrop.js';
import type { AgentArtifact, Id } from './types/index.js';
import type { WorkspaceTab } from './components/ProjectWorkspaceView.js';
import type { EditorSelectionRequest } from './components/ChapterEditor.js';
import './components/components.css';
import './App.css';

type DrawerKind = 'none' | 'chapterTools' | 'resource';
type AppMode = 'agent' | 'reader';
type ThemeMode = 'tavern' | 'midnight' | 'paper';
const THEME_STORAGE_KEY = 'nwa:theme-mode';

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'tavern' || value === 'midnight' || value === 'paper';
}

function BrandLogo(): JSX.Element {
  return (
    <svg className="nwa-brand-logo" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path className="nwa-brand-logo__page" d="M7 5.5h10.2L25 13.3v13.2H7z" />
      <path className="nwa-brand-logo__fold" d="M17.2 5.5v8h7.8" />
      <path className="nwa-brand-logo__spark" d="m12.3 14 1.2 3.1 3.1 1.2-3.1 1.2-1.2 3.1-1.2-3.1L8 18.3l3.1-1.2z" />
      <path className="nwa-brand-logo__line" d="M16.8 19.5h4.8M14.8 23h6.8" />
    </svg>
  );
}

function Workbench(): JSX.Element {
  const { reportError } = useErrorReporter();
  useDialogFocusTrap();

  // —— 抽屉控制 ——
  const [drawer, setDrawer] = useState<DrawerKind>('none');
  const [appMode, setAppMode] = useState<AppMode>('agent');
  const openChapterTools = useCallback(() => setDrawer('chapterTools'), []);
  const clearChapterTools = useCallback(() => {
    setDrawer((current) => (current === 'chapterTools' ? 'none' : current));
  }, []);
  const {
    selectedProjectId,
    selectedProjectName,
    selectedChapterId,
    selectedChapter,
    projectListVersion,
    editorContent,
    selection,
    setEditorContent,
    setSelection,
    bumpProjectList,
    loadChapter,
    selectProject,
    selectCreatedProject,
    clearSelectedChapter,
    clearSelectedProject,
    applyAgentResult,
    handleSaved,
  } = useWorkspaceSelection({
    reportError,
    onOpenChapterTools: openChapterTools,
    onClearChapterTools: clearChapterTools,
  });
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    chatCollapsed,
    setChatCollapsed,
    sidebarWidth,
    chatWidth,
    startPaneResize,
    nudgePane,
  } = usePaneLayout();
  // 资料抽屉受控 tab
  const [resourceTab, setResourceTab] = useState<WorkspaceTab>('chapters');
  const openChaptersTab = useCallback(() => setResourceTab('chapters'), []);
  const {
    importDragActive,
    importBusy,
    importMessage,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useNovelImportDrop({
    selectedProjectId,
    reportError,
    bumpProjectList,
    loadChapter,
    selectProject,
    selectCreatedProject,
    openChaptersTab,
  });
  // 设置 Modal
  const [showSettings, setShowSettings] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      return isThemeMode(stored) ? stored : 'tavern';
    } catch {
      return 'tavern';
    }
  });
  // 流式状态（兼容旧中央预览，现主要用于内部）
  const [streamingState, setStreamingState] = useState<{
    streaming: boolean;
    content: string;
    thinking: string;
  }>({ streaming: false, content: '', thinking: '' });
  const [selectionRequest, setSelectionRequest] = useState<EditorSelectionRequest | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // Theme persistence is optional.
    }
  }, [themeMode]);

  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, []);

  const handleExportProject = useCallback(
    async (format: ProjectExportFormat | 'docx') => {
      if (selectedProjectId === null) return;
      try {
        const chapters = await apiClient.chapters.list(selectedProjectId);
        const projectName = selectedProjectName ?? '小说项目';
        if (format === 'docx') {
          downloadBlob(
            buildProjectDocxBlob(projectName, chapters),
            `${sanitizeDownloadName(projectName)}.docx`,
          );
          return;
        }
        const content = buildProjectTextExport(projectName, chapters, format);
        downloadBlob(
          new Blob([content], {
            type: format === 'markdown' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8',
          }),
          `${sanitizeDownloadName(projectName)}.${format === 'markdown' ? 'md' : 'txt'}`,
        );
      } catch (error) {
        reportError(error);
      }
    },
    [downloadBlob, selectedProjectId, selectedProjectName, reportError],
  );

  // —— 选中章节（进入写作模式 + 中间编辑器） ——
  const handleSelectChapter = useCallback(
    async (chapterId: Id) => {
      if (selectedProjectId === null) return;
      await loadChapter(selectedProjectId, chapterId);
    },
    [loadChapter, selectedProjectId],
  );

  // —— 采用写作内容到中间编辑器 ——
  const handleAdoptContent = useCallback(
    (content: string) => {
      setEditorContent(content);
      const len = content.length;
      setSelectionRequest((current) => ({
        start: len,
        end: len,
        revision: (current?.revision ?? 0) + 1,
      }));
      if (selectedChapterId) {
        apiClient.chapters
          .updateContent(selectedChapterId, content)
          .then(() => handleSaved(selectedChapterId, content))
          .catch((e) => reportError(e));
      }
    },
    [handleSaved, reportError, selectedChapterId, setEditorContent],
  );

  // —— 蓝图模块"采用整章" ——
  const handleAdoptChapterContent = useCallback(
    (content: string) => {
      handleAdoptContent(content);
    },
    [handleAdoptContent],
  );

  // —— artifact 跳转 ——
  const handleJumpToArtifact = useCallback(
    (artifact: AgentArtifact) => {
      const tabForKind: Record<string, WorkspaceTab> = {
        world: 'world',
        character: 'characters',
        outline: 'outlines',
        chapter: 'chapters',
        project: 'chapters',
      };
      const target = tabForKind[artifact.kind] ?? 'chapters';
      setResourceTab(target);
      setDrawer('resource');
      // 章节 artifact：加载到中间编辑器
      if (artifact.kind === 'chapter' && selectedProjectId) {
        void loadChapter(selectedProjectId, artifact.id);
      }
    },
    [loadChapter, selectedProjectId],
  );

  // —— 关闭抽屉 ——
  const handleCloseDrawer = useCallback(() => {
    setDrawer('none');
  }, []);

  const openAgentMode = useCallback(() => {
    setAppMode('agent');
  }, []);

  const openReaderMode = useCallback(() => {
    setDrawer('none');
    setAppMode('reader');
  }, []);

  // ESC 关闭当前浮层或回到 Agent 模式
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && appMode === 'reader') {
        setAppMode('agent');
        return;
      }
      if (e.key === 'Escape' && drawer !== 'none') {
        setDrawer('none');
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [appMode, drawer]);

  return (
    <div
      className={`nwa-tavern-app nwa-theme-${themeMode}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(event) => void handleDrop(event)}
    >
      {(importDragActive || importBusy) ? (
        <div className="nwa-import-overlay" role="status" aria-live="polite">
          <div className="nwa-import-overlay__box">
            <Icon name={importBusy ? 'refresh' : 'folderOpen'} />
            <strong>{importBusy ? '正在整理导入文本' : '松开以整理小说文件'}</strong>
            <span>支持文件夹、TXT、Markdown</span>
          </div>
        </div>
      ) : null}
      {importMessage ? (
        <div className="nwa-import-status" role="status" aria-live="polite">
          <Icon name="check" /> {importMessage}
        </div>
      ) : null}
      {appMode === 'agent' ? (
        <header className="nwa-tavern-header">
          <div className="nwa-header-brand">
            <button
              type="button"
              className="nwa-button nwa-button--icon nwa-sidebar-toggle"
              onClick={() => setSidebarCollapsed((v) => !v)}
              aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            >
              <Icon name={sidebarCollapsed ? 'panelLeft' : 'panelRight'} />
            </button>
            <BrandLogo />
            <h1 className="nwa-app-title">小说 Agent</h1>
            <nav className="nwa-breadcrumb" aria-label="上下文">
              {selectedProjectName ? (
                <>
                  <span className="nwa-breadcrumb__sep">·</span>
                  <span className="nwa-breadcrumb__project">{selectedProjectName}</span>
                  {selectedChapter ? (
                    <>
                      <span className="nwa-breadcrumb__sep"><Icon name="chevronRight" /></span>
                      <button
                        type="button"
                        className="nwa-breadcrumb__chapter"
                        onClick={() => setDrawer('chapterTools')}
                        title="打开蓝图与报告"
                      >
                        {selectedChapter.title}
                      </button>
                    </>
                  ) : null}
                </>
              ) : (
                <span className="nwa-app-subtitle">沉浸式 AI 创作工作台</span>
              )}
            </nav>
          </div>
          <div className="nwa-header-actions">
            <button
              type="button"
              className="nwa-button nwa-button--ghost nwa-button--sm is-active"
              onClick={openAgentMode}
              title="进入 Agent 工作台"
            >
              <Icon name="edit" /> Agent
            </button>
            <button
              type="button"
              className="nwa-button nwa-button--ghost nwa-button--sm"
              onClick={openReaderMode}
              title="进入书架模式"
            >
              <Icon name="bookOpen" /> 书架
            </button>
            {selectedProjectId !== null ? (
              <button
                type="button"
                className="nwa-button nwa-button--ghost nwa-button--sm"
                onClick={() => setDrawer(drawer === 'resource' ? 'none' : 'resource')}
                title="查看人物/世界观/大纲资料"
              >
                <Icon name="archive" /> 资料
              </button>
            ) : null}
            <button
              type="button"
              className="nwa-button nwa-button--ghost nwa-button--sm"
              onClick={() => setShowSettings(true)}
              title="设置"
              aria-label="打开设置"
            >
              <Icon name="settings" /> 设置
            </button>
          </div>
        </header>
      ) : null}

      {/* —— 主工作区 —— */}
      {appMode === 'agent' ? (
        <main
          className="nwa-tavern-workspace"
          style={
            {
              gridTemplateColumns: `${sidebarCollapsed ? '' : `${sidebarWidth}px 6px `}minmax(0, 1fr)${chatCollapsed ? '' : ` 6px ${chatWidth}px`}`,
            } as CSSProperties
          }
        >
        {/* 左侧栏：项目树 */}
        {!sidebarCollapsed ? (
          <aside className="nwa-tavern-sidebar">
            <div className="nwa-sidebar-header">
              <h3>项目</h3>
            </div>
            <div className="nwa-sidebar-content">
              <ProjectTree
                selectedProjectId={selectedProjectId}
                selectedChapterId={selectedChapterId}
                onSelectProject={selectProject}
                onSelectChapter={(id) => void handleSelectChapter(id)}
                onProjectDeleted={clearSelectedProject}
                refreshToken={projectListVersion}
                onError={reportError}
              />
            </div>
          </aside>
        ) : null}
        {!sidebarCollapsed ? (
          <div
            className="nwa-resizer nwa-resizer--left"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整项目栏宽度"
            tabIndex={0}
            onPointerDown={(event) => startPaneResize('left', event)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') nudgePane('left', -16);
              if (event.key === 'ArrowRight') nudgePane('left', 16);
            }}
          />
        ) : null}

        {/* 中间：章节编辑板 */}
        <section className="nwa-tavern-center">
          <div className="nwa-editor-board">
            <div className="nwa-editor-board__toolbar">
              <div className="nwa-editor-board__meta">
                <span className="nwa-editor-board__eyebrow">编辑板</span>
                <strong>{selectedChapter?.title ?? '未选择章节'}</strong>
              </div>
              <div className="nwa-editor-board__actions">
                <button
                  type="button"
                  className="nwa-button nwa-button--ghost nwa-button--sm"
                  disabled={selectedProjectId === null}
                  onClick={() => setDrawer(drawer === 'resource' ? 'none' : 'resource')}
                >
                  资料
                </button>
                <button
                  type="button"
                  className="nwa-button nwa-button--ghost nwa-button--sm"
                  disabled={selectedProjectId === null}
                  onClick={() => void handleExportProject('markdown')}
                >
                  导出 MD
                </button>
                <button
                  type="button"
                  className="nwa-button nwa-button--ghost nwa-button--sm"
                  disabled={selectedProjectId === null}
                  onClick={() => void handleExportProject('txt')}
                >
                  导出 TXT
                </button>
                <button
                  type="button"
                  className="nwa-button nwa-button--ghost nwa-button--sm"
                  disabled={selectedProjectId === null}
                  onClick={() => void handleExportProject('docx')}
                >
                  导出 DOCX
                </button>
                <button
                  type="button"
                  className="nwa-button nwa-button--ghost nwa-button--sm"
                  onClick={openReaderMode}
                >
                  <Icon name="bookOpen" /> 阅读
                </button>
                <button
                  type="button"
                  className="nwa-button nwa-button--ghost nwa-button--sm"
                  disabled={selectedChapter === null}
                  onClick={() => setDrawer(drawer === 'chapterTools' ? 'none' : 'chapterTools')}
                >
                  蓝图 / 报告
                </button>
                <button
                  type="button"
                  className="nwa-button nwa-button--ghost nwa-button--sm"
                  onClick={() => setChatCollapsed((v) => !v)}
                  aria-label={chatCollapsed ? '展开 AI 对话栏' : '收起 AI 对话栏'}
                >
                  {chatCollapsed ? '展开 AI' : '收起 AI'}
                </button>
              </div>
            </div>
            <div className="nwa-editor-board__content">
              <ChapterEditor
                chapter={selectedChapter}
                contentOverride={editorContent}
                selectionRequest={selectionRequest}
                onContentChange={setEditorContent}
                onSelectionChange={setSelection}
                onSaved={handleSaved}
                onError={reportError}
                autoSaveDelayMs={1500}
              />
            </div>
          </div>
        </section>

        {!chatCollapsed ? (
          <div
            className="nwa-resizer nwa-resizer--right"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整 AI 对话栏宽度"
            tabIndex={0}
            onPointerDown={(event) => startPaneResize('right', event)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') nudgePane('right', 16);
              if (event.key === 'ArrowRight') nudgePane('right', -16);
            }}
          />
        ) : null}

        {/* 右侧：AI 对话栏 */}
        {!chatCollapsed ? (
          <aside className="nwa-tavern-right" aria-label="AI 对话">
            <div className="nwa-right-header">
              <div>
                <span className="nwa-editor-board__eyebrow">AI</span>
                <strong>对话与任务</strong>
              </div>
              <button
                type="button"
                className="nwa-button nwa-button--icon"
                onClick={() => setChatCollapsed(true)}
                aria-label="收起 AI 对话栏"
                title="收起 AI 对话栏"
              >
                <Icon name="chevronRight" />
              </button>
            </div>
          <ChatWorkspace
            projectId={selectedProjectId}
            projectName={selectedProjectName}
            chapterId={selectedChapterId}
            chapterTitle={selectedChapter?.title}
            editorContent={editorContent}
            selection={selection}
            onError={reportError}
            onStreamingChange={setStreamingState}
            onAdoptContent={handleAdoptContent}
            onAgentCompleted={applyAgentResult} /* NEW-04: 架构上右侧 AI 栏持久存在（非 tab 切换），Agent 结果（summary/artifacts/进度）留在聊天消息中供 review；loadChapter 仅在用户点击“打开章节”或列表时显式调用，不自动强制切换 */
            onJumpToArtifact={handleJumpToArtifact}
            onOpenChapter={(chapterId) => {
              if (selectedProjectId) {
                void loadChapter(selectedProjectId, chapterId);
              }
            }}
          />
          </aside>
        ) : null}
        </main>
      ) : (
        <main className="nwa-reader-mode-main">
          <ReaderWorkspace
            projectId={selectedProjectId}
            projectName={selectedProjectName}
            refreshToken={projectListVersion}
            onOpenAgentMode={openAgentMode}
            onError={reportError}
            onProjectCreated={(projectId) => {
              bumpProjectList();
              selectProject(projectId);
            }}
            onChapterUpdated={handleSaved}
          />
        </main>
      )}

      {appMode === 'agent' ? (
        <>
          {/* —— 章节工具抽屉 —— */}
          <ChapterToolsDrawer
            chapter={drawer === 'chapterTools' ? selectedChapter : null}
            onAdoptChapterContent={handleAdoptChapterContent}
            onClose={handleCloseDrawer}
            onError={reportError}
          />

          {/* —— 资料抽屉 —— */}
          <ResourceDrawer
            projectId={drawer === 'resource' ? selectedProjectId : null}
            tab={resourceTab}
            onTabChange={setResourceTab}
            onSelectChapter={(id) => void handleSelectChapter(id)}
            selectedChapterId={selectedChapterId}
            refreshToken={projectListVersion}
            onChapterDeleted={clearSelectedChapter}
            onClose={handleCloseDrawer}
            onError={reportError}
          />
        </>
      ) : null}

      {/* —— 设置 Modal —— */}
      {showSettings ? (
        <div className="nwa-modal-overlay" onClick={() => setShowSettings(false)}>
          <div
            className="nwa-modal"
            role="dialog"
            aria-label="应用设置"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="nwa-modal-header">
              <h2><Icon name="settings" /> 设置</h2>
              <button
                type="button"
                className="nwa-modal-close"
                onClick={() => setShowSettings(false)}
                aria-label="关闭设置"
              >
                <Icon name="x" />
              </button>
            </div>
            <div className="nwa-modal-body">
              <SettingsPanel
                onError={reportError}
                themeMode={themeMode}
                onThemeModeChange={setThemeMode}
              />
            </div>
          </div>
        </div>
      ) : null}

      {/* streamingState 占位（保留以兼容未来中央预览；当前对话流内已实时显示） */}
      {streamingState.streaming ? null : null}
    </div>
  );
}

export function App(): JSX.Element {
  return (
    <ErrorProvider>
      <Workbench />
    </ErrorProvider>
  );
}

export default App;
