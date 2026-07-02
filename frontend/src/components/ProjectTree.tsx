/**
 * 左侧项目树 —— 项目 > 章节两级树。
 *
 * 复用 ProjectListView 的项目 CRUD（新建/选择/重命名/删除 Modal）逻辑，
 * 在选中项目下方额外加载并展示该项目章节列表（点击章节 = 选中并打开对话上下文）。
 *
 * 这是"侧边项目树"决策的落地：选中项目即切换对话上下文，选中章节即进入写作模式。
 */
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import apiClient, { isApiClientError } from '../api/apiClient.js';
import type { Chapter, Id, Project } from '../types/index.js';
import { Icon } from './Icon.js';
import './components.css';

type ProjectItem = Pick<Project, 'id' | 'name'>;

export interface ProjectTreeProps {
  selectedProjectId?: Id | null;
  selectedChapterId?: Id | null;
  onSelectProject: (projectId: Id) => void;
  onSelectChapter: (chapterId: Id) => void;
  onProjectDeleted?: (projectId: Id) => void;
  /** 刷新令牌（Agent 创建项目/章节后刷新树）。 */
  refreshToken?: number;
  onError?: (error: unknown) => void;
  client?: Pick<typeof apiClient, 'projects' | 'chapters'>;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function ProjectTree({
  selectedProjectId,
  selectedChapterId,
  onSelectProject,
  onSelectChapter,
  onProjectDeleted,
  refreshToken = 0,
  onError,
  client = apiClient,
}: ProjectTreeProps): JSX.Element {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [chaptersByProject, setChaptersByProject] = useState<Record<string, Chapter[]>>({});
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  // 项目重命名/删除 Modal
  const [renameTarget, setRenameTarget] = useState<ProjectItem | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ProjectItem | null>(null);
  // NEW-09: 项目列表可折叠（选中项目时显示按钮，专注下方资料或章节）
  const [projectsListCollapsed, setProjectsListCollapsed] = useState(false);

  const handleError = useCallback(
    (error: unknown) => {
      if (isAbort(error)) return;
      onError?.(error);
    },
    [onError],
  );

  const refreshProjects = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const list = await client.projects.list(signal);
        if (!Array.isArray(list)) {
          throw new Error('项目列表接口返回格式错误：期望数组。');
        }
        setProjects(list);
      } catch (error) {
        handleError(error);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [client, handleError],
  );

