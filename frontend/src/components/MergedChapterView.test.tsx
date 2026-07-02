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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    const merge = vi.fn().mockResolvedValue({ content: merged });
    const onAdoptChapterContent = vi.fn();
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
    expect(onAdoptChapterContent).toHaveBeenCalledWith(merged);
    // Adoption acknowledgement.
    expect(screen.getByText('已采用')).toBeInTheDocument();
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
});
