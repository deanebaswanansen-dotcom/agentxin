import { describe, expect, it } from 'vitest';
import { generateResearchKeywords, MaterialResearchService, type ResearchSource } from './MaterialResearchService.js';

describe('MaterialResearchService', () => {
  it('generates Chinese and English trope keywords for revenge prompts', () => {
    const keywords = generateResearchKeywords('我想写退婚反杀桥段，但不要太老套');

    expect(keywords.length).toBeGreaterThanOrEqual(5);
    expect(keywords).toContain('underdog revenge fantasy trope');
    expect(keywords.some((keyword) => keyword.includes('小说桥段'))).toBe(true);
  });

  it('collects public sources and produces a Markdown writing report', async () => {
    const source: ResearchSource = {
      name: 'Fake Public Source',
      sourceType: 'public_api',
      async search() {
        return [
          {
            title: 'Public trope analysis',
            url: 'https://example.com/public-trope',
            snippet: 'underdog revenge structure with delayed payoff',
            sourceName: 'Fake Public Source',
            sourceType: 'public_api',
          },
        ];
      },
    };
    const service = new MaterialResearchService([source]);
    const report = await service.run({
      query: '退婚反杀不要老套',
      signal: new AbortController().signal,
      complete: async () => [
        '# 小说素材研究报告',
        '## 俗套风险',
        '动机单薄。',
        '## 原创改写方向',
        '把退婚原因改成保护主角。',
      ].join('\n'),
    });

    expect(report.sources).toHaveLength(1);
    expect(report.markdown).toContain('原创改写方向');
    expect(report.markdown).toContain('https://example.com/public-trope');
  });

  it('rejects paid-full-text collection requests', async () => {
    const service = new MaterialResearchService([]);

    await expect(
      service.run({
        query: '帮我下载起点付费小说全文',
        signal: new AbortController().signal,
        complete: async () => '',
      }),
    ).rejects.toThrow('不能检索付费小说全文');
  });
});
