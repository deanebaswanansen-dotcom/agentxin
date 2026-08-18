import { describe, expect, it, vi } from 'vitest';

import { installChunkLoadRecovery } from './chunkLoadRecovery.js';

function memoryStorage(): { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void } {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe('installChunkLoadRecovery', () => {
  it('reloads once and lets the React boundary handle repeated failures', () => {
    const target = new EventTarget();
    const storage = memoryStorage();
    const reload = vi.fn();
    let timestamp = 1_000;
    const remove = installChunkLoadRecovery({
      target,
      storage,
      reload,
      now: () => timestamp,
      cooldownMs: 30_000,
    });

    const first = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledOnce();

    const repeated = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(repeated);
    expect(repeated.defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledOnce();

    timestamp += 30_001;
    target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    expect(reload).toHaveBeenCalledTimes(2);
    remove();
  });

  it('does not auto-reload when session storage is unavailable', () => {
    const target = new EventTarget();
    const reload = vi.fn();
    installChunkLoadRecovery({
      target,
      reload,
      storage: {
        getItem: () => { throw new Error('blocked'); },
        setItem: () => { throw new Error('blocked'); },
      },
    });

    const event = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
