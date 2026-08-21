/**
 * Unit tests for {@link ChapterEditor} (task 12.5, Requirements 8.3, 8.4).
 *
 * Covers:
 *  - Displaying the selected chapter's content for editing (Requirement 8.3).
 *  - Submitting a content update request to the backend on save (Requirement 8.4).
 *  - Reloading content when a different chapter is selected.
 *  - Surfacing backend errors via `onError` (Requirement 8.6).
 */
import { createRef } from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Chapter, Id } from '../types/index.js';
import {
  ChapterEditor,
  type ChapterEditorClient,
  type ChapterEditorHandle,
} from './ChapterEditor.js';

function makeChapter(overrides: Partial<Chapter> = {}): Chapter {
  return {
    id: 'ch-1',
    projectId: 'p-1',
    title: '第一章',
    content: '初始正文内容',
    position: 0,
    ...overrides,
  };
}

/** Build a mock client whose `updateContent` records calls. */
function makeClient(
  updateContent: (id: Id, content: string) => Promise<void> = () => Promise.resolve(),
): ChapterEditorClient {
  return {
    chapters: {
      list: vi.fn(),
      create: vi.fn(),
      updateContent: vi.fn(updateContent),
      remove: vi.fn(),
      reorder: vi.fn(),
    },
  } as unknown as ChapterEditorClient;
}

