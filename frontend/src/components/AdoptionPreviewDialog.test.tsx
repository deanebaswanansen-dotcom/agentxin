import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AdoptionPreviewDialog } from './AdoptionPreviewDialog.js';

describe('AdoptionPreviewDialog', () => {
  it('shows before/after counts and confirms a whole-chapter replacement', () => {
    const onConfirm = vi.fn();
    render(
      <AdoptionPreviewDialog
        mode="replace"
        chapterTitle="第一章"
        before="旧正文"
        after="新的整章正文"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole('dialog', { name: '整章替换确认' })).toBeInTheDocument();
    expect(screen.getByText('原正文 · 3 字符')).toBeInTheDocument();
    expect(screen.getByText('采用后 · 6 字符')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认替换' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('can cancel a cross-chapter append without applying it', () => {
    const onCancel = vi.fn();
    render(
      <AdoptionPreviewDialog
        mode="append"
        chapterTitle="第二章"
        before="原文"
        after="原文\n新增"
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
