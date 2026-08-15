export type StructuredFieldPath = readonly (string | number)[];

export interface StructuredDecodeIssue {
  path: StructuredFieldPath;
  code: string;
  message: string;
}

export type StructuredDecodeResult<T> =
  | { success: true; value: T }
  | { success: false; issues: readonly StructuredDecodeIssue[] };

/**
 * Versioned runtime contract for one complete structured artifact.
 * Implementations must inspect the whole value and return every known issue.
 */
export interface StructuredContract<T> {
  name: string;
  version: number;
  instructions: string;
  decode(value: unknown): StructuredDecodeResult<T>;
}

export function defineStructuredContract<T>(
  contract: StructuredContract<T>,
): Readonly<StructuredContract<T>> {
  if (!contract.name.trim()) throw new TypeError('StructuredContract.name 不能为空。');
  if (!Number.isSafeInteger(contract.version) || contract.version < 1) {
    throw new TypeError('StructuredContract.version 必须是正整数。');
  }
  if (!contract.instructions.trim()) {
    throw new TypeError('StructuredContract.instructions 不能为空。');
  }
  return Object.freeze({ ...contract });
}

export function formatStructuredFieldPath(path: StructuredFieldPath): string {
  if (path.length === 0) return '$';
  return path.reduce<string>((formatted, segment) => (
    typeof segment === 'number'
      ? `${formatted}[${segment}]`
      : `${formatted}.${segment}`
  ), '$');
}