describe('ChapterEditor', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('displays the selected chapter content and title (Requirement 8.3)', () => {
    const chapter = makeChapter({ title: '序章', content: '从前有座山' });
    render(<ChapterEditor chapter={chapter} client={makeClient()} />);

    const textarea = screen.getByRole('textbox', { name: '章节正文' });
    expect(textarea).toHaveValue('从前有座山');
    expect(screen.getByRole('heading', { name: '序章' })).toBeInTheDocument();
  });

  it('renders an empty placeholder when no chapter is selected', () => {
    render(<ChapterEditor chapter={null} client={makeClient()} />);
    expect(screen.getByText('请选择一个章节开始编辑。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('submits a content update request via apiClient on save (Requirement 8.4)', async () => {
    const client = makeClient();
    const onSaved = vi.fn();
    render(<ChapterEditor chapter={makeChapter()} client={client} onSaved={onSaved} />);

    const textarea = screen.getByRole('textbox', { name: '章节正文' });
    fireEvent.change(textarea, { target: { value: '修改后的正文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(client.chapters.updateContent).toHaveBeenCalledWith('ch-1', '修改后的正文');
    });
    expect(onSaved).toHaveBeenCalledWith('ch-1', '修改后的正文');
  });

  it('saves via Ctrl+S keyboard shortcut', async () => {
    const client = makeClient();
    render(<ChapterEditor chapter={makeChapter()} client={client} />);

    const textarea = screen.getByRole('textbox', { name: '章节正文' });
    fireEvent.change(textarea, { target: { value: '快捷键保存' } });
    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true });

    await waitFor(() => {
      expect(client.chapters.updateContent).toHaveBeenCalledWith('ch-1', '快捷键保存');
    });
  });

  it('reloads content when a different chapter is selected (Requirement 8.3)', () => {
    const client = makeClient();
    const { rerender } = render(
      <ChapterEditor chapter={makeChapter({ id: 'ch-1', content: 'A 内容' })} client={client} />,
    );
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('A 内容');

    rerender(
      <ChapterEditor chapter={makeChapter({ id: 'ch-2', content: 'B 内容' })} client={client} />,
    );
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('B 内容');
  });

  it('surfaces backend errors via onError (Requirement 8.6)', async () => {
    const failure = new Error('存储失败');
    const client = makeClient(() => Promise.reject(failure));
    const onError = vi.fn();
    render(<ChapterEditor chapter={makeChapter()} client={client} onError={onError} />);

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(failure);
    });
  });

  it('rejects saveIfDirty when persistence fails so navigation can stay put', async () => {
    const failure = new Error('存储失败');
    const client = makeClient(() => Promise.reject(failure));
    const onError = vi.fn();
    const ref = createRef<ChapterEditorHandle>();
    render(<ChapterEditor ref={ref} chapter={makeChapter()} client={client} onError={onError} />);

    fireEvent.change(screen.getByRole('textbox', { name: '章节正文' }), {
      target: { value: '不能丢失的修改' },
    });

    await act(async () => {
      await expect(ref.current!.saveIfDirty()).rejects.toBe(failure);
    });
    expect(onError).toHaveBeenCalledWith(failure);
    expect(screen.getByText('未保存')).toBeInTheDocument();
  });

  it('waits for an in-flight save and then persists edits made during it', async () => {
    let resolveFirst!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const updateContent = vi.fn((_id: Id, content: string) => (
      content === '第一版' ? firstRequest : Promise.resolve()
    ));
    const client = makeClient(updateContent);
    const ref = createRef<ChapterEditorHandle>();
    render(<ChapterEditor ref={ref} chapter={makeChapter()} client={client} />);

    const textarea = screen.getByRole('textbox', { name: '章节正文' });
    fireEvent.change(textarea, { target: { value: '第一版' } });
    let firstSave!: Promise<void>;
    act(() => {
      firstSave = ref.current!.saveIfDirty();
    });
    await waitFor(() => {
      expect(updateContent).toHaveBeenCalledWith('ch-1', '第一版');
    });

    fireEvent.change(textarea, { target: { value: '保存期间写下的最新版' } });
    let navigationFlush!: Promise<void>;
    act(() => {
      navigationFlush = ref.current!.saveIfDirty();
    });
    await act(async () => {
      resolveFirst();
      await Promise.all([firstSave, navigationFlush]);
    });

    expect(updateContent.mock.calls).toEqual([
      ['ch-1', '第一版'],
      ['ch-1', '保存期间写下的最新版'],
    ]);
    expect(screen.queryByText('未保存')).not.toBeInTheDocument();
  });

  it('mirrors edits through onContentChange for composition', () => {
    const onContentChange = vi.fn();
    render(
      <ChapterEditor
        chapter={makeChapter()}
        client={makeClient()}
        onContentChange={onContentChange}
      />,
    );

    const textarea = screen.getByRole('textbox', { name: '章节正文' });
    fireEvent.change(textarea, { target: { value: '新增文字' } });
    expect(onContentChange).toHaveBeenCalledWith('新增文字');
  });

  it('keeps an undo point when controlled adopted content replaces the chapter', () => {
    const { rerender } = render(<ChapterEditor chapter={makeChapter()} client={makeClient()} />);

    const textarea = screen.getByRole('textbox', { name: '章节正文' });
    rerender(
      <ChapterEditor
        chapter={makeChapter()}
        client={makeClient()}
        contentOverride="AI 生成后的整章正文"
      />,
    );

    expect(textarea).toHaveValue('AI 生成后的整章正文');
    fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true });
    expect(textarea).toHaveValue('初始正文内容');
    fireEvent.keyDown(textarea, { key: 'y', ctrlKey: true });
    expect(textarea).toHaveValue('AI 生成后的整章正文');
  });

  it('renders Markdown preview for headings, emphasis, lists and quotes', () => {
    render(
      <ChapterEditor
        chapter={makeChapter({ content: '## 场景标题\n普通 **重点**\n- 线索\n> 旁白' })}
        client={makeClient()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '预览' }));

    expect(screen.getByRole('heading', { name: '场景标题' })).toBeInTheDocument();
    expect(screen.getByText('重点').closest('strong')).not.toBeNull();
    expect(screen.getByText('线索').closest('li')).not.toBeNull();
    expect(screen.getByText('旁白').closest('blockquote')).not.toBeNull();
  });

  it('inserts Markdown formatting through the toolbar and keeps undo working', async () => {
    render(<ChapterEditor chapter={makeChapter({ content: '需要强调' })} client={makeClient()} />);

    const textarea = screen.getByRole('textbox', { name: '章节正文' }) as HTMLTextAreaElement;
    textarea.setSelectionRange(0, 2);
    fireEvent.click(screen.getByRole('button', { name: '加粗' }));

    await waitFor(() => {
      expect(textarea).toHaveValue('**需要**强调');
    });
    fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true });
    expect(textarea).toHaveValue('需要强调');
  });

  it('stores a save-time snapshot and restores it into the editor', async () => {
    const client = makeClient();
    render(<ChapterEditor chapter={makeChapter()} client={client} />);

    const textarea = screen.getByRole('textbox', { name: '章节正文' });
    fireEvent.change(textarea, { target: { value: '第二版正文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '历史 1' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '历史 1' }));
    expect(screen.getByText('初始正文内容')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '恢复到编辑器' }));
    expect(textarea).toHaveValue('初始正文内容');
    expect(screen.getByText('未保存')).toBeInTheDocument();
  });

  it('resets scroll position and caret to the top when switching chapters', () => {
    const client = makeClient();
    const { rerender } = render(
      <ChapterEditor chapter={makeChapter({ id: 'ch-1', content: 'A'.repeat(5000) })} client={client} />,
    );
    const textarea = screen.getByRole('textbox', { name: '章节正文' }) as HTMLTextAreaElement;

    // 模拟用户把第一章滚动到底部、光标停在末尾。
    textarea.scrollTop = 800;
    textarea.setSelectionRange(4000, 4000);

    // 切换到第二章。
    rerender(
      <ChapterEditor chapter={makeChapter({ id: 'ch-2', content: 'B'.repeat(5000) })} client={client} />,
    );

    // 滚动位置与光标都应回到顶部，而不是继承上一章的位置。
    expect(textarea.scrollTop).toBe(0);
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(0);
  });
});