  const refreshChapters = useCallback(
    async (projectId: Id, signal?: AbortSignal) => {
      try {
        const chapters = await client.chapters.list(projectId, signal);
        setChaptersByProject((prev) => ({ ...prev, [projectId]: chapters }));
      } catch (error) {
        handleError(error);
      }
    },
    [client, handleError],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refreshProjects(controller.signal);
    return () => controller.abort();
  }, [refreshProjects, refreshToken]);

  // 选中项目时加载其章节；refreshToken 变化时刷新当前项目章节
  useEffect(() => {
    if (selectedProjectId == null) return;
    const controller = new AbortController();
    void refreshChapters(selectedProjectId, controller.signal);
    return () => controller.abort();
  }, [selectedProjectId, refreshChapters, refreshToken]);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (name.length === 0 || busy) return;
    setBusy(true);
    try {
      const { id } = await client.projects.create(name);
      setProjects((current) => [...current, { id, name }]);
      setChaptersByProject((current) => ({ ...current, [id]: [] }));
      setNewName('');
      onSelectProject(id);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }, [newName, busy, client, onSelectProject, handleError]);

  const doRename = useCallback(async () => {
    if (!renameTarget) return;
    const name = renameInput.trim();
    if (name.length === 0 || name === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    setBusy(true);
    try {
      await client.projects.rename(renameTarget.id, name);
      setProjects((current) => current.map((project) => (
        project.id === renameTarget.id ? { ...project, name } : project
      )));
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
      setRenameTarget(null);
    }
  }, [renameTarget, renameInput, client, handleError]);

  const doDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await client.projects.remove(deleteTarget.id);
      setProjects((current) => current.filter((project) => project.id !== deleteTarget.id));
      setChaptersByProject((prev) => {
        const next = { ...prev };
        delete next[deleteTarget.id];
        return next;
      });
      if (deleteTarget.id === selectedProjectId) {
        onProjectDeleted?.(deleteTarget.id);
      }
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  }, [deleteTarget, selectedProjectId, client, handleError, onProjectDeleted]);

  const renameModal = renameTarget
    ? createPortal(
        <div className="nwa-modal-overlay">
          <div className="nwa-modal" role="dialog" aria-label="重命名项目" aria-modal="true">
            <div className="nwa-modal-header">
              <h2>重命名项目</h2>
              <button type="button" className="nwa-modal-close" onClick={() => setRenameTarget(null)} aria-label="关闭重命名项目">
                <Icon name="x" />
              </button>
            </div>
            <div className="nwa-modal-body">
              <input
                className="nwa-input"
                value={renameInput}
                onChange={(e) => setRenameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doRename();
                }}
                autoFocus
              />
            </div>
            <div className="nwa-modal-footer">
              <button
                type="button"
                className="nwa-button nwa-button--ghost"
                disabled={busy}
                onClick={() => setRenameTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="nwa-button"
                disabled={busy || !renameInput.trim()}
                onClick={() => void doRename()}
              >
                保存
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  const deleteModal = deleteTarget
    ? createPortal(
        <div className="nwa-modal-overlay">
          <div className="nwa-modal" role="dialog" aria-label="删除确认" aria-modal="true">
            <div className="nwa-modal-header">
              <h2>删除项目</h2>
              <button type="button" className="nwa-modal-close" onClick={() => setDeleteTarget(null)} aria-label="关闭删除项目确认">
                <Icon name="x" />
              </button>
            </div>
            <div className="nwa-modal-body">
              <p>
                确定要删除项目「{deleteTarget.name}」吗？此操作不可撤销，所有章节与资料将一并删除。
              </p>
            </div>
            <div className="nwa-modal-footer">
              <button
                type="button"
                className="nwa-button nwa-button--ghost"
                disabled={busy}
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="nwa-button nwa-button--danger"
                disabled={busy}
                onClick={() => void doDelete()}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <nav className="nwa-project-tree" aria-label="项目导航">
      <div className="nwa-project-tree__new">
        <input
          className="nwa-input nwa-project-tree__new-input"
          type="text"
          placeholder="+ 新建项目…"
          aria-label="新项目名称"
          value={newName}
          disabled={busy}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCreate();
          }}
        />
      </div>

      {loading ? (
        <p className="nwa-muted nwa-project-tree__hint">加载中…</p>
      ) : projects.length === 0 ? (
        <p className="nwa-muted nwa-project-tree__hint">还没有项目，输入名称创建第一个吧。</p>
      ) : (
        <>
          {selectedProjectId ? (
            <button
              type="button"
              className="nwa-button nwa-button--ghost nwa-button--sm"
              style={{ fontSize: '0.75rem', marginBottom: '0.25rem' }}
              onClick={() => setProjectsListCollapsed((v) => !v)}
              aria-label={projectsListCollapsed ? '展开项目列表' : '收起项目列表'}
            >
              {projectsListCollapsed ? '展开项目列表' : '收起项目列表'}
            </button>
          ) : null}
          {!projectsListCollapsed ? (
            <ul className="nwa-project-tree__list">
          {projects.map((project) => {
            const isProjectSelected = project.id === selectedProjectId;
            const chapters = chaptersByProject[project.id] ?? [];
            return (
              <li key={project.id} className="nwa-project-tree__node">
                <div
                  className={`nwa-project-tree__row${isProjectSelected ? ' nwa-project-tree__row--selected' : ''}`}
                >
                  <button
                    type="button"
                    className="nwa-project-tree__label"
                    aria-pressed={isProjectSelected}
                    onClick={() => onSelectProject(project.id)}
                    title={project.name}
                  >
                    <span className="nwa-project-tree__icon">
                      <Icon name={isProjectSelected ? 'folderOpen' : 'folder'} />
                    </span>
                    <span className="nwa-project-tree__name">{project.name}</span>
                  </button>
                  {isProjectSelected ? (
                    <span className="nwa-project-tree__actions">
                      <button
                        type="button"
                        className="nwa-button nwa-button--icon nwa-project-tree__action"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenameTarget(project);
                          setRenameInput(project.name);
                        }}
                        title="重命名"
                        aria-label={`重命名项目 ${project.name}`}
                      >
                        <Icon name="edit" />
                      </button>
                      <button
                        type="button"
                        className="nwa-button nwa-button--icon nwa-project-tree__action"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(project);
                        }}
                        title="删除"
                        aria-label={`删除项目 ${project.name}`}
                      >
                        <Icon name="trash" />
                      </button>
                    </span>
                  ) : null}
                </div>
                {isProjectSelected && chapters.length > 0 ? (
                  <ul className="nwa-project-tree__sublist">
                    {chapters.map((chapter) => {
                      const isChapterSelected = chapter.id === selectedChapterId;
                      return (
                        <li key={chapter.id}>
                          <button
                            type="button"
                            className={`nwa-project-tree__sublabel${isChapterSelected ? ' nwa-project-tree__sublabel--selected' : ''}`}
                            aria-pressed={isChapterSelected}
                            onClick={() => onSelectChapter(chapter.id)}
                            title={chapter.title}
                          >
                            <span className="nwa-project-tree__subicon"><Icon name="fileText" /></span>
                            <span className="nwa-project-tree__subname">{chapter.title}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
          ) : null}
        </>
      )}

      {renameModal}
      {deleteModal}
    </nav>
  );
}

export { isApiClientError };
export default ProjectTree;
