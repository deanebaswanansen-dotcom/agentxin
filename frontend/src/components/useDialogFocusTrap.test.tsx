import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useDialogFocusTrap } from './useDialogFocusTrap.js';

const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

function DialogHarness({ onClose }: { onClose: () => void }): JSX.Element {
  const [open, setOpen] = useState(true);
  useDialogFocusTrap();

  return (
    <>
      <button type="button">底层按钮</button>
      {open ? (
        <div role="dialog" aria-modal="true" aria-label="测试弹窗">
          <button
            type="button"
            className="nwa-modal-close"
            aria-label="关闭测试弹窗"
            onClick={() => {
              setOpen(false);
              onClose();
            }}
          >
            关闭
          </button>
          <button type="button">确认</button>
        </div>
      ) : null}
    </>
  );
}

describe('useDialogFocusTrap', () => {
  beforeEach(() => {
    HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      width: 100,
      height: 30,
      top: 0,
      right: 100,
      bottom: 30,
      left: 0,
      toJSON: () => ({}),
    }));
  });

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  it('closes the top modal dialog when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: '测试弹窗' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: '测试弹窗' })).not.toBeInTheDocument();
  });
});
