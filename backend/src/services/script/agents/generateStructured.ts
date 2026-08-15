import {
  formatStructuredFieldPath,
  type StructuredContract,
  type StructuredDecodeIssue,
  type StructuredDecodeResult,
} from './StructuredContract.js';
import {
  parseStructuredModelOutputWithDiagnostics,
  ScriptModelOutputError,
  type StructuredModelParseResult,
} from './structuredOutput.js';

export const STRUCTURED_CALL_BUDGET = Object.freeze({
  primary: 1,
  fixup: 1,
  fallback: 1,
  total: 3,
} as const);

export type StructuredAttemptStage = 'primary' | 'fixup' | 'fallback';
export type StructuredAttemptOutcome =
  | 'completed'
  | 'call_failed'
  | 'parse_failed'
  | 'decode_failed';

export interface StructuredModelRequest {
  stage: StructuredAttemptStage;
  prompt: string;
  contractName: string;
  contractVersion: number;
  signal?: AbortSignal;
}

export interface StructuredModel {
  complete(request: StructuredModelRequest): Promise<string>;
}

export interface StructuredAttemptDiagnostic {
  attempt: number;
  stage: StructuredAttemptStage;
  model: 'primary' | 'fallback';
  outcome: StructuredAttemptOutcome;
  parseMode?: StructuredModelParseResult['mode'];
  issues: readonly StructuredDecodeIssue[];
  rawOutput?: string;
}

export interface GenerateStructuredOptions<T> {
  contract: StructuredContract<T>;
  prompt: string;
  primary: StructuredModel;
  fallback?: StructuredModel;
  signal?: AbortSignal;
}

interface CompletedEvaluation<T> {
  completed: true;
  value: T;
  parseMode: StructuredModelParseResult['mode'];
}

interface FailedEvaluation {
  completed: false;
  outcome: 'parse_failed' | 'decode_failed';
  issues: readonly StructuredDecodeIssue[];
  parseMode?: StructuredModelParseResult['mode'];
}

type Evaluation<T> = CompletedEvaluation<T> | FailedEvaluation;

export type StructuredGenerationResult<T> =
  | {
      status: 'completed';
      value: T;
      contractName: string;
      contractVersion: number;
      completedBy: StructuredAttemptStage;
      callsUsed: number;
      callBudget: typeof STRUCTURED_CALL_BUDGET;
      attempts: readonly StructuredAttemptDiagnostic[];
    }
  | {
      status: 'needs_review';
      contractName: string;
      contractVersion: number;
      callsUsed: number;
      callBudget: typeof STRUCTURED_CALL_BUDGET;
      attempts: readonly StructuredAttemptDiagnostic[];
      error: StructuredGenerationError;
    };

export class StructuredGenerationError extends Error {
  readonly code = 'STRUCTURED_OUTPUT_NEEDS_REVIEW';

  constructor(
    readonly contractName: string,
    readonly contractVersion: number,
    readonly issues: readonly StructuredDecodeIssue[],
    readonly attempts: readonly StructuredAttemptDiagnostic[],
  ) {
    const summary = issues
      .slice(0, 4)
      .map((issue) => `${formatStructuredFieldPath(issue.path)} ${issue.code}: ${issue.message}`)
      .join('；');
    super(
      `${contractName}@v${contractVersion} 在固定调用预算内仍未通过结构校验。${summary ? ` ${summary}` : ''}`,
    );
    this.name = 'StructuredGenerationError';
  }
}

function normalizeIssues(issues: readonly StructuredDecodeIssue[]): readonly StructuredDecodeIssue[] {
  if (issues.length === 0) {
    return [{ path: [], code: 'contract.decode_failed', message: '结构契约未返回具体错误。' }];
  }
  return issues.map((issue) => ({
    path: [...issue.path],
    code: issue.code.trim() || 'contract.invalid_field',
    message: issue.message.trim() || '字段未通过结构契约。',
  }));
}

function parseIssue(error: ScriptModelOutputError): StructuredDecodeIssue {
  return {
    path: [],
    code: `json.${error.failureKind}`,
    message: error.message,
  };
}

