/**
 * Unit tests for {@link SceneStreamView} (task 12.5, Requirement 14.3).
 *
 * Covers Requirement 14.3 — the view forwards the scene write/expand/rewrite
 * request to the injected client and appends each streamed text delta
 * (pushed via `options.onDelta`) to the live render, showing the full text once
 * the stream resolves.
 *
 * Two mock styles are used:
 *  - A controllable (deferred) `writeScene` mock to deterministically observe
 *    the accumulating live text mid-stream and the final full text on
 *    completion.
 *  - A simple immediate-resolving streaming mock that calls `onDelta` twice and
 *    returns the concatenation, used to assert that expand requires `addWords`
 *    and rewrite requires `instruction` before the action can start, and that
 *    the correct body is sent.
 *
 * Interaction uses `fireEvent` (matching the existing component tests; the
 * project does not depend on `@testing-library/user-event`).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SceneStreamView, type SceneStreamClient } from './SceneStreamView.js';

/** A deferred streaming controller so the test can drive deltas + completion. */
interface StreamController {
  client: SceneStreamClient;
  resolve: (full: string) => void;
  onDelta: () => ((delta: string) => void) | undefined;
}

function makeDeferredWriteClient(): StreamController {
  let resolveFn: (full: string) => void = () => {};
  let capturedOnDelta: ((delta: string) => void) | undefined;

  const writeScene = vi.fn(
    (_chapterId: string, _sceneId: string, options?: { onDelta?: (d: string) => void }) => {
      capturedOnDelta = options?.onDelta;
      return new Promise<string>((resolve) => {
        resolveFn = resolve;
      });
    },
  );

  return {
    client: { blueprint: { writeScene } } as unknown as SceneStreamClient,
    resolve: (full) => resolveFn(full),
    onDelta: () => capturedOnDelta,
  };
}

/** Streaming mock that pushes two deltas then resolves to their concatenation. */
function makeImmediateStreamFn() {
  return vi.fn(async (...args: unknown[]) => {
    const options = args[args.length - 1] as { onDelta?: (d: string) => void } | undefined;
    options?.onDelta?.('片段1');
    options?.onDelta?.('片段2');
    return '片段1片段2';
  });
}

describe('SceneStreamView', () => {
  it('appends streamed deltas as they arrive and shows the full text on completion (Requirement 14.3)', async () => {
    const ctrl = makeDeferredWriteClient();
    render(
      <SceneStreamView
        chapterId="ch-1"
        sceneId="scene-1"
        operation="write"
        client={ctrl.client}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '开始写作' }));

    // Streaming indicator appears.
    expect(await screen.findByText('生成中…')).toBeInTheDocument();
    expect(ctrl.client.blueprint.writeScene).toHaveBeenCalledWith(
      'ch-1',
      'scene-1',
      expect.objectContaining({ onDelta: expect.any(Function) }),
    );

    // First delta is appended to the live render.
    act(() => ctrl.onDelta()?.('片段1'));
    expect(screen.getByText('片段1')).toBeInTheDocument();

    // Second delta accumulates onto the first.
    act(() => ctrl.onDelta()?.('片段2'));
    expect(screen.getByText('片段1片段2')).toBeInTheDocument();

    // Completing the stream shows the full text and clears the indicator.
    await act(async () => {
      ctrl.resolve('片段1片段2');
    });

    await waitFor(() => expect(screen.queryByText('生成中…')).not.toBeInTheDocument());
    expect(screen.getByText('片段1片段2')).toBeInTheDocument();
  });

  it('requires addWords before expand can start and sends {addWords} (Requirement 14.3)', async () => {
    const expandScene = makeImmediateStreamFn();
    const onComplete = vi.fn();
    const client = { blueprint: { expandScene } } as unknown as SceneStreamClient;
    render(
      <SceneStreamView
        chapterId="ch-1"
        sceneId="scene-1"
        operation="expand"
        onComplete={onComplete}
        client={client}
      />,
    );

    const startButton = () => screen.getByRole('button', { name: '开始扩写' }) as HTMLButtonElement;

    // Clearing the new-word-count input disables start.
    fireEvent.change(screen.getByLabelText('新增字数'), { target: { value: '' } });
    expect(startButton()).toBeDisabled();

    // A valid count enables start.
    fireEvent.change(screen.getByLabelText('新增字数'), { target: { value: '800' } });
    expect(startButton()).toBeEnabled();

    await act(async () => {
      fireEvent.click(startButton());
    });

    expect(expandScene).toHaveBeenCalledWith(
      'ch-1',
      'scene-1',
      { addWords: 800 },
      expect.objectContaining({ onDelta: expect.any(Function) }),
    );
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith('片段1片段2'));
    expect(screen.getByText('片段1片段2')).toBeInTheDocument();
  });

  it('requires instruction before rewrite can start and sends {instruction} (Requirement 14.3)', async () => {
    const rewriteScene = makeImmediateStreamFn();
    const onComplete = vi.fn();
    const client = { blueprint: { rewriteScene } } as unknown as SceneStreamClient;
    render(
      <SceneStreamView
        chapterId="ch-1"
        sceneId="scene-1"
        operation="rewrite"
        onComplete={onComplete}
        client={client}
      />,
    );

    const startButton = () => screen.getByRole('button', { name: '开始重写' }) as HTMLButtonElement;

    // Empty instruction -> start disabled.
    expect(startButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText('修改要求'), {
      target: { value: '让冲突更激烈' },
    });
    expect(startButton()).toBeEnabled();

    await act(async () => {
      fireEvent.click(startButton());
    });

    expect(rewriteScene).toHaveBeenCalledWith(
      'ch-1',
      'scene-1',
      { instruction: '让冲突更激烈' },
      expect.objectContaining({ onDelta: expect.any(Function) }),
    );
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith('片段1片段2'));
    expect(screen.getByText('片段1片段2')).toBeInTheDocument();
  });
});
