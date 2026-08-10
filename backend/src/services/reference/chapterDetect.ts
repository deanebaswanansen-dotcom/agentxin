/**
 * 参考小说章节识别与文本清洗（本地，不调用模型）。
 */
export interface DetectedChapter {
  number: number;
  title: string;
  content: string;
}

const CHAPTER_HEADING =
  /^(?:#{1,4}\s*)?(?:正文\s*)?(第[零〇一二三四五六七八九十百千万\d]+\s*[章节卷幕回部][^\n]{0,40}|Chapter\s+\d+[^\n]{0,40}|CHAPTER\s+(?:ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|\d+)[^\n]{0,40})$/gimu;

const AD_LINE =
  /^(?:求收藏|求推荐|求月票|求订阅|本章完|未完待续|手机用户请|请收藏本站|记住本站|一秒记住|www\.|http|更新时间|作者：|字数：)/i;

export function cleanReferenceText(raw: string): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0) {
      if (kept.length > 0 && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    if (AD_LINE.test(t)) continue;
    if (/^[-_=]{6,}$/.test(t)) continue;
    kept.push(line.replace(/<[^>]+>/g, ''));
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function detectChapters(raw: string): DetectedChapter[] {
  const text = cleanReferenceText(raw);
  if (text.length === 0) return [];

  const matches = Array.from(text.matchAll(CHAPTER_HEADING));
  if (matches.length === 0) {
    // 无章节标题：按字数切块，便于分层分析
    return chunkBySize(text, 2800).map((content, i) => ({
      number: i + 1,
      title: `第${i + 1}段`,
      content,
    }));
  }

  const chapters: DetectedChapter[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const start = match.index ?? 0;
    const end = matches[i + 1]?.index ?? text.length;
    const body = text.slice(start + match[0].length, end).trim();
    if (body.length < 20) continue;
    chapters.push({
      number: chapters.length + 1,
      title: match[0].replace(/^#+\s*/, '').trim().slice(0, 80),
      content: body,
    });
  }
  return chapters.length > 0 ? chapters : chunkBySize(text, 2800).map((content, i) => ({
    number: i + 1,
    title: `第${i + 1}段`,
    content,
  }));
}

function chunkBySize(text: string, size: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length && chunks.length < 200) {
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks;
}
