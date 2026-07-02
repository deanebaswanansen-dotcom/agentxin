import type { ChatMessage } from '../../types/index.js';

export interface ResearchSourceResult {
  title: string;
  url: string;
  snippet: string;
  sourceName: string;
  sourceType: 'public_api' | 'rss' | 'public_text';
  publishedAt?: string;
  cleanedText?: string;
  score?: number;
}

export interface ResearchSource {
  name: string;
  sourceType: ResearchSourceResult['sourceType'];
  search(keyword: string, limit: number, signal: AbortSignal): Promise<ResearchSourceResult[]>;
}

export interface MaterialResearchReport {
  keywords: string[];
  sources: ResearchSourceResult[];
  markdown: string;
}

export interface MaterialResearchRunOptions {
  query: string;
  signal: AbortSignal;
  complete: (
    messages: ChatMessage[],
    options?: { jsonMode?: boolean },
  ) => Promise<string>;
}

const DEFAULT_RESULT_LIMIT = 6;
const MAX_KEYWORDS = 10;
const MAX_SOURCE_TEXT_CHARS = 1200;
const BLOCKED_QUERY_RE =
  /(付费小说|盗版|全文下载|破解|绕过登录|验证码|风控|起点全文|番茄全文|晋江全文)/i;
const BLOCKED_URL_RE =
  /(\/login\b|captcha|paywall|vip|booktxt|biquge|pirate|盗版|全文下载)/i;

export class MaterialResearchService {
  constructor(private readonly sources: ResearchSource[] = defaultSources()) {}

  async run(options: MaterialResearchRunOptions): Promise<MaterialResearchReport> {
    const query = options.query.trim();
    if (query.length === 0) {
      throw new Error('研究主题不能为空。');
    }
    if (BLOCKED_QUERY_RE.test(query)) {
      throw new Error('素材研究只分析公开资料、桥段结构和原创建议，不能检索付费小说全文或绕过访问限制。');
    }

    const keywords = generateResearchKeywords(query);
    const sources = await this.collectSources(keywords, options.signal);
    const markdown = await this.analyze(query, keywords, sources, options.complete);
    return { keywords, sources, markdown };
  }

  private async collectSources(
    keywords: string[],
    signal: AbortSignal,
  ): Promise<ResearchSourceResult[]> {
    const byUrl = new Map<string, ResearchSourceResult>();
    for (const keyword of keywords.slice(0, 6)) {
      for (const source of this.sources) {
        if (signal.aborted) return rankResults([...byUrl.values()], keywords).slice(0, DEFAULT_RESULT_LIMIT);
        try {
          const results = await source.search(keyword, 3, signal);
          for (const result of results) {
            if (!isAllowedResult(result)) continue;
            const normalized = normalizeResult(result);
            if (!byUrl.has(normalized.url)) {
              byUrl.set(normalized.url, normalized);
            }
          }
        } catch {
          // 单个公开来源失败不阻断整个研究任务。
        }
      }
      if (byUrl.size >= DEFAULT_RESULT_LIMIT * 2) break;
    }
    return rankResults([...byUrl.values()], keywords).slice(0, DEFAULT_RESULT_LIMIT);
  }

