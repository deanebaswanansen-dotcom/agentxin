import { describe, expect, it } from 'vitest';

import {
  parseStructuredModelOutput,
  parseStructuredModelOutputWithDiagnostics,
  ScriptModelOutputError,
} from './structuredOutput.js';

describe('parseStructuredModelOutput', () => {
  it('removes hidden reasoning and Markdown fences before parsing the first JSON object', () => {
    const raw = [
      '<think>这些内容不应保存</think>',
      '下面是最终结果：',
      '```json',
      '{"title":"门缝{\\\"秘密\\\"}","items":[1,2,],}',
      '```',
      '说明完毕',
    ].join('\n');

    expect(parseStructuredModelOutput(raw)).toEqual({
      title: '门缝{"秘密"}',
      items: [1, 2],
    });
  });

  it.each(['', '```json\n{"title":"未闭合"\n```', '<think>只有思考</think>'])(
    'rejects empty or truncated model output without fabricating an artifact',
    (raw) => {
      expect(() => parseStructuredModelOutput(raw)).toThrow(ScriptModelOutputError);
    },
  );

  it.each([
    ['', 'empty_output'],
    ['<think>只有思考</think>', 'empty_output'],
    ['完全不是 JSON', 'invalid_json'],
    ['{"title":"缺右括号"', 'truncated_output'],
    ['{"items":[{"name":"响应中途', 'truncated_output'],
    ['{"title": unquoted}', 'invalid_json'],
  ] as const)('classifies malformed output %j as %s', (raw, failureKind) => {
    try {
      parseStructuredModelOutputWithDiagnostics(raw);
      throw new Error('预期解析失败');
    } catch (error) {
      expect(error).toBeInstanceOf(ScriptModelOutputError);
      expect((error as ScriptModelOutputError).failureKind).toBe(failureKind);
    }
  });
});
