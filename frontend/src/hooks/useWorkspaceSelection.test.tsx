import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/apiClient.js', () => ({
  default: {
    projects: { list: vi.fn() },
    chapters: { list: vi.fn() },
  },
}));

import apiClient from '../api/apiClient.js';
import { useWorkspaceSelection } from './useWorkspaceSelection.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('useWorkspaceSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.projects.list).mockResolvedValue([]);
    vi.mocked(apiClient.chapters.list).mockResolvedValue([]);
  });

  it('ignores a slower project-name response after the user selects another project', async () => {
    const first = deferred<Array<{ id: string; name: string; kind: 'novel' }>>();
    const second = deferred<Array<{ id: string; name: string; kind: 'novel' }>>();
    vi.mocked(apiClient.projects.list)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useWorkspaceSelection({ reportError: vi.fn() }));

    act(() => result.current.selectProject('p-1'));
    act(() => result.current.selectProject('p-2'));
    await act(async () => second.resolve([{ id: 'p-2', name: '新项目', kind: 'novel' }]));
    await waitFor(() => expect(result.current.selectedProjectName).toBe('新项目'));
    await act(async () => first.resolve([{ id: 'p-1', name: '旧项目', kind: 'novel' }]));

    expect(result.current.selectedProjectId).toBe('p-2');
    expect(result.current.selectedProjectName).toBe('新项目');
  });

  it('ignores a slower chapter response after the user opens another chapter', async () => {
    const first = deferred<Awaited<ReturnType<typeof apiClient.chapters.list>>>();
    const second = deferred<Awaited<ReturnType<typeof apiClient.chapters.list>>>();
    vi.mocked(apiClient.chapters.list)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useWorkspaceSelection({ reportError: vi.fn() }));

    act(() => void result.current.loadChapter('p-1', 'ch-1'));
    act(() => void result.current.loadChapter('p-2', 'ch-2'));
    await act(async () => second.resolve([
      { id: 'ch-2', projectId: 'p-2', title: '新章节', content: '新正文', position: 0 },
    ]));
    await waitFor(() => expect(result.current.selectedChapter?.id).toBe('ch-2'));
    await act(async () => first.resolve([
      { id: 'ch-1', projectId: 'p-1', title: '旧章节', content: '旧正文', position: 0 },
    ]));

    expect(result.current.selectedProjectId).toBe('p-2');
    expect(result.current.selectedChapter?.id).toBe('ch-2');
    expect(result.current.editorContent).toBe('新正文');
  });

  it('does not let a completed task reopen its source after the user changed projects', () => {
    const { result } = renderHook(() => useWorkspaceSelection({ reportError: vi.fn() }));
    act(() => result.current.selectCreatedProject('p-new', '新项目'));

    act(() => result.current.applyAgentResult({
      task: 'outline',
      mode: 'reference',
      projectId: 'p-old',
      summary: '旧任务完成',
      steps: [],
      artifacts: [],
    }, 'p-old'));

    expect(result.current.selectedProjectId).toBe('p-new');
    expect(result.current.selectedProjectName).toBe('新项目');
  });

  it('does not replace the chapter the user is editing when an agent job finishes', async () => {
    vi.mocked(apiClient.chapters.list).mockResolvedValue([
      { id: 'ch-open', projectId: 'p-1', title: '正在编辑', content: '手头正文', position: 0 },
      { id: 'ch-new', projectId: 'p-1', title: '新生成', content: '生成正文', position: 1 },
    ]);
    const { result } = renderHook(() => useWorkspaceSelection({ reportError: vi.fn() }));

    await act(async () => {
      await result.current.loadChapter('p-1', 'ch-open');
    });
    act(() => result.current.setEditorContent('尚未保存的正文'));
    await act(async () => {
      result.current.applyAgentResult({
        task: 'auto_next',
        mode: 'draft',
        projectId: 'p-1',
        chapterId: 'ch-new',
        summary: '已写下一章',
        steps: [],
        artifacts: [],
      }, 'p-1');
    });

    expect(result.current.selectedChapterId).toBe('ch-open');
    expect(result.current.editorContent).toBe('尚未保存的正文');
  });

  it('updates the selected project name and ignores an older lookup response', async () => {
    const pending = deferred<Array<{ id: string; name: string; kind: 'short_drama' }>>();
    vi.mocked(apiClient.projects.list).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useWorkspaceSelection({ reportError: vi.fn() }));

    act(() => result.current.selectProject('p-1'));
    act(() => result.current.handleProjectRenamed('p-1', '新项目名'));
    expect(result.current.selectedProjectName).toBe('新项目名');

    await act(async () => pending.resolve([{ id: 'p-1', name: '旧项目名', kind: 'short_drama' }]));
    expect(result.current.selectedProjectName).toBe('新项目名');
  });

  it('updates the selected chapter title without replacing editor content', async () => {
    vi.mocked(apiClient.chapters.list).mockResolvedValue([
      { id: 'ch-1', projectId: 'p-1', title: '旧章名', content: '已保存正文', position: 0 },
    ]);
    const { result } = renderHook(() => useWorkspaceSelection({ reportError: vi.fn() }));

    await act(async () => {
      await result.current.loadChapter('p-1', 'ch-1');
    });
    act(() => result.current.setEditorContent('尚未保存的正文'));
    act(() => result.current.handleChapterRenamed({
      id: 'ch-1',
      projectId: 'p-1',
      title: '新章名',
      content: '接口返回的旧正文',
      position: 0,
    }));

    expect(result.current.selectedChapter?.title).toBe('新章名');
    expect(result.current.selectedChapter?.content).toBe('已保存正文');
    expect(result.current.editorContent).toBe('尚未保存的正文');
  });
});