  private async analyze(
    query: string,
    keywords: string[],
    sources: ResearchSourceResult[],
    complete: MaterialResearchRunOptions['complete'],
  ): Promise<string> {
    if (sources.length === 0) {
      return fallbackReport(query, keywords, []);
    }

    const context = sources.map((source, index) => ({
      index: index + 1,
      title: source.title,
      source: source.sourceName,
      url: source.url,
      snippet: source.cleanedText ?? source.snippet,
    }));

    let output = '';
    try {
      output = await complete([
        {
          role: 'system',
          content: [
            '你是小说素材研究 Agent。你只能基于公开资料提炼桥段结构、冲突、爽点、梗点和原创改写建议。',
            '禁止复制资料原文，禁止建议照搬人物、设定、剧情，禁止输出大段引用。',
            '输出 Markdown，必须包含：搜索关键词、参考资料、常见套路、俗套风险、原创改写方向、推荐桥段大纲、来源链接。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({ userQuery: query, keywords, publicSources: context }, null, 2),
        },
      ]);
    } catch {
      output = '';
    }

    const cleaned = output.trim();
    if (cleaned.length === 0 || cleaned.startsWith('【MOCK DEMO】')) {
      return fallbackReport(query, keywords, sources);
    }
    return ensureSourceLinks(cleaned, sources);
  }
}

export function generateResearchKeywords(query: string): string[] {
  const compact = query.replace(/\s+/g, ' ').trim();
  const words = Array.from(new Set(compact.match(/[\p{Script=Han}A-Za-z0-9_]+/gu) ?? []))
    .filter((word) => word.length >= 2)
    .slice(0, 6);
  const base = [
    `${compact} 小说桥段`,
    `${compact} 套路 冲突`,
    `${compact} 爽点 反转`,
    `${compact} 人物关系`,
    ...words.map((word) => `${word} 故事结构`),
  ];
  if (/(退婚|反杀|废柴|逆袭|打脸|复仇)/.test(compact)) {
    base.push('underdog revenge fantasy trope', 'rejected engagement fantasy trope');
  }
  if (/(AI|程序员|技术|赛博|系统)/i.test(compact)) {
    base.push('AI agent meme', 'programmer story conflict');
  }
  return Array.from(new Set(base.map((item) => item.trim()).filter(Boolean))).slice(0, MAX_KEYWORDS);
}

export class HnAlgoliaSource implements ResearchSource {
  readonly name = 'Hacker News Algolia';
  readonly sourceType = 'public_api' as const;

  async search(keyword: string, limit: number, signal: AbortSignal): Promise<ResearchSourceResult[]> {
    const url = new URL('https://hn.algolia.com/api/v1/search');
    url.searchParams.set('query', keyword);
    url.searchParams.set('tags', 'story');
    url.searchParams.set('hitsPerPage', String(limit));
    const data = await fetchJson(url.toString(), signal);
    const hits = Array.isArray((data as { hits?: unknown }).hits)
      ? ((data as { hits: unknown[] }).hits)
      : [];
    return hits.map((hit) => {
      const item = hit as Record<string, unknown>;
      const title = stringValue(item.title) || stringValue(item.story_title) || keyword;
      const resultUrl = stringValue(item.url) || `https://news.ycombinator.com/item?id=${stringValue(item.objectID)}`;
      return {
        title,
        url: resultUrl,
        snippet: cleanText(`${stringValue(item.story_text)} ${stringValue(item.comment_text)}`) || title,
        sourceName: this.name,
        sourceType: this.sourceType,
        publishedAt: stringValue(item.created_at) || undefined,
      };
    });
  }
}

export class WikisourceSource implements ResearchSource {
  readonly name = 'Wikisource';
  readonly sourceType = 'public_text' as const;

  async search(keyword: string, limit: number, signal: AbortSignal): Promise<ResearchSourceResult[]> {
    const url = new URL('https://zh.wikisource.org/w/api.php');
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'search');
    url.searchParams.set('srsearch', keyword);
    url.searchParams.set('format', 'json');
    url.searchParams.set('origin', '*');
    url.searchParams.set('srlimit', String(limit));
    const data = await fetchJson(url.toString(), signal);
    const items = Array.isArray((data as { query?: { search?: unknown } }).query?.search)
      ? ((data as { query: { search: unknown[] } }).query.search)
      : [];
    return items.map((raw) => {
      const item = raw as Record<string, unknown>;
      const title = stringValue(item.title) || keyword;
      return {
        title,
        url: `https://zh.wikisource.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
        snippet: cleanText(stringValue(item.snippet)) || title,
        sourceName: this.name,
        sourceType: this.sourceType,
      };
    });
  }
}

export class HnRssSource implements ResearchSource {
  readonly name = 'HN RSS';
  readonly sourceType = 'rss' as const;

  async search(keyword: string, limit: number, signal: AbortSignal): Promise<ResearchSourceResult[]> {
    const url = `https://hnrss.org/newest?q=${encodeURIComponent(keyword)}`;
    const xml = await fetchText(url, signal);
    return parseRssItems(xml)
      .slice(0, limit)
      .map((item) => ({
        title: item.title || keyword,
        url: item.link || url,
        snippet: cleanText(item.description) || item.title || keyword,
        sourceName: this.name,
        sourceType: this.sourceType,
        publishedAt: item.pubDate,
      }));
  }
}

function defaultSources(): ResearchSource[] {
  return [new WikisourceSource(), new HnAlgoliaSource(), new HnRssSource()];
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Agentxin-MaterialResearch/1.0' },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<unknown>;
}

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Agentxin-MaterialResearch/1.0' },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseRssItems(xml: string): Array<{ title: string; link: string; description: string; pubDate?: string }> {
  const items: Array<{ title: string; link: string; description: string; pubDate?: string }> = [];
  const matches = xml.matchAll(/<item\b[\s\S]*?<\/item>/gi);
  for (const match of matches) {
    const block = match[0];
    items.push({
      title: decodeEntities(extractXmlTag(block, 'title')),
      link: decodeEntities(extractXmlTag(block, 'link')),
      description: decodeEntities(extractXmlTag(block, 'description')),
      pubDate: decodeEntities(extractXmlTag(block, 'pubDate')) || undefined,
    });
  }
  return items;
}

function extractXmlTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match?.[1]?.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim() ?? '';
}

function cleanText(text: string): string {
  return decodeEntities(
    text
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ).slice(0, MAX_SOURCE_TEXT_CHARS);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)));
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeResult(result: ResearchSourceResult): ResearchSourceResult {
  return {
    ...result,
    title: cleanText(result.title).slice(0, 160),
    snippet: cleanText(result.snippet),
    cleanedText: result.cleanedText ? cleanText(result.cleanedText) : undefined,
  };
}

