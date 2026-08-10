/**
 * Shared CORS configuration for the backend.
 *
 * The onRequest hook in `index.ts` sets CORS headers on normal responses. SSE
 * routes `reply.hijack()` and write their own header block via
 * `reply.raw.writeHead`, which would drop those headers — so they merge
 * `corsResponseHeaders()` into their `writeHead` call instead.
 *
 * Restrict with the `CORS_ORIGIN` env var (e.g. https://your-site.netlify.app);
 * defaults to `*` for a personal tool.
 */
export const CORS_ALLOW_ORIGIN = process.env.CORS_ORIGIN?.trim() || '*';

/** Headers every response (including hijacked SSE streams) must carry. */
export function corsResponseHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN,
  };
}
