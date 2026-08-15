import { describe, expect, it } from 'vitest';

import {
  defineStructuredContract,
  type StructuredDecodeIssue,
} from './StructuredContract.js';
import {
  generateStructured,
  STRUCTURED_CALL_BUDGET,
  StructuredGenerationError,
  type StructuredModel,
  type StructuredModelRequest,
} from './generateStructured.js';

interface CharacterCard {
  name: string;
  hairstyle: string;
}

const characterContract = defineStructuredContract<CharacterCard>({
  name: 'CharacterCard',
  version: 1,
  instructions: '必须包含非空字符串 name 与 hairstyle。',
  decode(value) {
    const issues: StructuredDecodeIssue[] = [];
    const record = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
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
    if (issues.length > 0) return { success: false, issues };
    return {
      success: true,
      value: {
        name: (record.name as string).trim(),
        hairstyle: (record.hairstyle as string).trim(),
      },
    };
  },
});

class QueueModel implements StructuredModel {
  readonly requests: StructuredModelRequest[] = [];

  constructor(private readonly responses: Array<string | Error>) {}

  async complete(request: StructuredModelRequest): Promise<string> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error('测试模型没有更多响应。');
    return response;
  }
}

describe('generateStructured', () => {
  it('completes from the primary response after a full contract decode', async () => {
    const primary = new QueueModel(['{"name":"林晓","hairstyle":"齐肩黑发"}']);

    const result = await generateStructured({
      contract: characterContract,
      prompt: '生成人物卡',
      primary,
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw result.error;
    expect(result.value).toEqual({ name: '林晓', hairstyle: '齐肩黑发' });
    expect(result.completedBy).toBe('primary');
    expect(result.callsUsed).toBe(1);
    expect(result.attempts[0]).toMatchObject({
      stage: 'primary',
      outcome: 'completed',
      parseMode: 'direct',
    });
    expect(primary.requests[0]).toMatchObject({
      contractName: 'CharacterCard',
      contractVersion: 1,
    });
  });

  it('uses local loose-JSON repair without spending another model call', async () => {
    const primary = new QueueModel(['```json\n{"name":"林晓","hairstyle":"齐肩黑发",}\n```']);

    const result = await generateStructured({
      contract: characterContract,
      prompt: '生成人物卡',
      primary,
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw result.error;
    expect(result.callsUsed).toBe(1);
    expect(result.attempts[0]?.parseMode).toBe('local_repair');
  });

  it('performs exactly one fixup with all field-level issues', async () => {
    const primary = new QueueModel([
      '{}',
      '{"name":"林晓","hairstyle":"齐肩黑发"}',
    ]);

    const result = await generateStructured({
      contract: characterContract,
      prompt: '生成人物卡',
      primary,
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw result.error;
    expect(result.completedBy).toBe('fixup');
    expect(result.callsUsed).toBe(2);
    expect(result.attempts[0]?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['name'], code: 'field.required' }),
      expect.objectContaining({ path: ['hairstyle'], code: 'field.required' }),
    ]));
    expect(primary.requests[1]?.stage).toBe('fixup');
    expect(primary.requests[1]?.prompt).toContain('path=$.hairstyle');
    expect(primary.requests[1]?.prompt).toContain('code=field.required');
  });

  it('uses an explicit fallback once after the primary fixup fails', async () => {
    const primary = new QueueModel(['{}', '{"name":"林晓"}']);
    const fallback = new QueueModel(['{"name":"林晓","hairstyle":"齐肩黑发"}']);

    const result = await generateStructured({
      contract: characterContract,
      prompt: '生成人物卡',
      primary,
      fallback,
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw result.error;
    expect(result.completedBy).toBe('fallback');
    expect(result.callsUsed).toBe(STRUCTURED_CALL_BUDGET.total);
    expect(result.attempts.map((attempt) => attempt.stage)).toEqual([
      'primary',
      'fixup',
      'fallback',
    ]);
    expect(fallback.requests).toHaveLength(1);
  });

  it('returns needs_review without fallback and preserves the final path/code error', async () => {
    const primary = new QueueModel(['{}', '{"name":"林晓"}']);

    const result = await generateStructured({
      contract: characterContract,
      prompt: '生成人物卡',
      primary,
    });

    expect(result.status).toBe('needs_review');
    if (result.status !== 'needs_review') throw new Error('预期 needs_review');
    expect(result.callsUsed).toBe(2);
    expect(result.error).toBeInstanceOf(StructuredGenerationError);
    expect(result.error.code).toBe('STRUCTURED_OUTPUT_NEEDS_REVIEW');
    expect(result.error.issues).toEqual([
      expect.objectContaining({ path: ['hairstyle'], code: 'field.required' }),
    ]);
    expect(result.error.message).toContain('$.hairstyle field.required');
  });

  it('reports a primary call error without inventing a fixup when no raw output exists', async () => {
    const primary = new QueueModel([new Error('upstream timeout')]);

    const result = await generateStructured({
      contract: characterContract,
      prompt: '生成人物卡',
      primary,
    });

    expect(result.status).toBe('needs_review');
    if (result.status !== 'needs_review') throw new Error('预期 needs_review');
    expect(result.callsUsed).toBe(1);
    expect(result.attempts[0]).toMatchObject({
      stage: 'primary',
      outcome: 'call_failed',
      issues: [{ path: [], code: 'model.call_failed', message: 'upstream timeout' }],
    });
  });

  it('propagates cancellation instead of converting it into needs_review', async () => {
    const controller = new AbortController();
    const abortError = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const primary = new QueueModel([abortError]);
    controller.abort();

    await expect(generateStructured({
      contract: characterContract,
      prompt: '生成人物卡',
      primary,
      signal: controller.signal,
    })).rejects.toBe(abortError);
    expect(primary.requests).toHaveLength(1);
  });

  it('returns needs_review with all three diagnostics when fallback also fails', async () => {
    const primary = new QueueModel(['{}', '{"name":"林晓"}']);
    const fallback = new QueueModel(['not json']);

    const result = await generateStructured({
      contract: characterContract,
      prompt: '生成人物卡',
      primary,
      fallback,
    });

    expect(result.status).toBe('needs_review');
    if (result.status !== 'needs_review') throw new Error('预期 needs_review');
    expect(result.callsUsed).toBe(STRUCTURED_CALL_BUDGET.total);
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts[2]).toMatchObject({
      stage: 'fallback',
      model: 'fallback',
      outcome: 'parse_failed',
      issues: [expect.objectContaining({ path: [], code: 'json.invalid_json' })],
    });
    expect(result.error.issues[0]?.code).toBe('json.invalid_json');
  });

  it('does not fabricate a value when truncated primary output and its fixup both fail', async () => {
    const primary = new QueueModel(['{"name":"林晓"', '{}']);

    const result = await generateStructured({
      contract: characterContract,
      prompt: '生成人物卡',
      primary,
    });

    expect(result.status).toBe('needs_review');
    if (result.status !== 'needs_review') throw new Error('预期 needs_review');
    expect(result.callsUsed).toBe(2);
    expect(result.attempts[0]).toMatchObject({
      outcome: 'parse_failed',
      issues: [expect.objectContaining({ code: 'json.truncated_output' })],
    });
    expect(result.attempts[1]).toMatchObject({ outcome: 'decode_failed' });
    expect('value' in result).toBe(false);
  });
});
