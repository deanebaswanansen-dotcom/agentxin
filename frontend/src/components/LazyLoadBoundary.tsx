import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface LazyLoadBoundaryProps {
  children: ReactNode;
  label: string;
  onRetry?: () => void;
}
interface LazyLoadBoundaryState {
  failed: boolean;
}

/** Keeps a rejected dynamic import from unmounting the entire application. */
export class LazyLoadBoundary extends Component<
  LazyLoadBoundaryProps,
  LazyLoadBoundaryState
> {
  state: LazyLoadBoundaryState = { failed: false };

  static getDerivedStateFromError(): LazyLoadBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`Failed to load ${this.props.label}`, error, info);
  }

  private readonly retry = (): void => {
    if (this.props.onRetry) {
      this.props.onRetry();
      return;
    }
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="nwa-empty-state-small nwa-lazy-load-error" role="alert">
        <strong>{this.props.label}加载失败</strong>
        <p>网络暂时不稳定，页面其他区域仍可使用。刷新后会从当前数据继续。</p>
        <button type="button" className="nwa-button nwa-button--sm" onClick={this.retry}>
          刷新并重试
        </button>
      </div>
    );
  }
}
