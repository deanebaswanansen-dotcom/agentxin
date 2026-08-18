import { useCallback, useRef, useState } from 'react';
import apiClient from '../api/apiClient.js';
import type { AgentRunResult, Chapter, Id } from '../types/index.js';
import type { EditorSelection } from '../components/ChapterEditor.js';

interface UseWorkspaceSelectionOptions {
  reportError: (error: unknown) => void;
  onOpenChapterTools?: () => void;
  onClearChapterTools?: () => void;
}

export function useWorkspaceSelection({
  reportError,
  onOpenChapterTools,
  onClearChapterTools,
}: UseWorkspaceSelectionOptions) {
  const [selectedProjectId, setSelectedProjectId] = useState<Id | null>(null);
  const [selectedProjectName, setSelectedProjectName] = useState<string | undefined>(undefined);
  const [selectedChapterId, setSelectedChapterId] = useState<Id | null>(null);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null);
  const [projectListVersion, setProjectListVersion] = useState(0);
  const [editorContent, setEditorContent] = useState('');
  const [selection, setSelection] = useState<EditorSelection | undefined>(undefined);
  const projectNameRequestRef = useRef(0);
  const chapterRequestRef = useRef(0);

  const bumpProjectList = useCallback(() => {
    setProjectListVersion((version) => version + 1);
  }, []);

  const selectProjectNameFromServer = useCallback((projectId: Id) => {
    const requestId = ++projectNameRequestRef.current;
    void apiClient.projects
      .list()
      .then((list) => {
        if (requestId !== projectNameRequestRef.current) return;
        const found = list.find((p) => p.id === projectId);
        setSelectedProjectName(found?.name);
      })
      .catch(() => {
        /* Project name is cosmetic; keep the previous value on lookup failure. */
      });
  }, []);

  const resetChapter = useCallback(() => {
    chapterRequestRef.current += 1;
    setSelectedChapterId(null);
    setSelectedChapter(null);
    setEditorContent('');
    setSelection(undefined);
  }, []);

  const loadChapter = useCallback(
    async (projectId: Id, chapterId: Id, opts?: { openTools?: boolean }) => {
      const requestId = ++chapterRequestRef.current;
      setSelectedProjectId(projectId);
      setSelectedChapterId(chapterId);
      try {
        const chapters = await apiClient.chapters.list(projectId);
        if (requestId !== chapterRequestRef.current) return;
        const found = chapters.find((chapter) => chapter.id === chapterId) ?? null;
        setSelectedChapter(found);
        setEditorContent(found?.content ?? '');
        setSelection(undefined);
        if (opts?.openTools === true) {
          onOpenChapterTools?.();
        }
      } catch (error) {
        if (requestId !== chapterRequestRef.current) return;
        reportError(error);
      }
    },
    [onOpenChapterTools, reportError],
  );

  const selectProject = useCallback(
    (projectId: Id) => {
      setSelectedProjectId(projectId);
      resetChapter();
      selectProjectNameFromServer(projectId);
    },
    [resetChapter, selectProjectNameFromServer],
  );

  const selectCreatedProject = useCallback((projectId: Id, projectName: string) => {
    projectNameRequestRef.current += 1;
    setSelectedProjectId(projectId);
    setSelectedProjectName(projectName);
    resetChapter();
  }, [resetChapter]);

  const clearSelectedChapter = useCallback(
    (chapterId?: Id) => {
      if (chapterId !== undefined && selectedChapterId !== chapterId) return;
      resetChapter();
      onClearChapterTools?.();
    },
    [onClearChapterTools, resetChapter, selectedChapterId],
  );

  const clearSelectedProject = useCallback(
    (projectId?: Id) => {
      if (projectId !== undefined && selectedProjectId !== projectId) return;
      projectNameRequestRef.current += 1;
      setSelectedProjectId(null);
      setSelectedProjectName(undefined);
      clearSelectedChapter();
      bumpProjectList();
    },
    [bumpProjectList, clearSelectedChapter, selectedProjectId],
  );

  const applyAgentResult = useCallback(
    (result: AgentRunResult, sourceProjectId?: Id | null) => {
      bumpProjectList();
      // 任务可能运行数十秒。期间用户切换/新建项目后，旧任务的结果仍会
      // 返回，但不能把当前工作区切回旧项目或打开旧章节。
      if (
        sourceProjectId !== undefined &&
        selectedProjectId !== sourceProjectId
      ) {
        return;
      }
      setSelectedProjectId(result.projectId);
      selectProjectNameFromServer(result.projectId);
      if (result.chapterId !== undefined) {
        // 直接打开刚生成的章节，避免只清空编辑器、用户以为还在「生成中」。
        void loadChapter(result.projectId, result.chapterId);
      }
    },
    [bumpProjectList, loadChapter, selectProjectNameFromServer, selectedProjectId],
  );

  const handleSaved = useCallback((chapterId: Id, content: string) => {
    setSelectedChapter((prev) => {
      if (prev && prev.id === chapterId) {
        return { ...prev, content };
      }
      return prev;
    });
  }, []);

  const handleChapterRenamed = useCallback((chapter: Chapter) => {
    setSelectedChapter((prev) => {
      if (prev && prev.id === chapter.id) {
        // Keep the editor's current content; a title-only rename must not replace
        // unsaved text with the content returned by the rename endpoint.
        return { ...prev, title: chapter.title };
      }
      return prev;
    });
  }, []);

  return {
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
    handleChapterRenamed,
  };
}

