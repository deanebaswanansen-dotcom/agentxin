const CHUNK_RELOAD_AT_KEY = 'nwa:chunk-recovery:last-reload-at';
const DEFAULT_RELOAD_COOLDOWN_MS = 30_000;

interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface ChunkLoadRecoveryOptions {
  target?: EventTarget;
  storage?: RecoveryStorage;
  reload?: () => void;
  now?: () => number;
  cooldownMs?: number;
}

/**
 * Vite emits `vite:preloadError` when a deployed lazy chunk cannot be fetched.
 * Reload at most once per cooldown window; a second failure is handled by the
 * local React error boundary instead of entering a refresh loop.
 */
export function installChunkLoadRecovery(
  options: ChunkLoadRecoveryOptions = {},
): () => void {
  const target = options.target ?? window;
  const storage = options.storage ?? window.sessionStorage;
  const reload = options.reload ?? (() => window.location.reload());
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? DEFAULT_RELOAD_COOLDOWN_MS;

  const handlePreloadError = (event: Event): void => {
    const currentTime = now();
    try {
      const stored = storage.getItem(CHUNK_RELOAD_AT_KEY);
      const lastReloadAt = stored === null ? Number.NaN : Number(stored);
      if (Number.isFinite(lastReloadAt) && currentTime - lastReloadAt < cooldownMs) return;
      storage.setItem(CHUNK_RELOAD_AT_KEY, String(currentTime));
    } catch {
      // Storage can be unavailable in hardened browsers. In that case the
      // React boundary provides a manual retry without risking a reload loop.
      return;
    }
    event.preventDefault();
    reload();
  };

  target.addEventListener('vite:preloadError', handlePreloadError);
  return () => target.removeEventListener('vite:preloadError', handlePreloadError);
}
