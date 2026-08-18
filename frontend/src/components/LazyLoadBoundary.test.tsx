import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LazyLoadBoundary } from './LazyLoadBoundary.js';

function BrokenWorkspace(): JSX.Element {
  throw new Error('chunk fetch failed');
}

describe('LazyLoadBoundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps a failed workspace local and offers an explicit retry', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const retry = vi.fn();
    render(
      <LazyLoadBoundary label="短剧工作台" onRetry={retry}>
        <BrokenWorkspace />
      </LazyLoadBoundary>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('短剧工作台加载失败');
    fireEvent.click(screen.getByRole('button', { name: '刷新并重试' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
