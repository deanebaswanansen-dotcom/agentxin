/**
 * 本地语言统计（不调用模型）——对话/描写比例、句长、节奏标签。
 */
import type { ReferenceChapterMetrics, ReferencePacingProfile, ReferenceStyleProfile } from '../../types/index.js';

export function computeChapterMetrics(content: string): ReferenceChapterMetrics {
  const text = content.replace(/\s+/g, ' ').trim();
  const wordCount = Array.from(text.replace(/\s/g, '')).length;
  const paragraphs = content.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const dialogueChars = countDialogueChars(content);
  const descriptionChars = countDescriptionChars(content);
  const sentences = text.split(/[。！？!?]+/).filter((s) => s.trim().length > 0);
  const avgSentenceLength =
    sentences.length === 0
      ? wordCount
      : Math.round(
          sentences.reduce((sum, s) => sum + Array.from(s.replace(/\s/g, '')).length, 0) /
            sentences.length,
        );

  const denom = Math.max(1, wordCount);
  return {
    wordCount,
    dialogueRatio: round2(dialogueChars / denom),
    descriptionRatio: round2(descriptionChars / denom),
    avgSentenceLength,
    paragraphCount: paragraphs.length,
  };
}

export function aggregateStyleProfile(
  metrics: ReferenceChapterMetrics[],
): ReferenceStyleProfile {
  if (metrics.length === 0) {
    return {
      avgSentenceLength: 0,
      avgChapterWords: 0,
      dialogueRatio: 0,
      descriptionRatio: 0,
      rhythmLabel: '中等',
      notes: ['暂无章节指标'],
    };
  }
  const n = metrics.length;
  const avgChapterWords = Math.round(metrics.reduce((s, m) => s + m.wordCount, 0) / n);
  const dialogueRatio = round2(metrics.reduce((s, m) => s + m.dialogueRatio, 0) / n);
  const descriptionRatio = round2(metrics.reduce((s, m) => s + m.descriptionRatio, 0) / n);
  const avgSentenceLength = Math.round(
    metrics.reduce((s, m) => s + m.avgSentenceLength, 0) / n,
  );
  const rhythmLabel = rhythmFromStats(avgChapterWords, dialogueRatio);
  const notes: string[] = [];
  if (dialogueRatio >= 0.35) notes.push('对话密度偏高，节奏偏快、信息多靠对白推进。');
  else if (dialogueRatio <= 0.12) notes.push('对话密度偏低，偏叙述/描写驱动。');
  if (descriptionRatio >= 0.28) notes.push('描写占比较高，环境与感官信息较密。');
  if (avgSentenceLength >= 40) notes.push('平均句长偏长，宜注意阅读负担。');
  else if (avgSentenceLength <= 16) notes.push('平均句长偏短，节奏干脆。');
  if (notes.length === 0) notes.push('整体语言指标接近常规网文中位。');

  return {
    avgSentenceLength,
    avgChapterWords,
    dialogueRatio,
    descriptionRatio,
    rhythmLabel,
    notes,
  };
}

export function aggregatePacingProfile(
  metrics: ReferenceChapterMetrics[],
): ReferencePacingProfile {
  if (metrics.length === 0) {
    return {
      avgChapterWords: 0,
      shortChapterRatio: 0,
      longChapterRatio: 0,
      estimatedSmallConflictEveryN: 3,
      estimatedMajorPayoffEveryN: 10,
      notes: ['暂无节奏样本'],
    };
  }
  const n = metrics.length;
  const avgChapterWords = Math.round(metrics.reduce((s, m) => s + m.wordCount, 0) / n);
  const shortChapterRatio = round2(metrics.filter((m) => m.wordCount < avgChapterWords * 0.7).length / n);
  const longChapterRatio = round2(metrics.filter((m) => m.wordCount > avgChapterWords * 1.35).length / n);
  // 启发式：高对话章 ≈ 小冲突；超长章 ≈ 可能阶段高潮
  const highDialogue = metrics.filter((m) => m.dialogueRatio >= 0.3).length;
  const estimatedSmallConflictEveryN = Math.max(2, Math.round(n / Math.max(1, highDialogue)));
  const longOnes = metrics.filter((m) => m.wordCount > avgChapterWords * 1.35).length;
  const estimatedMajorPayoffEveryN = Math.max(5, Math.round(n / Math.max(1, longOnes)));

  const notes: string[] = [
    `平均章长约 ${avgChapterWords} 字。`,
    `估计约每 ${estimatedSmallConflictEveryN} 章一次小冲突刺激。`,
    `估计约每 ${estimatedMajorPayoffEveryN} 章一次阶段爽点/高潮。`,
  ];
  if (shortChapterRatio > 0.4) notes.push('短章比例偏高，连载断章感更强。');
  if (longChapterRatio > 0.35) notes.push('长章比例偏高，单章信息负载较大。');

  return {
    avgChapterWords,
    shortChapterRatio,
    longChapterRatio,
    estimatedSmallConflictEveryN,
    estimatedMajorPayoffEveryN,
    notes,
  };
}

function countDialogueChars(content: string): number {
  let total = 0;
  const patterns = [/“[^”]{1,400}”/g, /「[^」]{1,400}」/g, /"[^"]{1,400}"/g];
  for (const re of patterns) {
    for (const m of content.matchAll(re)) {
      total += Array.from(m[0]).length;
    }
  }
  return total;
}

function countDescriptionChars(content: string): number {
  // 粗估：含景/感/光/色等描写词的句子长度
  const sentences = content.split(/[。！？!?]/);
  let total = 0;
  for (const s of sentences) {
    if (/[风光月云雨街山河夜色气息沉默望着回想起仿佛]/u.test(s) && !/[“「"]/.test(s)) {
      total += Array.from(s.replace(/\s/g, '')).length;
    }
  }
  return total;
}

function rhythmFromStats(avgChapterWords: number, dialogueRatio: number): string {
  if (avgChapterWords <= 1800 && dialogueRatio >= 0.28) return '很快';
  if (avgChapterWords <= 2500 && dialogueRatio >= 0.22) return '快';
  if (avgChapterWords >= 4500 || dialogueRatio <= 0.1) return '慢';
  if (avgChapterWords >= 5500) return '很慢';
  return '中等';
}

function round2(n: number): number {
  return Math.round(n * 1000) / 1000;
}
