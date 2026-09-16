/**
 * Unit tests for {@link MergedChapterView} (task 12.5, Requirement 14.5).
 *
 * Covers Requirement 14.5 — clicking "合并整章" invokes `client.blueprint.merge`
 * and previews the returned `content`; clicking "采用到章节" invokes
 * `onAdoptChapterContent(content)` to write the merged text back to the chapter
 * editor.
 *
 * The injected client is the minimal `Pick<typeof apiClient, 'blueprint'>`
 * subset; methods are `vi.fn()`. Interaction uses `fireEvent`.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MergedChapterView, type MergedChapterClient } from './MergedChapterView.js';

function makeClient(overrides: Partial<MergedChapterClient['blueprint']> = {}): MergedChapterClient {
  return {
    blueprint: {
      get: vi.fn(),
      generate: vi.fn(),
      merge: vi.fn(),
      wordCount: { run: vi.fn(), get: vi.fn() },
      pacing: { run: vi.fn(), get: vi.fn() },
      writeScene: vi.fn(),
      expandScene: vi.fn(),
      rewriteScene: vi.fn(),
      assembleChapter: vi.fn(),
      ...overrides,
    },
  } as unknown as MergedChapterClient;
}

describe('MergedChapterView', () => {
  it.each(['false', 'rejection'])('does not mark adoption successful when the parent returns %s', async (outcome) => {
    const chapter = { id: 'ch-1', projectId: 'p-1', title: '第一章', content: '合并结果', position: 0, revision: 4 };
    const onAdoptChapterContent = outcome === 'false' ? vi.fn().mockResolvedValue(false) : vi.fn().mockRejectedValue(new Error('编辑器拒绝覆盖'));
    const onError = vi.fn();
    render(<MergedChapterView chapterId="ch-1" client={makeClient({ merge: vi.fn().mockResolvedValue({ content: chapter.content, chapter }) })} onAdoptChapterContent={onAdoptChapterContent} onError={onError} />);
    fireEvent.click(screen.getByRole('button', { name: '合并整章' }));
    await screen.findByText('合并结果');
    fireEvent.click(screen.getByRole('button', { name: '采用到章节' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '采用到章节' })).toBeEnabled());
    expect(onAdoptChapterContent).toHaveBeenCalled();
    expect(screen.queryByText('已采用')).not.toBeInTheDocument();
    if (outcome === 'rejection') expect(onError).toHaveBeenCalled();
  });
  it('merges via client.blueprint.merge and previews the returned content (Requirement 14.5)', async () => {
    const merged = '第一幕正文。\n\n第二幕正文。';
    const merge = vi.fn().mockResolvedValue({ content: merged });
    const client = makeClient({ merge });
    render(<MergedChapterView chapterId="ch-1" client={client} />);

    fireEvent.click(screen.getByRole('button', { name: '合并整章' }));

    await waitFor(() => expect(merge).toHaveBeenCalledWith('ch-1'));
    // The merged content is previewed.
    expect(await screen.findByText(/第一幕正文。/)).toBeInTheDocument();
    expect(screen.getByText(/第二幕正文。/)).toBeInTheDocument();
  });

  it('invokes onAdoptChapterContent(content) when 采用到章节 is clicked (Requirement 14.5)', async () => {
    const merged = '合并后的整章正文';
    const chapter = { id: 'ch-1', projectId: 'p-1', content: merged, title: '第一章', position: 0, revision: 4 };
    const merge = vi.fn().mockResolvedValue({ content: merged, chapter });
    const onAdoptChapterContent = vi.fn().mockReturnValue(true);
    const client = makeClient({ merge });
    render(
      <MergedChapterView
        chapterId="ch-1"
        onAdoptChapterContent={onAdoptChapterContent}
        client={client}
      />,
    );

    // Adopt is disabled until a merge has produced content.
    const adoptButton = () =>
      screen.getByRole('button', { name: '采用到章节' }) as HTMLButtonElement;
    expect(adoptButton()).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '合并整章' }));
    await waitFor(() => expect(merge).toHaveBeenCalled());
    await waitFor(() => expect(adoptButton()).toBeEnabled());

    fireEvent.click(adoptButton());

    expect(onAdoptChapterContent).toHaveBeenCalledTimes(1);
    expect(onAdoptChapterContent).toHaveBeenCalledWith(merged, chapter, '');
    // Adoption acknowledgement.
    expect(await screen.findByText('已采用')).toBeInTheDocument();
  });

  it('surfaces merge errors via onError (Requirement 14.6)', async () => {
    const failure = new Error('存在未写作场景');
    const merge = vi.fn().mockRejectedValue(failure);
    const onError = vi.fn();
    const client = makeClient({ merge });
    render(<MergedChapterView chapterId="ch-1" onError={onError} client={client} />);

    fireEvent.click(screen.getByRole('button', { name: '合并整章' }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
  });

  it('ignores a late merge after switching chapters', async () => {
    let resolve!: (value: { content: string }) => void;
    const client = makeClient({ merge: vi.fn(() => new Promise<{ content: string }>((done) => { resolve = done; })) });
    const { rerender } = render(<MergedChapterView chapterId="ch-1" client={client} />);
    fireEvent.click(screen.getByRole('button', { name: '合并整章' }));
    rerender(<MergedChapterView chapterId="ch-2" client={client} />);
    await act(async () => resolve({ content: '迟到旧章' }));
    expect(screen.queryByText('迟到旧章')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '采用到章节' })).toBeDisabled();
  });

  it('does not treat a legacy merge response as a saved chapter', async () => {
    const onAdoptChapterContent = vi.fn().mockReturnValue(true);
    const onError = vi.fn();
    render(<MergedChapterView chapterId="ch-1" client={makeClient({ merge: vi.fn().mockResolvedValue({ content: '旧结果' }) })} onAdoptChapterContent={onAdoptChapterContent} onError={onError} />);
    fireEvent.click(screen.getByRole('button', { name: '合并整章' }));
    await screen.findByText('旧结果');
    fireEvent.click(screen.getByRole('button', { name: '采用到章节' }));
    expect(onAdoptChapterContent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });
});
