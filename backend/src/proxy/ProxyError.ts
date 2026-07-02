/**
 * Error thrown by {@link ModelProxy} implementations when forwarding a writing
 * request to the configured OpenAI-compatible provider fails.
 *
 * Per the design ("ModelProxy：OpenAI 兼容转发" / Requirement 5.5), the
 * route/transport layer maps a thrown `ProxyError` to the unified API error
 * response with code `PROVIDER_ERROR` (HTTP 502) and forwards it to the
 * frontend as an SSE `event: error`.
 *
 * SECURITY (Requirement 5.6): the `message` carried by a `ProxyError` is the
 * user-/frontend-visible failure reason. It MUST NOT contain the provider API
 * key. All constructors in this module build controlled messages that never
 * interpolate the key. The original low-level error (which also never contains
 * the key for `fetch`, since the key lives only in a request header) is kept on
 * `cause` for server-side logging only.
 */
export class ProxyError extends Error {
  /**
   * Discriminator for `instanceof`-unfriendly contexts and structured logging.
   * Always `'PROVIDER_ERROR'` so the transport layer can map it to the
   * `PROVIDER_ERROR` API error code without a dedicated `instanceof` check.
   */
  readonly code = 'PROVIDER_ERROR' as const;

  /**
   * Optional upstream HTTP status code when the failure originated from a
   * non-2xx provider response. `undefined` for transport-level failures such as
   * an aborted/timed-out request or a network error.
   */
  readonly status?: number;

  constructor(
    message: string,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message, options);
    this.name = 'ProxyError';
    this.status = options?.status;
    // Restore the prototype chain for environments that down-level the
    // `extends Error` call (defensive; harmless under ES2022 targets).
    Object.setPrototypeOf(this, ProxyError.prototype);
  }
}

/**
 * Type guard for {@link ProxyError}. Useful in the transport layer when
 * narrowing a caught `unknown` value.
 */
export function isProxyError(value: unknown): value is ProxyError {
  return value instanceof ProxyError;
}
