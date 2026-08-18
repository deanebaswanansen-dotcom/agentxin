import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const APP_STARTED_EVENT = 'nwa:app-started';
const RELOAD_KEY = 'nwa:boot-recovery:last-reload-at';
const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
const recoveryScript = /<script id="nwa-boot-recovery">([\s\S]*?)<\/script>/u.exec(html)?.[1];

function installRecoveryScript(): void {
  if (!recoveryScript) throw new Error('boot recovery script not found');
  window.eval(recoveryScript);
}

describe('HTML boot recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T00:00:00.000Z'));
    window.sessionStorage.clear();
    document.body.innerHTML = '<div id="root"><p>正在连接创作工作台…</p></div>';
  });

  afterEach(() => {
    window.dispatchEvent(new Event(APP_STARTED_EVENT));
    vi.useRealTimers();
    window.sessionStorage.clear();
    document.body.innerHTML = '';
  });

  it('shows a local retry instead of looping when a recent reload also stalled', () => {
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    installRecoveryScript();

    vi.advanceTimersByTime(15_000);

    expect(document.querySelector('[role="alert"]')).toHaveTextContent('工作台加载超时');
    expect(document.querySelector('#nwa-boot-retry')).toHaveTextContent('刷新并重试');
  });

  it('cancels recovery as soon as the React entrypoint starts', () => {
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    installRecoveryScript();
    window.dispatchEvent(new Event(APP_STARTED_EVENT));

    vi.advanceTimersByTime(15_000);

    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body).toHaveTextContent('正在连接创作工作台');
  });
});
