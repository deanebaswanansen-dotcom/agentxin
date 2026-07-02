/**
 * Unit tests for {@link BlueprintForm} (task 12.5, Requirement 14.2).
 *
 * Covers Requirement 14.2 — the "生成蓝图" entry is disabled when the
 * requirement text is empty or the target word count falls outside the
 * 100–100000 inclusive range, and enabled (firing `onGenerate` with
 * `{requirement, targetWords}`) when both inputs are valid.
 *
 * The form is a pure controlled component, so no client injection is needed.
 * User interaction uses `fireEvent` (matching the existing component tests; the
 * project does not depend on `@testing-library/user-event`).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BlueprintForm } from './BlueprintForm.js';

function getGenerateButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '生成蓝图' }) as HTMLButtonElement;
}

describe('BlueprintForm', () => {
  it('disables 生成蓝图 when the requirement text is empty (Requirement 14.2)', () => {
    // Default initialRequirement is '' and initialTargetWords is a valid 3000.
    render(<BlueprintForm onGenerate={vi.fn()} />);
    expect(getGenerateButton()).toBeDisabled();
  });

  it('disables 生成蓝图 when target words are below 100 or above 100000 (Requirement 14.2)', () => {
    render(<BlueprintForm onGenerate={vi.fn()} initialRequirement="写一个开头" />);
    const target = screen.getByLabelText('目标字数');

    // With a valid requirement + valid default target, the button is enabled.
    expect(getGenerateButton()).toBeEnabled();

    // Below the lower bound (100) -> disabled.
    fireEvent.change(target, { target: { value: '50' } });
    expect(getGenerateButton()).toBeDisabled();

    // Above the upper bound (100000) -> disabled.
    fireEvent.change(target, { target: { value: '200000' } });
    expect(getGenerateButton()).toBeDisabled();

    // Non-integer within range -> disabled.
    fireEvent.change(target, { target: { value: '1000.5' } });
    expect(getGenerateButton()).toBeDisabled();

    // Empty target -> disabled.
    fireEvent.change(target, { target: { value: '' } });
    expect(getGenerateButton()).toBeDisabled();
  });

  it('enables 生成蓝图 and fires onGenerate with {requirement, targetWords} when valid (Requirement 14.2)', () => {
    const onGenerate = vi.fn();
    render(<BlueprintForm onGenerate={onGenerate} />);

    fireEvent.change(screen.getByLabelText('章节需求'), {
      target: { value: '少年觉醒，踏上修炼之路' },
    });
    fireEvent.change(screen.getByLabelText('目标字数'), { target: { value: '5000' } });

    const button = getGenerateButton();
    expect(button).toBeEnabled();

    fireEvent.click(button);

    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerate).toHaveBeenCalledWith({
      requirement: '少年觉醒，踏上修炼之路',
      targetWords: 5000,
    });
  });

  it('stays disabled while the form is disabled even with valid inputs', () => {
    const onGenerate = vi.fn();
    render(
      <BlueprintForm onGenerate={onGenerate} disabled initialRequirement="合法需求" />,
    );
    // When disabled, the button label switches to 生成中… and remains disabled.
    const button = screen.getByRole('button', { name: '生成中…' }) as HTMLButtonElement;
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onGenerate).not.toHaveBeenCalled();
  });
});
