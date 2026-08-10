import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SlashMenu } from './SlashMenu.js';

describe('SlashMenu', () => {
  it('selects an exact slash command on Enter instead of Mock mode', () => {
    const onSelectTask = vi.fn();
    const onSelectMock = vi.fn();

    render(
      <SlashMenu
        query="/参考"
        hasProject
        onSelectTask={onSelectTask}
        onSelectMock={onSelectMock}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole('option', { name: /演示模式/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /\/参考 · 小说内容拆解/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    fireEvent.keyDown(window, { key: 'Enter' });

    expect(onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ key: 'reference' }));
    expect(onSelectMock).not.toHaveBeenCalled();
  });

  it('keeps Mock mode available for its own slash filter', () => {
    render(
      <SlashMenu
        query="/mock"
        hasProject={false}
        onSelectTask={vi.fn()}
        onSelectMock={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('option', { name: /演示模式/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /参考小说分析/ })).not.toBeInTheDocument();
  });
});
