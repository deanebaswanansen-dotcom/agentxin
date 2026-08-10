import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';

const PANE_STORAGE_KEY = 'nwa:pane-widths.v1';
/** 侧栏过窄时中文标签易截断；对话栏过窄时字号/选项会挤在一起 */
const MIN_LEFT_WIDTH = 220;
const MAX_LEFT_WIDTH = 420;
const MIN_RIGHT_WIDTH = 360;
const MAX_RIGHT_WIDTH = 720;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function loadPaneWidths(): { left: number; right: number } {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PANE_STORAGE_KEY) ?? '{}') as {
      left?: unknown;
      right?: unknown;
    };
    return {
      left: typeof parsed.left === 'number' ? clamp(parsed.left, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH) : 260,
      right: typeof parsed.right === 'number' ? clamp(parsed.right, MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH) : 420,
    };
  } catch {
    return { left: 260, right: 420 };
  }
}

export function usePaneLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [{ left: initialSidebarWidth, right: initialChatWidth }] = useState(loadPaneWidths);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [chatWidth, setChatWidth] = useState(initialChatWidth);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PANE_STORAGE_KEY,
        JSON.stringify({ left: sidebarWidth, right: chatWidth }),
      );
    } catch {
      // Pane persistence is optional.
    }
  }, [sidebarWidth, chatWidth]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 900px)');
    const collapseForSmallViewport = () => {
      if (media.matches) {
        setSidebarCollapsed(true);
        setChatCollapsed(true);
      }
    };
    collapseForSmallViewport();
    media.addEventListener('change', collapseForSmallViewport);
    return () => media.removeEventListener('change', collapseForSmallViewport);
  }, []);

  const startPaneResize = useCallback(
    (pane: 'left' | 'right', event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startLeft = sidebarWidth;
      const startRight = chatWidth;
      const previousCursor = document.body.style.cursor;
      const previousSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (moveEvent: PointerEvent): void => {
        const delta = moveEvent.clientX - startX;
        if (pane === 'left') {
          setSidebarWidth(clamp(startLeft + delta, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH));
        } else {
          setChatWidth(clamp(startRight - delta, MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH));
        }
      };
      const onUp = (): void => {
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousSelect;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [chatWidth, sidebarWidth],
  );

  const nudgePane = useCallback((pane: 'left' | 'right', delta: number) => {
    if (pane === 'left') {
      setSidebarWidth((value) => clamp(value + delta, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH));
    } else {
      setChatWidth((value) => clamp(value - delta, MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH));
    }
  }, []);

  return {
    sidebarCollapsed,
    setSidebarCollapsed,
    chatCollapsed,
    setChatCollapsed,
    sidebarWidth,
    chatWidth,
    startPaneResize,
    nudgePane,
  };
}
