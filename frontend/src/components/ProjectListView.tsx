/**
 * Project list + creation entry (task 12.4, Requirement 8.1).
 *
 * Displays all saved projects (via `apiClient.projects.list`) and provides an
 * inline create form (`apiClient.projects.create`). Selecting a project invokes
 * `onSelectProject`. Optional rename / delete are supported via the
 * `apiClient.projects.rename` / `.remove` endpoints.
 *
 * Errors from the backend are surfaced through the injected `onError` callback
 * (wire it to the global error reporter from {@link ErrorProvider}) so the user
 * sees the failure reason (Requirement 8.6). The component owns only its local
 * list/loading state; composition into the app shell happens in task 13.2.
 */
import { useCallback, useEffect, useState } from 'react';
import apiClient, { isApiClientError } from '../api/apiClient.js';
import type { Id, Project } from '../types/index.js';
import { Icon } from './Icon.js';
import './components.css';

/** A project as returned by the list endpoint (id + name only). */
export type ProjectListItem = Pick<Project, 'id' | 'name'>;

export interface ProjectListViewProps {
  /** Currently selected project id (for highlighting), if any. */
  selectedProjectId?: Id | null;
  /** Invoked when the user selects a project. */
  onSelectProject: (projectId: Id) => void;
  /** Surface a backend/runtime error to the global error UI (Requirement 8.6). */
  onError?: (error: unknown) => void;
  /**
   * Injectable client (defaults to the shared {@link apiClient}). Primarily for
   * testing; production callers can omit it.
   */
  client?: Pick<typeof apiClient, 'projects'>;
}

/**
 * Renders the project list with a create-new entry and optional rename/delete.
 */
export function ProjectListView({
  selectedProjectId,
  onSelectProject,
  onError,
  client = apiClient,
}: ProjectListViewProps): JSX.Element {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  // In-app modals to replace native window.prompt / window.confirm (better immersion).
  const [renameTarget, setRenameTarget] = useState<ProjectListItem | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ProjectListItem | null>(null);

  const handleError = useCallback(
    (error: unknown) => {
      // AbortError is benign (component unmount / superseded request).
      if (error instanceof DOMException && error.name === 'AbortError') return;
      onError?.(error);
    },
    [onError],
  );

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const list = await client.projects.list(signal);
        setProjects(list);
      } catch (error) {
        handleError(error);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [client, handleError],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (name.length === 0 || busy) return;
    setBusy(true);
    try {
      const { id } = await client.projects.create(name);
      setProjects((current) => [...current, { id, name }]);
      setNewName('');
      onSelectProject(id);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }, [newName, busy, client, onSelectProject, handleError]);

  const openRename = useCallback((project: ProjectListItem) => {
    setRenameTarget(project);
    setRenameInput(project.name);
  }, []);

  const openDelete = useCallback((project: ProjectListItem) => {
    setDeleteTarget(project);
  }, []);

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
      // If deleted the currently selected project, the parent will naturally
      // show empty state on next interaction (no auto-clear to avoid type issues).
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  }, [deleteTarget, client, handleError, selectedProjectId, onSelectProject]);

  // Keep old names as wrappers for the list buttons (for minimal diff in onClick).
  const handleRename = useCallback((project: ProjectListItem) => openRename(project), [openRename]);
  const handleDelete = useCallback((project: ProjectListItem) => openDelete(project), [openDelete]);

  return (
    <>
      <section className="nwa-panel" aria-label="项目列表">
      <h2 className="nwa-panel__title">项目</h2>

      <div className="nwa-row">
        <input
          className="nwa-input nwa-grow"
          type="text"
          placeholder="输入新项目名称"
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
          className="nwa-button"
          disabled={busy || newName.trim().length === 0}
          onClick={() => void handleCreate()}
        >
          新建项目
        </button>
      </div>

      {loading ? (
        <p className="nwa-muted">加载中…</p>
      ) : projects.length === 0 ? (
        <p className="nwa-empty">还没有项目，先创建一个吧。</p>
      ) : (
        <ul className="nwa-list">
          {projects.map((project) => {
            const selected = project.id === selectedProjectId;
            return (
              <li
                key={project.id}
                className={`nwa-list__item${selected ? ' nwa-list__item--selected' : ''}`}
              >
                <button
                  type="button"
                  className="nwa-list__button"
                  aria-pressed={selected}
                  onClick={() => onSelectProject(project.id)}
                  title="点击选择此项目，查看资料与章节"
                >
                  {project.name}
                </button>
                <span className="nwa-list__actions">
                  <button
                    type="button"
                    className="nwa-button nwa-button--ghost"
                    disabled={busy}
                    onClick={(e) => { e.stopPropagation(); void handleRename(project); }}
                    title="重命名"
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    className="nwa-button nwa-button--danger"
                    disabled={busy}
                    onClick={(e) => { e.stopPropagation(); void handleDelete(project); }}
                    title="删除项目"
                  >
                    删除
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>

      {/* Rename modal (in-app, replaces window.prompt) */}
      {renameTarget ? (
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
                onKeyDown={(e) => { if (e.key === 'Enter') void doRename(); }}
                autoFocus
              />
            </div>
            <div className="nwa-modal-footer">
              <button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={() => setRenameTarget(null)}>取消</button>
              <button type="button" className="nwa-button" disabled={busy || !renameInput.trim()} onClick={() => void doRename()}>保存</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Delete confirm modal (in-app, replaces window.confirm) */}
      {deleteTarget ? (
        <div className="nwa-modal-overlay">
          <div className="nwa-modal" role="dialog" aria-label="删除确认" aria-modal="true">
            <div className="nwa-modal-header">
              <h2>删除项目</h2>
              <button type="button" className="nwa-modal-close" onClick={() => setDeleteTarget(null)} aria-label="关闭删除项目确认">
                <Icon name="x" />
              </button>
            </div>
            <div className="nwa-modal-body">
              <p>确定要删除项目「{deleteTarget.name}」吗？此操作不可撤销，所有章节与资料将一并删除。</p>
            </div>
            <div className="nwa-modal-footer">
              <button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={() => setDeleteTarget(null)}>取消</button>
              <button type="button" className="nwa-button nwa-button--danger" disabled={busy} onClick={() => void doDelete()}>确认删除</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

// Re-export for callers that want to detect ApiClientError near this view.
export { isApiClientError };

export default ProjectListView;