function modelIssue(error: unknown): StructuredDecodeIssue {
  return {
    path: [],
    code: 'model.call_failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

function evaluate<T>(rawOutput: string, contract: StructuredContract<T>): Evaluation<T> {
  let parsed: StructuredModelParseResult;
  try {
    parsed = parseStructuredModelOutputWithDiagnostics(rawOutput);
  } catch (error) {
    if (error instanceof ScriptModelOutputError) {
      return { completed: false, outcome: 'parse_failed', issues: [parseIssue(error)] };
    }
    throw error;
  }

  let decoded: StructuredDecodeResult<T>;
  try {
    decoded = contract.decode(parsed.value);
  } catch (error) {
    return {
      completed: false,
      outcome: 'decode_failed',
      parseMode: parsed.mode,
      issues: [{
        path: [],
        code: 'contract.decode_threw',
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
  if (!decoded.success) {
    return {
      completed: false,
      outcome: 'decode_failed',
      parseMode: parsed.mode,
      issues: normalizeIssues(decoded.issues),
    };
  }
  return { completed: true, value: decoded.value, parseMode: parsed.mode };
}

function issueText(issues: readonly StructuredDecodeIssue[]): string {
  return issues.map((issue) => [
    `path=${formatStructuredFieldPath(issue.path)}`,
    `code=${issue.code}`,
    `message=${issue.message}`,
  ].join(' | ')).join('\n');
}

function primaryPrompt<T>(prompt: string, contract: StructuredContract<T>): string {
  return [
    prompt,
    '',
    `结构契约：${contract.name}@v${contract.version}`,
    contract.instructions,
    '只返回一个完整 JSON 对象，不输出 Markdown 围栏或解释。',
  ].join('\n');
}

function recoveryPrompt<T>(
  prompt: string,
  contract: StructuredContract<T>,
  rawOutput: string | undefined,
  issues: readonly StructuredDecodeIssue[],
  stage: 'fixup' | 'fallback',
): string {
  return [
    stage === 'fixup'
      ? '上一次结构化结果未通过校验。请修复并返回完整替代对象。'
      : '主模型未能产生合格结构。请独立生成一个完整替代对象。',
    `原始任务：${prompt}`,
    `结构契约：${contract.name}@v${contract.version}`,
    contract.instructions,
    `校验错误：\n${issueText(issues)}`,
    ...(rawOutput === undefined ? [] : [`待修复原始结果：\n${rawOutput}`]),
    '不得省略未报错的必填字段；只返回一个完整 JSON 对象，不输出 Markdown 围栏或解释。',
  ].join('\n\n');
}

function needsReview<T>(
  options: GenerateStructuredOptions<T>,
  attempts: readonly StructuredAttemptDiagnostic[],
  issues: readonly StructuredDecodeIssue[],
): StructuredGenerationResult<T> {
  const error = new StructuredGenerationError(
    options.contract.name,
    options.contract.version,
    issues,
    attempts,
  );
  return {
    status: 'needs_review',
    contractName: options.contract.name,
    contractVersion: options.contract.version,
    callsUsed: attempts.length,
    callBudget: STRUCTURED_CALL_BUDGET,
    attempts,
    error,
  };
}

/**
 * Executes a bounded structured-output workflow: primary, one fixup, then one explicit fallback.
 * Local parsing/repair and the full contract decoder run after every model response.
 */
export async function generateStructured<T>(
  options: GenerateStructuredOptions<T>,
): Promise<StructuredGenerationResult<T>> {
  const attempts: StructuredAttemptDiagnostic[] = [];
  let latestRaw: string | undefined;
  let latestIssues: readonly StructuredDecodeIssue[] = [];

  const run = async (
    stage: StructuredAttemptStage,
    modelName: 'primary' | 'fallback',
    model: StructuredModel,
    prompt: string,
  ): Promise<Evaluation<T> | undefined> => {
    const attempt = attempts.length + 1;
    try {
      latestRaw = await model.complete({
        stage,
        prompt,
        contractName: options.contract.name,
        contractVersion: options.contract.version,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (
        options.signal?.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        throw error;
      }
      latestIssues = [modelIssue(error)];
      attempts.push({
        attempt,
        stage,
        model: modelName,
        outcome: 'call_failed',
        issues: latestIssues,
      });
      return undefined;
    }

    const evaluation = evaluate(latestRaw, options.contract);
    if (evaluation.completed) {
      attempts.push({
        attempt,
        stage,
        model: modelName,
        outcome: 'completed',
        parseMode: evaluation.parseMode,
        issues: [],
        rawOutput: latestRaw,
      });
      return evaluation;
    }
    latestIssues = evaluation.issues;
    attempts.push({
      attempt,
      stage,
      model: modelName,
      outcome: evaluation.outcome,
      ...(evaluation.parseMode ? { parseMode: evaluation.parseMode } : {}),
      issues: evaluation.issues,
      rawOutput: latestRaw,
    });
    return evaluation;
  };

  const primary = await run(
    'primary',
    'primary',
    options.primary,
    primaryPrompt(options.prompt, options.contract),
  );
  if (primary?.completed) {
    return {
      status: 'completed',
      value: primary.value,
      contractName: options.contract.name,
      contractVersion: options.contract.version,
      completedBy: 'primary',
      callsUsed: attempts.length,
      callBudget: STRUCTURED_CALL_BUDGET,
      attempts,
    };
  }

  if (latestRaw !== undefined) {
    const fixup = await run(
      'fixup',
      'primary',
      options.primary,
      recoveryPrompt(options.prompt, options.contract, latestRaw, latestIssues, 'fixup'),
    );
    if (fixup?.completed) {
      return {
        status: 'completed',
        value: fixup.value,
        contractName: options.contract.name,
        contractVersion: options.contract.version,
        completedBy: 'fixup',
        callsUsed: attempts.length,
        callBudget: STRUCTURED_CALL_BUDGET,
        attempts,
      };
    }
  }

  if (!options.fallback) return needsReview(options, attempts, latestIssues);

  const fallback = await run(
    'fallback',
    'fallback',
    options.fallback,
    recoveryPrompt(options.prompt, options.contract, latestRaw, latestIssues, 'fallback'),
  );
  if (fallback?.completed) {
    return {
      status: 'completed',
      value: fallback.value,
      contractName: options.contract.name,
      contractVersion: options.contract.version,
      completedBy: 'fallback',
      callsUsed: attempts.length,
      callBudget: STRUCTURED_CALL_BUDGET,
      attempts,
    };
  }
  return needsReview(options, attempts, latestIssues);
}
