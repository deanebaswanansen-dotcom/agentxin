import { describe, expect, it } from 'vitest';
import { applyAdoption } from './applyAdoption';

describe('applyAdoption - insert 模式', () => {
  it('在中间位置嵌入生成文本，其余字符按序保留', () => {
    // 'héllo世界' 索引: h=0 é=1 l=2 l=3 o=4 世=5 界=6；position=5 在 '世' 之前插入
    const result = applyAdoption('héllo世界', 'XYZ', { mode: 'insert', position: 5 });
    expect(result).toBe('hélloXYZ世界');
  });

  it('position 为 0 时插入到开头', () => {
    expect(applyAdoption('abc', '前缀', { mode: 'insert', position: 0 })).toBe('前缀abc');
  });

  it('position 等于长度时插入到末尾', () => {
    expect(applyAdoption('abc', '后缀', { mode: 'insert', position: 3 })).toBe('abc后缀');
  });

  it('生成文本为空时返回原文', () => {
    expect(applyAdoption('abc', '', { mode: 'insert', position: 1 })).toBe('abc');
  });

  it('原文为空时直接返回生成文本', () => {
    expect(applyAdoption('', 'gen', { mode: 'insert', position: 0 })).toBe('gen');
  });

  it('position 越界（大于长度）钳制到末尾', () => {
    expect(applyAdoption('abc', 'X', { mode: 'insert', position: 99 })).toBe('abcX');
  });

  it('position 为负数钳制到开头', () => {
    expect(applyAdoption('abc', 'X', { mode: 'insert', position: -5 })).toBe('Xabc');
  });
});

describe('applyAdoption - replace 模式', () => {
  it('替换 [start, end) 区间，区间外字符按序保留', () => {
    const result = applyAdoption('hello world', 'BRAVE', { mode: 'replace', start: 6, end: 11 });
    expect(result).toBe('hello BRAVE');
  });

  it('替换中间区间', () => {
    expect(applyAdoption('abcdef', 'XY', { mode: 'replace', start: 2, end: 4 })).toBe('abXYef');
  });

  it('start === end 退化为在该位置插入', () => {
    expect(applyAdoption('abcdef', 'XY', { mode: 'replace', start: 3, end: 3 })).toBe('abcXYdef');
  });

  it('替换整个字符串', () => {
    expect(applyAdoption('abc', 'ZZZ', { mode: 'replace', start: 0, end: 3 })).toBe('ZZZ');
  });

  it('生成文本为空时等价于删除区间', () => {
    expect(applyAdoption('abcdef', '', { mode: 'replace', start: 1, end: 4 })).toBe('aef');
  });

  it('end 越界钳制到末尾', () => {
    expect(applyAdoption('abc', 'X', { mode: 'replace', start: 1, end: 99 })).toBe('aX');
  });

  it('start 越界钳制到末尾且 end 不小于 start', () => {
    expect(applyAdoption('abc', 'X', { mode: 'replace', start: 99, end: 99 })).toBe('abcX');
  });

  it('end < start 时钳制为 start（不发生逆序删除）', () => {
    // end 被钳制到 [start, length]，即提升为 start，区间为空 -> 退化为插入
    expect(applyAdoption('abcdef', 'X', { mode: 'replace', start: 4, end: 2 })).toBe('abcdXef');
  });
});