function isAllowedResult(result: ResearchSourceResult): boolean {
  return result.url.length > 0 && !BLOCKED_URL_RE.test(result.url);
}

function rankResults(results: ResearchSourceResult[], keywords: string[]): ResearchSourceResult[] {
  const terms = keywords.flatMap((keyword) => keyword.toLowerCase().split(/\s+/)).filter((term) => term.length >= 2);
  return results
    .map((result) => {
      const text = `${result.title} ${result.snippet}`.toLowerCase();
      const relevance = terms.reduce((score, term) => score + (text.includes(term) ? 4 : 0), 0);
      const sourceScore = result.sourceType === 'public_text' ? 8 : result.sourceType === 'public_api' ? 6 : 5;
      const lengthScore = Math.min(8, Math.floor((result.snippet.length + (result.cleanedText?.length ?? 0)) / 80));
      return { ...result, score: relevance + sourceScore + lengthScore };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function fallbackReport(query: string, keywords: string[], sources: ResearchSourceResult[]): string {
  const sourceLines = sources.length > 0
    ? sources.map((source, index) => `${index + 1}. ${source.title}（${source.sourceName}）\n   ${source.url}`).join('\n')
    : '未获取到可用公开来源；本报告只保留关键词和安全边界。';
  return [
    `# 小说素材研究报告`,
    '',
    `用户问题：${query}`,
    '',
    `## 搜索关键词`,
    keywords.map((keyword, index) => `${index + 1}. ${keyword}`).join('\n'),
    '',
    `## 参考资料`,
    sourceLines,
    '',
    `## 常见套路`,
    '公开资料可用于抽取“处境压力 -> 误判 -> 冲突升级 -> 反转兑现”的结构，不应复制具体人物和剧情。',
    '',
    `## 俗套风险`,
    '风险集中在动机单薄、反派脸谱化、主角成长跳跃、爽点只靠羞辱回击。',
    '',
    `## 原创改写方向`,
    '把外部羞辱改成多方利益误判；把直接反杀改成调查、取证、选择代价；让对手保留合理动机。',
    '',
    `## 推荐桥段大纲`,
    '1. 主角先承受误判并发现更深层矛盾。\n2. 中段用公开事件制造压力和信息差。\n3. 结尾让主角通过选择而非纯实力完成反转。',
    '',
    `## 来源链接`,
    sources.map((source) => `- [${source.title}](${source.url})`).join('\n') || '- 暂无',
  ].join('\n');
}

function ensureSourceLinks(markdown: string, sources: ResearchSourceResult[]): string {
  const hasLinks = sources.some((source) => markdown.includes(source.url));
  if (hasLinks) return markdown;
  return [
    markdown,
    '',
    '## 来源链接',
    ...sources.map((source) => `- [${source.title}](${source.url})`),
  ].join('\n');
}
