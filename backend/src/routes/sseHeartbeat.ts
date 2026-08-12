import type { ServerResponse } from 'node:http';

/**
 * Keep an otherwise quiet SSE response active through Nginx/Netlify idle
 * timeouts. The comment frame is ignored by SSE clients and carries no model
 * data. Call the returned function from the route's finally block.
 */
export function startSseHeartbeat(
  raw: ServerResponse,
  intervalMs = 8_000,
): () => void {
  const writeHeartbeat = (): void => {
    if (raw.writableEnded || raw.destroyed) return;
    try {
      raw.write(': heartbeat\n\n');
      const flush = (raw as ServerResponse & { flush?: () => void }).flush;
      if (typeof flush === 'function') flush.call(raw);
    } catch {
      // A close event will cancel the route; a heartbeat must never mask it.
    }
  };

  // Send one frame immediately so the first provider/model wait is covered.
  writeHeartbeat();
  const timer = setInterval(writeHeartbeat, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
