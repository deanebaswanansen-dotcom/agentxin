import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { StoryMemoryPanel, type StoryMemoryPanelProps } from './StoryMemoryPanel.js';
import './components.css';

export function StoryMemoryDrawer({ onClose, children, ...props }: StoryMemoryPanelProps & { onClose: () => void; children?: ReactNode }): JSX.Element {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    closeButton.current?.focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, []);
  return createPortal(<div className="nwa-drawer-overlay" onClick={onClose}>
    <div ref={dialog} tabIndex={-1} className="nwa-drawer nwa-drawer--right nwa-memory-drawer" role="dialog" aria-modal="true" aria-label="故事记忆" onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
        if (event.key !== 'Tab') return;
        const targets = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]') ?? [])
          .filter((element) => element.getClientRects().length > 0);
        const first = targets[0]; const last = targets.at(-1);
        if (!first) { event.preventDefault(); event.stopPropagation(); dialog.current?.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); event.stopPropagation(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); event.stopPropagation(); first.focus(); }
      }}>
      <div className="nwa-drawer__header"><strong>故事记忆</strong><button ref={closeButton} type="button" className="nwa-button nwa-button--ghost nwa-button--sm" aria-label="关闭故事记忆" onClick={onClose}>关闭</button></div>
      <div className="nwa-drawer__body nwa-memory-body">{children}<StoryMemoryPanel {...props} /></div>
    </div>
  </div>, document.body);
}
