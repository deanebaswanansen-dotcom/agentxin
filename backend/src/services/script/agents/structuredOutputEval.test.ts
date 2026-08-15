import { describe, expect, it } from 'vitest';

import { STRUCTURED_OUTPUT_FIXTURES } from './fixtures/index.js';
import { runStructuredOutputEval } from './structuredOutputEval.js';

describe('structured output fixture evaluation', () => {
  it('keeps a stable, sanitized 20-case failure corpus', () => {
    expect(STRUCTURED_OUTPUT_FIXTURES).toHaveLength(20);
    expect(new Set(STRUCTURED_OUTPUT_FIXTURES.map((item) => item.id)).size).toBe(20);
    expect(new Set(STRUCTURED_OUTPUT_FIXTURES.map((item) => item.file)).size).toBe(20);
    const defects = new Set(STRUCTURED_OUTPUT_FIXTURES.map((item) => item.defect));
    for (const expected of [
      'code_fence',
      'trailing_comma',
      'missing_quote',
      'missing_delimiter',
      'truncation',
      'missing_field',
      'wrong_type',
      'reasoning_pollution',
    ] as const) {
      expect(defects.has(expected)).toBe(true);
    }
  });

  it('classifies local repair and resolves remaining defects with at most one fake fixup', async () => {
    const metrics = await runStructuredOutputEval();

    expect(metrics).toMatchObject({
      schemaVersion: 1,
      fixtureCount: 20,
      local: {
        acceptedDirect: 7,
        acceptedLocalRepair: 4,
        parseFailed: 7,
        decodeFailed: 2,
        expectedMatches: 20,
      },
      boundedWorkflow: {
        completedPrimary: 11,
        completedFixup: 9,
        needsReview: 0,
        totalCalls: 29,
        maxCallsPerFixture: 2,
      },
    });
    expect(metrics.cases.every((item) => item.local === item.expectedLocal)).toBe(true);
    expect(metrics.cases.every((item) => item.callsUsed <= 2)).toBe(true);
    expect(metrics.cases.filter((item) => item.local === 'parse_failed'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ firstOutcome: 'parse_failed', workflow: 'completed_fixup' }),
      ]));
    expect(metrics.cases.filter((item) => item.local === 'decode_failed'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ firstOutcome: 'decode_failed', workflow: 'completed_fixup' }),
      ]));
  });
});
