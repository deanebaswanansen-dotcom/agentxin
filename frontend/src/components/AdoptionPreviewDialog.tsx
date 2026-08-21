interface AdoptionPreviewDialogProps {
  mode: 'replace' | 'append';
  chapterTitle: string;
  before: string;
  after: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const PREVIEW_LIMIT = 2400;

function previewText(value: string, fromEnd: boolean): string {
  if (value.length <= PREVIEW_LIMIT) return value || '（空正文）';
  return fromEnd
    ? `…（已省略前文）\n${value.slice(-PREVIEW_LIMIT)}`
    : `${value.slice(0, PREVIEW_LIMIT)}\n…（已省略后文）`;
}

/** Lightweight confirmation for the two adoption operations that can replace lots of text. */
export function AdoptionPreviewDialog({
  mode,
  chapterTitle,
  before,
  after,
  busy = false,
  onConfirm,
  onCancel,
}: AdoptionPreviewDialogProps): JSX.Element {
  const append = mode === 'append';
  return (
    <div className="nwa-modal-overlay" onClick={busy ? undefined : onCancel}>
      <div
        className="nwa-modal nwa-adoption-preview"
        role="dialog"
        aria-label={append ? '跨章节追加确认' : '整章替换确认'}
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="nwa-modal-header">
          <div>
            <h2>{append ? '确认追加到其他章节' : '确认替换整章正文'}</h2>
            <p className="nwa-adoption-preview__subtitle">{chapterTitle}</p>
          </div>
          <button
            type="button"
            className="nwa-modal-close"
            onClick={onCancel}
            disabled={busy}
            aria-label="关闭采用确认"
          >
            ×
          </button>
        </div>
        <div className="nwa-modal-body">
          <p className="nwa-muted">
            {append
              ? '内容将追加到目标章节末尾。请确认目标和末尾衔接。'
              : '当前整章将被新内容替换。保存前版本仍会进入本地章节历史。'}
          </p>
          <div className="nwa-adoption-preview__grid">
            <section>
              <strong>原正文 · {before.length.toLocaleString()} 字符</strong>
              <pre>{previewText(before, append)}</pre>
            </section>
            <section>
              <strong>采用后 · {after.length.toLocaleString()} 字符</strong>
              <pre>{previewText(after, append)}</pre>
            </section>
          </div>
        </div>
        <div className="nwa-modal-footer">
          <button type="button" className="nwa-button nwa-button--ghost" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className="nwa-button nwa-button--primary" onClick={onConfirm} disabled={busy}>
            {busy ? '正在保存…' : append ? '确认追加' : '确认替换'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AdoptionPreviewDialog;
