/**
 * Unit tests for the global error display (task 12.8, Requirement 8.6).
 *
 * Covers {@link ErrorToastStack} / {@link ErrorToast} and the
 * {@link ErrorProvider} + {@link useErrorReporter} context: a reported backend
 * error message is displayed to the user, and the message is derived from an
 * {@link ApiClientError}'s user-facing `.message` (the unified `ApiError`).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ApiClientError } from '../api/apiClient.js';
import {
  ErrorProvider,
  ErrorToastStack,
  useErrorReporter,
  toErrorMessage,
  type ErrorEntry,
} from './ErrorToast.js';

describe('ErrorToastStack', () => {
  it('renders nothing when there are no errors', () => {
    const { container } = render(<ErrorToastStack errors={[]} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('displays the backend error message (Requirement 8.6)', () => {
    const errors: ErrorEntry[] = [{ id: 'e1', message: '项目不存在' }];
    render(<ErrorToastStack errors={errors} onDismiss={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('项目不存在');
  });

  it('dismiss button invokes onDismiss with the entry id', () => {
    const onDismiss = vi.fn();
    const errors: ErrorEntry[] = [{ id: 'e1', message: '保存失败' }];
    render(<ErrorToastStack errors={errors} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭错误提示' }));
    expect(onDismiss).toHaveBeenCalledWith('e1');
  });
});

describe('toErrorMessage', () => {
  it('extracts the user-facing message from an ApiClientError', () => {
    const apiError = new ApiClientError(
      { error: { code: 'NOT_FOUND', message: '资源不存在' } },
      404,
    );
    expect(toErrorMessage(apiError)).toBe('资源不存在');
  });

  it('falls back to a plain Error message and a generic message otherwise', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
    expect(toErrorMessage('字符串错误')).toBe('字符串错误');
    expect(toErrorMessage(undefined)).toBe('发生未知错误。');
  });
});

/** A small consumer that reports an error via the context on demand. */
function Reporter({ error }: { error: unknown }): JSX.Element {
  const { reportError } = useErrorReporter();
  return (
    <button type="button" onClick={() => reportError(error)}>
      报告错误
    </button>
  );
}

describe('ErrorProvider + useErrorReporter', () => {
  it('surfaces a reported ApiClientError message to the toast stack (Requirement 8.6)', () => {
    const apiError = new ApiClientError(
      { error: { code: 'PROVIDER_ERROR', message: '提供商返回错误' } },
      502,
    );

    render(
      <ErrorProvider>
        <Reporter error={apiError} />
      </ErrorProvider>,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '报告错误' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('提供商返回错误');
  });
});
