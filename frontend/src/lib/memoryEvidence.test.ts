import { describe, expect, it } from 'vitest';
import { locateNovelMemoryEvidence } from './memoryEvidence.js';
describe('novel source evidence offsets', () => {
  it('selects the specified repeated paragraph and preserves UTF-16/newline offsets', () => {
    const first = '😀钥匙在门外。\r\n';
    const content = first + '钥匙在门外。\n';
    expect(locateNovelMemoryEvidence(content, { blockId: 'paragraph-2', start: 0, end: 2, quote: '钥匙' })).toEqual({ start: first.length, end: first.length + 2 });
  });
  it('does not guess a match in another block or accept invalid citation offsets', () => {
    expect(locateNovelMemoryEvidence('第一行\n钥匙\n', { blockId: 'paragraph-1', start: 0, end: 2, quote: '钥匙' })).toBeUndefined();
    expect(locateNovelMemoryEvidence('钥匙', { blockId: 'unknown', start: 0, end: 2, quote: '钥匙' })).toBeUndefined();
    expect(locateNovelMemoryEvidence('钥匙', { blockId: 'paragraph-1', start: 0.5, end: 2, quote: '钥匙' })).toBeUndefined();
  });
});
