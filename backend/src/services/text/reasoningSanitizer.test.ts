import { describe, expect, it } from 'vitest';
import {
  ReasoningArtifactFilter,
  stripReasoningArtifacts,
} from './reasoningSanitizer.js';

describe('reasoningSanitizer', () => {
  it('removes complete and dangling think blocks from saved text', () => {
    expect(stripReasoningArtifacts('开头\n<think>内部推理</think>\n正文')).toBe('开头\n正文');
    expect(stripReasoningArtifacts('正文之前\n<think>没有闭合')).toBe('正文之前');
  });

  it('does not eat through EOF when danglingToEof is false', () => {
    const withDangling = '场景一\n<think>未闭合\n\n场景二';
    expect(stripReasoningArtifacts(withDangling)).toBe('场景一');
    expect(stripReasoningArtifacts(withDangling, { danglingToEof: false })).toBe(
      withDangling,
    );
    expect(
      stripReasoningArtifacts('开头\n<think>内部推理</think>\n正文', {
        danglingToEof: false,
      }),
    ).toBe('开头\n正文');
  });

  it('keeps streaming content outside split reasoning tags', () => {
    const filter = new ReasoningArtifactFilter();
    const output = [
      filter.push('第一段<th'),
      filter.push('ink>这里是推理'),
      filter.push('</think>第二段'),
      filter.flush(),
    ].join('');

    expect(output).toBe('第一段第二段');
  });

  it('flushes incomplete ordinary angle-bracket text at stream end', () => {
    const filter = new ReasoningArtifactFilter();
    const output = [filter.push('<T'), filter.flush()].join('');

    expect(output).toBe('<T');
  });
});
