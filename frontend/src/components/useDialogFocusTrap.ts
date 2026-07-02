import { useEffect } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const CLOSE_SELECTOR = [
  '[data-dialog-close]',
  '.nwa-modal-close',
  'button[aria-label^="关闭"]',
  'button[title="关闭"]',
].join(',');

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getDialogs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).filter(isVisible);
}

function getTopDialog(): HTMLElement | null {
  const dialogs = getDialogs();
  return dialogs[dialogs.length - 1] ?? null;
}

function getFocusable(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('disabled') && isVisible(element),
  );
}

function focusDialog(dialog: HTMLElement): void {
  if (dialog.contains(document.activeElement)) return;
  if (!dialog.hasAttribute('tabindex')) {
    dialog.setAttribute('tabindex', '-1');
  }
  const [first] = getFocusable(dialog);
  (first ?? dialog).focus({ preventScroll: true });
}

function closeDialog(dialog: HTMLElement): boolean {
  const closeControl = dialog.querySelector<HTMLElement>(CLOSE_SELECTOR);
  if (!closeControl) return false;
  closeControl.click();
  return true;
}

export function useDialogFocusTrap(): void {
  useEffect(() => {
    const focusTopDialog = () => {
      const dialog = getTopDialog();
      if (dialog) focusDialog(dialog);
    };

    const observer = new MutationObserver(() => {
      window.requestAnimationFrame(focusTopDialog);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    focusTopDialog();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const dialog = getTopDialog();
        if (!dialog) return;
        if (closeDialog(dialog)) event.preventDefault();
        return;
      }

      if (event.key !== 'Tab') return;
      const dialog = getTopDialog();
      if (!dialog) return;

      const focusable = getFocusable(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        focusDialog(dialog);
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (!active || !dialog.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      observer.disconnect();
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);
}
