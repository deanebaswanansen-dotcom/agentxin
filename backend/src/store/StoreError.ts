/**
 * Error thrown by {@link DataStore} implementations when a read or write
 * operation against the underlying persistence medium fails.
 *
 * Per the design ("Error Handling" / Requirement 7.4), the route/transport
 * layer maps a thrown `StoreError` to the unified API error response with
 * code `STORE_ERROR` (HTTP 500). Keeping this a dedicated error class lets the
 * transport layer distinguish genuine storage failures (disk I/O, JSON
 * corruption, atomic-rename failures) from domain errors such as validation or
 * not-found conditions.
 */
export class StoreError extends Error {
  /**
   * Discriminator used by `instanceof`-unfriendly contexts (e.g. across module
   * realms) and for structured logging. Always `'STORE_ERROR'`.
   */
  readonly code = 'STORE_ERROR' as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreError';
    // Restore the prototype chain for environments that down-level the
    // `extends Error` call (defensive; harmless under ES2022 targets).
    Object.setPrototypeOf(this, StoreError.prototype);
  }
}

/**
 * Type guard for {@link StoreError}. Useful in the transport layer when
 * narrowing a caught `unknown` value.
 */
export function isStoreError(value: unknown): value is StoreError {
  return value instanceof StoreError;
}
