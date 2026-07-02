/**
 * Global error display (task 12.7, Requirement 8.6).
 *
 * Provides a small React context + provider so any component can push a
 * backend error message to a shared toast stack, plus the presentational
 * {@link ErrorToast} stack that renders those messages.
 *
 * Design goals:
 *  - Decoupled producer/consumer: components obtain a `reportError` callback
 *    from {@link useErrorReporter} (via context) and never need to own toast
 *    state themselves.
 *  - Accepts an {@link ApiClientError} (renders its `.message`, the
 *    user-facing failure reason from the unified `ApiError`), a plain `Error`,
 *    or any string.
 *  - Also usable in a prop-driven fashion (no context) by rendering
 *    {@link ErrorToastStack} directly with `errors` + `onDismiss`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { isApiClientError } from '../api/apiClient.js';
import './components.css';

/** A single error entry held in the toast stack. */
export interface ErrorEntry {
  /** Stable id used as the React key and for dismissal. */
  id: string;
  /** User-facing message (from `ApiClientError.message` when applicable). */
  message: string;
}

/** Anything a caller may hand to {@link reportError}. */
export type ReportableError = unknown;

/** Normalize an arbitrary thrown value into a user-facing message string. */
export function toErrorMessage(error: ReportableError): string {
  if (isApiClientError(error)) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return '发生未知错误。';
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ErrorReporterContextValue {
  /** Push an error onto the global toast stack. Returns the created entry id. */
  reportError: (error: ReportableError) => string;
  /** Dismiss a specific toast by id. */
  dismissError: (id: string) => void;
  /** Remove all toasts. */
  clearErrors: () => void;
}

const ErrorReporterContext = createContext<ErrorReporterContextValue | null>(null);

let toastCounter = 0;
function nextToastId(): string {
  toastCounter += 1;
  return `nwa-error-${Date.now()}-${toastCounter}`;
}

export interface ErrorProviderProps {
  children: ReactNode;
}

/**
 * Provides the global error reporter to its subtree and renders the toast
 * stack. Wrap the app (in task 13.2) with this provider; descendants call
 * {@link useErrorReporter} to surface backend errors.
 */
export function ErrorProvider({ children }: ErrorProviderProps): JSX.Element {
  const [errors, setErrors] = useState<ErrorEntry[]>([]);

  const dismissError = useCallback((id: string) => {
    setErrors((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const clearErrors = useCallback(() => {
    setErrors([]);
  }, []);

  const reportError = useCallback((error: ReportableError): string => {
    const id = nextToastId();
    setErrors((prev) => [...prev, { id, message: toErrorMessage(error) }]);
    return id;
  }, []);

  const value = useMemo<ErrorReporterContextValue>(
    () => ({ reportError, dismissError, clearErrors }),
    [reportError, dismissError, clearErrors],
  );

  return (
    <ErrorReporterContext.Provider value={value}>
      {children}
      <ErrorToastStack errors={errors} onDismiss={dismissError} />
    </ErrorReporterContext.Provider>
  );
}

/**
 * Access the global error reporter. Must be used within an {@link ErrorProvider}.
 * Throws a descriptive error otherwise to catch wiring mistakes early.
 */
export function useErrorReporter(): ErrorReporterContextValue {
  const ctx = useContext(ErrorReporterContext);
  if (ctx === null) {
    throw new Error('useErrorReporter 必须在 <ErrorProvider> 内使用。');
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Presentational stack (prop-driven; usable without context)
// ---------------------------------------------------------------------------

export interface ErrorToastStackProps {
  /** Errors to display. */
  errors: ErrorEntry[];
  /** Invoked with an entry id when the user dismisses a toast. */
  onDismiss: (id: string) => void;
}

/** Renders a fixed-position stack of dismissible error toasts. */
export function ErrorToastStack({ errors, onDismiss }: ErrorToastStackProps): JSX.Element | null {
  if (errors.length === 0) {
    return null;
  }
  return (
    <div className="nwa-toast-stack" role="region" aria-label="错误提示">
      {errors.map((entry) => (
        <ErrorToast key={entry.id} entry={entry} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

export interface ErrorToastProps {
  entry: ErrorEntry;
  onDismiss: (id: string) => void;
}

/** A single error toast with a dismiss button. */
export function ErrorToast({ entry, onDismiss }: ErrorToastProps): JSX.Element {
  return (
    <div className="nwa-toast" role="alert">
      <span className="nwa-toast__message">{entry.message}</span>
      <button
        type="button"
        className="nwa-toast__close"
        aria-label="关闭错误提示"
        onClick={() => onDismiss(entry.id)}
      >
        ×
      </button>
    </div>
  );
}

export default ErrorToastStack;
