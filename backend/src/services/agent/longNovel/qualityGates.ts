/**
 * 长篇小说模式质量 Gate（SPEC §14）。
 * 章节正式保存前的本地硬检查 + 结合检测子 Agent 评分。
 */
export type GateSeverity = 'pass' | 'soft' | 'hard';

export interface GateFinding {
  gate: 'format' | 'plot' | 'continuity' | 'style' | 'serial';
  severity: GateSeverity;
  message: string;
  autoFixable: boolean;
}

export interface GateInput {
  content: string;
  minWords: number;
  maxWords: number;
  targetWords: number;
  chapterTitle: string;
  inspectorScore?: number;
  recommendRevision?: boolean;
  revisionHints?: string[];
}

export interface GateResult {
  ok: boolean;
  /** 硬冲突：应暂停自动循环。 */
  hardFail: boolean;
  findings: GateFinding[];
}

const META_LEAK =
  /^(?:好的|当然|作为|以下是|我来|下面给出|根据你的要求|JSON|system prompt)/im;

export function runChapterQualityGates(input: GateInput): GateResult {
  const findings: GateFinding[] = [];
  const text = input.content.trim();
  const words = Array.from(text.replace(/\s/g, '')).length;

  // Gate 1 格式
  if (words === 0) {
    findings.push({
      gate: 'format',
      severity: 'hard',
      message: '正文为空。',
      autoFixable: false,
    });
  } else if (words < input.minWords) {
    findings.push({
      gate: 'format',
      severity: 'soft',
      message: `字数 ${words} 低于最低要求 ${input.minWords}。`,
      autoFixable: true,
    });
  }
  if (words > input.maxWords) {
    findings.push({
      gate: 'format',
      severity: 'soft',
      message: `字数 ${words} 超过上限 ${input.maxWords}。`,
      autoFixable: true,
    });
  }
  if (META_LEAK.test(text.slice(0, 80)) || /```/.test(text)) {
    findings.push({
      gate: 'format',
      severity: 'hard',
      message: '疑似模型说明/代码块泄漏，不得作为正文。',
      autoFixable: true,
    });
  }

  // Gate 2 剧情（轻量启发式）
  const hasDialogue = /[“「"]/.test(text);
  const hasChange = /但是|却|突然|终于|原来|决定|发现|不得不/.test(text);
  if (!hasChange && words > 200) {
    findings.push({
      gate: 'plot',
      severity: 'soft',
      message: '本章缺少明显状态变化/转折，可能空转。',
      autoFixable: true,
    });
  }
  if (!hasDialogue && words > 800) {
    findings.push({
      gate: 'style',
      severity: 'soft',
      message: '本章几乎无对白，连载节奏可能偏闷。',
      autoFixable: true,
    });
  }

  // Gate 3 一致性（来自检测子 Agent）
  if (input.inspectorScore !== undefined && input.inspectorScore < 50) {
    findings.push({
      gate: 'continuity',
      severity: 'hard',
      message: `一致性评分过低（${input.inspectorScore}），暂停自动循环。`,
      autoFixable: Boolean(input.recommendRevision),
    });
  } else if (input.inspectorScore !== undefined && input.inspectorScore < 70) {
    findings.push({
      gate: 'continuity',
      severity: 'soft',
      message: `一致性评分偏低（${input.inspectorScore}），建议修订。`,
      autoFixable: true,
    });
  }
  if (input.recommendRevision && (input.revisionHints?.length ?? 0) > 0) {
    findings.push({
      gate: 'continuity',
      severity: input.inspectorScore !== undefined && input.inspectorScore < 55 ? 'hard' : 'soft',
      message: `检测子 Agent 要求修订：${input.revisionHints!.slice(0, 2).join('；')}`,
      autoFixable: true,
    });
  }

  // Gate 5 连载
  const tail = text.slice(-120);
  const hasHook = /？|\?|却|突然|竟然|原来|危险|秘密|下一步|明天|即将/.test(tail);
  if (!hasHook && words > 400) {
    findings.push({
      gate: 'serial',
      severity: 'soft',
      message: '章末钩子偏弱，连载追读动力不足。',
      autoFixable: true,
    });
  }

  const hardFail = findings.some((f) => f.severity === 'hard');
  return {
    ok: !hardFail,
    hardFail,
    findings,
  };
}

export function defaultLongNovelConfig(partial?: Partial<{
  automationLevel: 'assistant' | 'semi_auto' | 'auto' | 'unattended';
  targetWords: number;
  targetChapters: number;
  targetWordsPerChapter: number;
  minWordsPerChapter: number;
  maxChaptersPerRun: number;
}>): import('../../../types/index.js').LongNovelModeConfig {
  const level = partial?.automationLevel ?? 'semi_auto';
  const perChapter = partial?.targetWordsPerChapter ?? 2000;
  const maxRun =
    partial?.maxChaptersPerRun ??
    (level === 'assistant' ? 1 : level === 'semi_auto' ? 5 : level === 'auto' ? 20 : 50);
  return {
    enabled: true,
    automationLevel: level,
    targetWords: partial?.targetWords ?? 200_000,
    targetChapters: partial?.targetChapters,
    minWordsPerChapter: partial?.minWordsPerChapter ?? Math.max(300, Math.floor(perChapter * 0.45)),
    targetWordsPerChapter: perChapter,
    maxWordsPerChapter: Math.min(8000, Math.floor(perChapter * 1.8)),
    checkpointInterval: 5,
    maxChaptersPerRun: maxRun,
    maxConsecutiveFailures: 3,
    planningEnabled: true,
    structuredMemoryEnabled: true,
    foreshadowTrackingEnabled: true,
    autoRevisionEnabled: level !== 'assistant',
    chapterLoopEnabled: true,
    stopOnCanonConflict: true,
    stopOnOutlineDeviation: level === 'assistant' || level === 'semi_auto',
  };
}
