import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/apiClient.js';
import type { Chapter } from '../types/index.js';
import { AcceptChapterSource } from './AcceptChapterSource.js';

const chapter: Chapter = { id: 'ch-1', projectId: 'p-1', position: 0, title: '第一章', content: '钥匙在门外。', revision: 3 };
function fixture() {
  const preview = { chapterId: chapter.id, title: chapter.title, content: chapter.content, revision: 3, contentHash: 'hidden-content-hash' };
  const chapters = { sourcePreview: vi.fn().mockResolvedValue(preview), acceptSource: vi.fn().mockResolvedValue(chapter) };
  const beforePreview = vi.fn().mockResolvedValue(undefined);
  const onAccepted = vi.fn();
  const props = { chapter, editorContent: chapter.content, editorVersion: 1, beforePreview, onAccepted,
    client: { chapters } as unknown as NonNullable<Parameters<typeof AcceptChapterSource>[0]['client']> };
  return { preview, chapters, props, beforePreview, onAccepted };
}

describe('AcceptChapterSource', () => {
  it('flushes then shows the complete saved body, and accepts only after an explicit confirmation', async () => {
    const f = fixture();
    render(<AcceptChapterSource {...f.props} />);
    fireEvent.click(screen.getByRole('button', { name: '查看并接受正文来源' }));
    expect(await screen.findByText(chapter.content)).toBeInTheDocument();
    expect(f.beforePreview.mock.invocationCallOrder[0]).toBeLessThan(f.chapters.sourcePreview.mock.invocationCallOrder[0]);
    expect(screen.queryByText('hidden-content-hash')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认接受为来源' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '确认接受为来源' }));
    await screen.findByText('所确认的已保存正文已接受为来源，记忆同步独立进行。');
    expect(f.chapters.acceptSource).toHaveBeenCalledWith('ch-1', { expectedRevision: 3, expectedContentHash: 'hidden-content-hash' }, expect.any(AbortSignal));
    expect(f.onAccepted).toHaveBeenCalledWith(chapter);
  });

  it('keeps the frozen preview on a conflict and disables it when the editor changes', async () => {
    const f = fixture();
    f.chapters.acceptSource.mockRejectedValue(new ApiClientError({ error: { code: 'CONFLICT', message: 'internal stack' } }, 409));
    const { rerender } = render(<AcceptChapterSource {...f.props} />);
    fireEvent.click(screen.getByRole('button', { name: '查看并接受正文来源' }));
    await screen.findByText(chapter.content);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '确认接受为来源' }));
    await screen.findByText(/正文版本已变化/);
    expect(screen.getByText(chapter.content)).toBeInTheDocument();
    expect(screen.queryByText('internal stack')).not.toBeInTheDocument();
    rerender(<AcceptChapterSource {...f.props} editorVersion={2} editorContent="手工新稿" />);
    expect(screen.getByRole('button', { name: '确认接受为来源' })).toBeDisabled();
    expect(f.onAccepted).not.toHaveBeenCalled();
  });

  it('ignores delayed preview and acceptance callbacks after local edits or unmount', async () => {
    const f = fixture();
    let resolve!: (value: typeof f.preview) => void;
    f.chapters.sourcePreview.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const view = render(<AcceptChapterSource {...f.props} />);
    fireEvent.click(screen.getByRole('button', { name: '查看并接受正文来源' }));
    await act(async () => {});
    view.rerender(<AcceptChapterSource {...f.props} editorVersion={2} />);
    await act(async () => resolve(f.preview));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看并接受正文来源' }));
    await screen.findByText(chapter.content);
    let accept!: (value: Chapter) => void;
    f.chapters.acceptSource.mockImplementationOnce(() => new Promise((done) => { accept = done; }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '确认接受为来源' }));
    view.unmount();
    await act(async () => accept(chapter));
    expect(f.onAccepted).not.toHaveBeenCalled();
  });
});
