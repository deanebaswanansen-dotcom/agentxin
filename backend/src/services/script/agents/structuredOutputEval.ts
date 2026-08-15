import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import {
  defineStructuredContract,
  type StructuredDecodeIssue,
} from './StructuredContract.js';
import {
  generateStructured,
  type StructuredModel,
  type StructuredModelRequest,
} from './generateStructured.js';
import {
  parseStructuredModelOutputWithDiagnostics,
  ScriptModelOutputError,
} from './structuredOutput.js';
import {
  loadStructuredOutputFixtures,
  type StructuredFixtureLocalExpectation,
  type StructuredOutputFixture,
} from './fixtures/index.js';

interface EvalCharacterCard {
  name: string;
  hairstyle: string;
  role: 'lead' | 'supporting' | 'antagonist' | 'minor';
  aliases: string[];
}

export interface StructuredOutputEvalCase {
  id: string;
  defect: StructuredOutputFixture['defect'];
  expectedLocal: StructuredFixtureLocalExpectation;
  local: StructuredFixtureLocalExpectation;
  workflow: 'completed_primary' | 'completed_fixup' | 'needs_review';
  callsUsed: number;
  firstOutcome: 'completed' | 'call_failed' | 'parse_failed' | 'decode_failed';
  firstParseMode?: 'direct' | 'local_repair';
}

export interface StructuredOutputEvalMetrics {
  schemaVersion: 1;
  fixtureCount: number;
  local: {
    acceptedDirect: number;
    acceptedLocalRepair: number;
    parseFailed: number;
    decodeFailed: number;
    expectedMatches: number;
  };
  boundedWorkflow: {
    completedPrimary: number;
    completedFixup: number;
    needsReview: number;
    totalCalls: number;
    maxCallsPerFixture: number;
  };
  cases: StructuredOutputEvalCase[];
}

const ROLE_VALUES = new Set(['lead', 'supporting', 'antagonist', 'minor']);
const CANONICAL_FIXUP = JSON.stringify({
  name: '沈清',
  hairstyle: '高马尾',
  role: 'lead',
  aliases: ['清清'],
});

export const STRUCTURED_OUTPUT_EVAL_CONTRACT = defineStructuredContract<EvalCharacterCard>({
  name: 'SanitizedCharacterCard',
  version: 1,
  instructions: '必须完整包含非空 name、hairstyle、role 和字符串数组 aliases。',
  decode(value) {
    const record = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const issues: StructuredDecodeIssue[] = [];
    if (typeof record.name !== 'string' || !record.name.trim()) {
      issues.push({ path: ['name'], code: 'field.required', message: 'name 必须是非空字符串。' });
    }
    if (typeof record.hairstyle !== 'string' || !record.hairstyle.trim()) {
      issues.push({
        path: ['hairstyle'],
        code: 'field.required',
        message: 'hairstyle 必须是非空字符串。',
      });
    }
    if (typeof record.role !== 'string' || !ROLE_VALUES.has(record.role)) {
      issues.push({ path: ['role'], code: 'field.enum', message: 'role 不在允许范围内。' });
    }
    if (!Array.isArray(record.aliases) ||
      !record.aliases.every((item) => typeof item === 'string')) {
      issues.push({
        path: ['aliases'],
        code: 'field.type',
        message: 'aliases 必须是字符串数组。',
      });
    }
    if (issues.length > 0) return { success: false, issues };
    return {
      success: true,
      value: {
        name: (record.name as string).trim(),
        hairstyle: (record.hairstyle as string).trim(),
        role: record.role as EvalCharacterCard['role'],
        aliases: [...record.aliases as string[]],
      },
    };
  },
});

class FixtureFixupModel implements StructuredModel {
  calls = 0;

  constructor(private readonly raw: string) {}

  async complete(request: StructuredModelRequest): Promise<string> {
    this.calls += 1;
    return request.stage === 'primary' ? this.raw : CANONICAL_FIXUP;
  }
}

function classifyLocal(raw: string): StructuredFixtureLocalExpectation {
  let parsed: ReturnType<typeof parseStructuredModelOutputWithDiagnostics>;
  try {
    parsed = parseStructuredModelOutputWithDiagnostics(raw);
  } catch (error) {
    if (error instanceof ScriptModelOutputError) return 'parse_failed';
    throw error;
  }
  const decoded = STRUCTURED_OUTPUT_EVAL_CONTRACT.decode(parsed.value);
  if (!decoded.success) return 'decode_failed';
  return parsed.mode === 'local_repair' ? 'accepted_local_repair' : 'accepted_direct';
}

async function evaluateFixture(
  fixture: StructuredOutputFixture,
): Promise<StructuredOutputEvalCase> {
  const local = classifyLocal(fixture.raw);
  const model = new FixtureFixupModel(fixture.raw);
  const result = await generateStructured({
    contract: STRUCTURED_OUTPUT_EVAL_CONTRACT,
    prompt: '生成一张脱敏人物卡。',
    primary: model,
  });
  const first = result.attempts[0];
  if (!first) throw new Error(`夹具 ${fixture.id} 没有生成诊断记录。`);
  return {
    id: fixture.id,
    defect: fixture.defect,
    expectedLocal: fixture.expectedLocal,
    local,
    workflow: result.status === 'needs_review'
      ? 'needs_review'
      : result.completedBy === 'primary'
        ? 'completed_primary'
        : 'completed_fixup',
    callsUsed: result.callsUsed,
    firstOutcome: first.outcome,
    ...(first.parseMode ? { firstParseMode: first.parseMode } : {}),
  };
}

export async function runStructuredOutputEval(): Promise<StructuredOutputEvalMetrics> {
  const fixtures = await loadStructuredOutputFixtures();
  const cases = await Promise.all(fixtures.map(evaluateFixture));
  const countLocal = (classification: StructuredFixtureLocalExpectation): number =>
    cases.filter((item) => item.local === classification).length;
  return {
    schemaVersion: 1,
    fixtureCount: cases.length,
    local: {
      acceptedDirect: countLocal('accepted_direct'),
      acceptedLocalRepair: countLocal('accepted_local_repair'),
      parseFailed: countLocal('parse_failed'),
      decodeFailed: countLocal('decode_failed'),
      expectedMatches: cases.filter((item) => item.local === item.expectedLocal).length,
    },
    boundedWorkflow: {
      completedPrimary: cases.filter((item) => item.workflow === 'completed_primary').length,
      completedFixup: cases.filter((item) => item.workflow === 'completed_fixup').length,
      needsReview: cases.filter((item) => item.workflow === 'needs_review').length,
      totalCalls: cases.reduce((total, item) => total + item.callsUsed, 0),
      maxCallsPerFixture: Math.max(0, ...cases.map((item) => item.callsUsed)),
    },
    cases,
  };
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runStructuredOutputEval()
    .then((metrics) => process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
