/**
 * 原文重复 / 专有名词撞车检测（本地，MVP）。
 * 不依赖语义模型：字符 n-gram 重叠 + 长串匹配 + 简单专有名词命中。
 */
import type { SimilarityCheckResult, SimilarityFinding } from '../../types/index.js';

const NGRAM = 12;
const HIGH_SPAN = 40;

export function checkSimilarityAgainstReference(params: {
  referenceId: string;
  referenceTitle: string;
  /** 参考章节正文列表（可截断）。 */
  referenceTexts: string[];
  candidateText: string;
  projectId?: string;
}): SimilarityCheckResult {
  const candidate = normalize(params.candidateText);
  const findings: SimilarityFinding[] = [];
  if (candidate.length < 40) {
    return {
      projectId: params.projectId,
      referenceId: params.referenceId,
      riskLevel: 'ok',
      score0to100: 0,
      findings: [],
      summary: '待检文本过短，跳过相似度检查。',
    };
  }

  const refJoined = params.referenceTexts.map(normalize).filter((t) => t.length > 0);
  let maxOverlap = 0;
  let longSpanHit = '';

  for (const ref of refJoined) {
    const overlap = ngramOverlapRatio(candidate, ref, NGRAM);
    maxOverlap = Math.max(maxOverlap, overlap);
    const span = longestCommonSubstring(candidate, ref, HIGH_SPAN);
    if (span.length >= HIGH_SPAN && span.length > longSpanHit.length) {
      longSpanHit = span;
    }
  }

  const score0to100 = Math.min(100, Math.round(maxOverlap * 120 + (longSpanHit.length >= HIGH_SPAN ? 25 : 0)));

  if (longSpanHit.length >= HIGH_SPAN) {
    findings.push({
      severity: longSpanHit.length >= 80 ? 'high' : 'medium',
      kind: 'long_span',
      message: `发现与参考作《${params.referenceTitle}》连续相似片段（约 ${longSpanHit.length} 字），疑似照抄或轻微改写。`,
      evidence: longSpanHit.slice(0, 80),
    });
  }
  if (maxOverlap >= 0.18) {
    findings.push({
      severity: maxOverlap >= 0.3 ? 'high' : 'medium',
      kind: 'ngram_overlap',
      message: `n-gram 重叠偏高（约 ${(maxOverlap * 100).toFixed(1)}%），存在表达复用风险。`,
    });
  } else if (maxOverlap >= 0.1) {
    findings.push({
      severity: 'low',
      kind: 'ngram_overlap',
      message: `存在轻度表达重合（约 ${(maxOverlap * 100).toFixed(1)}%），可接受若仅是节奏相似。`,
    });
  }

  // 专有名词：参考中高频 2–4 字实体在候选中大量出现
  const properHits = findProperNounHits(refJoined.join('\n').slice(0, 80_000), candidate);
  if (properHits.length > 0) {
    findings.push({
      severity: properHits.length >= 3 ? 'high' : 'medium',
      kind: 'proper_noun',
      message: `疑似复用参考作专有名词：${properHits.slice(0, 8).join('、')}`,
      evidence: properHits.slice(0, 5).join('、'),
    });
  }

  const riskLevel =
    findings.some((f) => f.severity === 'high') || score0to100 >= 55
      ? 'block'
      : findings.some((f) => f.severity === 'medium') || score0to100 >= 30
        ? 'warn'
        : 'ok';

  const summary =
    riskLevel === 'block'
      ? '高相似风险：请结构性改写后再写入正式正文。'
      : riskLevel === 'warn'
        ? '中等相似风险：建议检查专有名词与连续表达。'
        : '未发现明显原文照抄风险（节奏/结构相似不报警）。';

  return {
    projectId: params.projectId,
    referenceId: params.referenceId,
    riskLevel,
    score0to100,
    findings,
    summary,
  };
}

function normalize(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[“”「」"'‘’]/g, '')
    .toLowerCase();
}

function ngramOverlapRatio(a: string, b: string, n: number): number {
  if (a.length < n || b.length < n) return 0;
  const setB = new Set<string>();
  for (let i = 0; i <= b.length - n; i += 1) setB.add(b.slice(i, i + n));
  if (setB.size === 0) return 0;
  let hit = 0;
  let total = 0;
  const step = Math.max(1, Math.floor(n / 2));
  for (let i = 0; i <= a.length - n; i += step) {
    total += 1;
    if (setB.has(a.slice(i, i + n))) hit += 1;
  }
  return total === 0 ? 0 : hit / total;
}

function longestCommonSubstring(a: string, b: string, minLen: number): string {
  // 限制长度防止 O(n*m) 爆炸
  const aa = a.slice(0, 12_000);
  const bb = b.slice(0, 12_000);
  let best = '';
  // 滚动哈希简化：按窗口扫描
  for (let len = Math.min(120, aa.length); len >= minLen; len -= 4) {
    for (let i = 0; i + len <= aa.length; i += Math.max(3, Math.floor(len / 8))) {
      const sub = aa.slice(i, i + len);
      if (bb.includes(sub)) return sub;
    }
  }
  return best;
}

function findProperNounHits(reference: string, candidate: string): string[] {
  const counts = new Map<string, number>();
  for (const m of reference.matchAll(/[一-龥]{2,4}/g)) {
    const w = m[0];
    if (isStopword(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const candidates = [...counts.entries()]
    .filter(([, c]) => c >= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([w]) => w);

  return candidates.filter((w) => candidate.includes(w) && !isCommonWord(w)).slice(0, 10);
}

function isStopword(w: string): boolean {
  return /^(一个|我们|他们|你们|自己|什么|没有|已经|可以|因为|所以|但是|如果|还是|不是|就是|这个|那个|时候|知道|觉得|看到|出来|进去|起来|东西|地方|现在|然后|开始|继续|突然|只是|还是|或者)$/.test(
    w,
  );
}

function isCommonWord(w: string): boolean {
  return /^(主角|世界|力量|修炼|敌人|宗门|学院|城市|系统|任务|技能|等级|攻击|防御)$/.test(w);
}
