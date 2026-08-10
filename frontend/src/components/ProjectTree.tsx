/**
 * 左侧项目树 —— 项目 > 章节两级。
 * 支持搜索、悬停操作、删除项目/章节，多项目时不至于乱。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  onChapterDeleted?: (chapterId: Id) => void;
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
  onChapterDeleted,
  refreshToken = 0,
  onError,
  client = apiClient,
}: ProjectTreeProps): JSX.Element {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [chaptersByProject, setChaptersByProject] = useState<Record<string, Chapter[]>>({});
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const [renameTarget, setRenameTarget] = useState<ProjectItem | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ProjectItem | null>(null);
  const [deleteChapterTarget, setDeleteChapterTarget] = useState<{
    projectId: Id;
    chapter: Chapter;
  } | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

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
        // 新项目在上，方便管理
        setProjects([...list].reverse());
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

  useEffect(() => {
    if (selectedProjectId == null) return;
    const controller = new AbortController();
    void refreshChapters(selectedProjectId, controller.signal);
    return () => controller.abort();
  }, [selectedProjectId, refreshChapters, refreshToken]);

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, query]);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (name.length === 0 || busy) return;
    setBusy(true);
    try {
      const { id } = await client.projects.create(name);
      setProjects((current) => [{ id, name }, ...current]);
      setChaptersByProject((current) => ({ ...current, [id]: [] }));
      setNewName('');
      setQuery('');
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
      setProjects((current) =>
        current.map((project) => (project.id === renameTarget.id ? { ...project, name } : project)),
      );
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
      setCheckedIds((prev) => {
        const next = new Set(prev);
        next.delete(deleteTarget.id);
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

  const doDeleteChapter = useCallback(async () => {
    if (!deleteChapterTarget) return;
    setBusy(true);
    try {
      await client.chapters.remove(deleteChapterTarget.chapter.id);
      setChaptersByProject((prev) => ({
        ...prev,
        [deleteChapterTarget.projectId]: (prev[deleteChapterTarget.projectId] ?? []).filter(
          (c) => c.id !== deleteChapterTarget.chapter.id,
        ),
      }));
      if (deleteChapterTarget.chapter.id === selectedChapterId) {
        onChapterDeleted?.(deleteChapterTarget.chapter.id);
      }
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
      setDeleteChapterTarget(null);
    }
  }, [deleteChapterTarget, selectedChapterId, client, handleError, onChapterDeleted]);

  const doBulkDelete = useCallback(async () => {
    if (checkedIds.size === 0) return;
    setBusy(true);
    const ids = [...checkedIds];
    try {
      for (const id of ids) {
        await client.projects.remove(id);
      }
      setProjects((current) => current.filter((p) => !checkedIds.has(p.id)));
      setChaptersByProject((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      });
      if (selectedProjectId && checkedIds.has(selectedProjectId)) {
        onProjectDeleted?.(selectedProjectId);
      }
      setCheckedIds(new Set());
      setSelectMode(false);
    } catch (error) {
      handleError(error);
      await refreshProjects();
    } finally {
      setBusy(false);
      setBulkDeleteOpen(false);
    }
  }, [checkedIds, client, handleError, onProjectDeleted, refreshProjects, selectedProjectId]);

  const toggleChecked = (id: string): void => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renameModal = renameTarget
    ? createPortal(
        <div className="nwa-modal-overlay">
          <div className="nwa-modal" role="dialog" aria-label="重命名项目" aria-modal="true">
            <div className="nwa-modal-header">
              <h2>重命名项目</h2>
              <button type="button" className="nwa-modal-close" onClick={() => setRenameTarget(null)} aria-label="关闭">
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
              <button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={() => setRenameTarget(null)}>
                取消
              </button>
              <button type="button" className="nwa-button" disabled={busy || !renameInput.trim()} onClick={() => void doRename()}>
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
              <button type="button" className="nwa-modal-close" onClick={() => setDeleteTarget(null)} aria-label="关闭">
                <Icon name="x" />
              </button>
            </div>
            <div className="nwa-modal-body">
              <p>
                确定删除「<strong>{deleteTarget.name}</strong>」？章节、设定与大纲将一并删除，且不可恢复。
              </p>
            </div>
            <div className="nwa-modal-footer">
              <button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={() => setDeleteTarget(null)}>
                取消
              </button>
              <button type="button" className="nwa-button nwa-button--danger" disabled={busy} onClick={() => void doDelete()}>
                确认删除
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  const deleteChapterModal = deleteChapterTarget
    ? createPortal(
        <div className="nwa-modal-overlay">
          <div className="nwa-modal" role="dialog" aria-label="删除章节" aria-modal="true">
            <div className="nwa-modal-header">
              <h2>删除章节</h2>
              <button type="button" className="nwa-modal-close" onClick={() => setDeleteChapterTarget(null)} aria-label="关闭">
                <Icon name="x" />
              </button>
            </div>
            <div className="nwa-modal-body">
              <p>
                确定删除章节「<strong>{deleteChapterTarget.chapter.title}</strong>」？相关蓝图与草稿也会清除。
              </p>
            </div>
            <div className="nwa-modal-footer">
              <button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={() => setDeleteChapterTarget(null)}>
                取消
              </button>
              <button type="button" className="nwa-button nwa-button--danger" disabled={busy} onClick={() => void doDeleteChapter()}>
                确认删除
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  const bulkModal = bulkDeleteOpen
    ? createPortal(
        <div className="nwa-modal-overlay">
          <div className="nwa-modal" role="dialog" aria-label="批量删除" aria-modal="true">
            <div className="nwa-modal-header">
              <h2>批量删除</h2>
              <button type="button" className="nwa-modal-close" onClick={() => setBulkDeleteOpen(false)} aria-label="关闭">
                <Icon name="x" />
              </button>
            </div>
            <div className="nwa-modal-body">
              <p>
                将永久删除 <strong>{checkedIds.size}</strong> 个项目及其全部内容。此操作不可撤销。
              </p>
            </div>
            <div className="nwa-modal-footer">
              <button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={() => setBulkDeleteOpen(false)}>
                取消
              </button>
              <button type="button" className="nwa-button nwa-button--danger" disabled={busy} onClick={() => void doBulkDelete()}>
                删除 {checkedIds.size} 项
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <nav className="nwa-project-tree" aria-label="项目导航">
      <div className="nwa-project-tree__toolbar">
        <div className="nwa-project-tree__title-row">
          <span className="nwa-project-tree__count">
            {projects.length} 个项目
            {query.trim() ? ` · 筛出 ${filteredProjects.length}` : ''}
          </span>
          <div className="nwa-project-tree__toolbar-actions">
            {projects.length > 1 ? (
              <button
                type="button"
                className={`nwa-button nwa-button--ghost nwa-button--sm${selectMode ? ' is-active' : ''}`}
                onClick={() => {
                  setSelectMode((v) => !v);
                  setCheckedIds(new Set());
                }}
                title="批量管理"
              >
                {selectMode ? '完成' : '管理'}
              </button>
            ) : null}
          </div>
        </div>

        <div className="nwa-project-tree__new">
          <input
            className="nwa-input nwa-project-tree__new-input"
            type="text"
            placeholder="搜索项目…"
            aria-label="搜索项目"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="nwa-project-tree__new">
          <div className="nwa-project-tree__create-row">
            <input
              className="nwa-input nwa-project-tree__new-input"
              type="text"
              placeholder="新建项目名称…"
              aria-label="新项目名称"
              value={newName}
              disabled={busy}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
              }}
            />
            <button
              type="button"
              className="nwa-button nwa-button--sm"
              disabled={busy || !newName.trim()}
              onClick={() => void handleCreate()}
            >
              新建
            </button>
          </div>
        </div>

        {selectMode && checkedIds.size > 0 ? (
          <div className="nwa-project-tree__bulk-bar">
            <span>已选 {checkedIds.size}</span>
            <button
              type="button"
              className="nwa-button nwa-button--danger nwa-button--sm"
              disabled={busy}
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Icon name="trash" /> 删除所选
            </button>
          </div>
        ) : null}
      </div>

      {loading ? (
        <p className="nwa-muted nwa-project-tree__hint">加载中…</p>
      ) : projects.length === 0 ? (
        <div className="nwa-project-tree__empty">
          <Icon name="folder" />
          <p>还没有项目</p>
          <span className="nwa-muted">上方输入名称创建第一个，或用 /新书 自动生成</span>
        </div>
      ) : filteredProjects.length === 0 ? (
        <p className="nwa-muted nwa-project-tree__hint">没有匹配「{query}」的项目</p>
      ) : (
        <ul className="nwa-project-tree__list">
          {filteredProjects.map((project) => {
            const isProjectSelected = project.id === selectedProjectId;
            const chapters = chaptersByProject[project.id] ?? [];
            const checked = checkedIds.has(project.id);
            return (
              <li
                key={project.id}
                className={`nwa-project-tree__node${isProjectSelected ? ' nwa-project-tree__node--open' : ''}`}
              >
                <div
                  className={`nwa-project-tree__row${isProjectSelected ? ' nwa-project-tree__row--selected' : ''}${checked ? ' nwa-project-tree__row--checked' : ''}`}
                >
                  {selectMode ? (
                    <input
                      type="checkbox"
                      className="nwa-project-tree__check"
                      checked={checked}
                      onChange={() => toggleChecked(project.id)}
                      aria-label={`选择 ${project.name}`}
                    />
                  ) : null}
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
                    {isProjectSelected && chapters.length > 0 ? (
                      <span className="nwa-project-tree__badge">{chapters.length}</span>
                    ) : null}
                  </button>
                  {!selectMode ? (
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
                        aria-label={`重命名 ${project.name}`}
                      >
                        <Icon name="edit" />
                      </button>
                      <button
                        type="button"
                        className="nwa-button nwa-button--icon nwa-project-tree__action nwa-project-tree__action--danger"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(project);
                        }}
                        title="删除项目"
                        aria-label={`删除 ${project.name}`}
                      >
                        <Icon name="trash" />
                      </button>
                    </span>
                  ) : null}
                </div>
                {isProjectSelected && !selectMode ? (
                  <ul className="nwa-project-tree__sublist">
                    {chapters.length === 0 ? (
                      <li className="nwa-project-tree__sub-empty">暂无章节</li>
                    ) : (
                      chapters.map((chapter) => {
                        const isChapterSelected = chapter.id === selectedChapterId;
                        return (
                          <li key={chapter.id} className="nwa-project-tree__subnode">
                            <button
                              type="button"
                              className={`nwa-project-tree__sublabel${isChapterSelected ? ' nwa-project-tree__sublabel--selected' : ''}`}
                              aria-pressed={isChapterSelected}
                              onClick={() => onSelectChapter(chapter.id)}
                              title={chapter.title}
                            >
                              <span className="nwa-project-tree__subicon">
                                <Icon name="fileText" />
                              </span>
                              <span className="nwa-project-tree__subname">{chapter.title}</span>
                            </button>
                            <button
                              type="button"
                              className="nwa-button nwa-button--icon nwa-project-tree__action nwa-project-tree__action--danger nwa-project-tree__chapter-del"
                              disabled={busy}
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteChapterTarget({ projectId: project.id, chapter });
                              }}
                              title="删除章节"
                              aria-label={`删除章节 ${chapter.title}`}
                            >
                              <Icon name="trash" />
                            </button>
                          </li>
                        );
                      })
                    )}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {renameModal}
      {deleteModal}
      {deleteChapterModal}
      {bulkModal}
    </nav>
  );
}

export { isApiClientError };
export default ProjectTree;
