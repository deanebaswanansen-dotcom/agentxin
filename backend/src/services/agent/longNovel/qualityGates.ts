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
  /** Explicit fatal findings from the inspector; unlike a low score, these are hard evidence. */
  fatalIssues?: string[];
}

export interface GateResult {
  ok: boolean;
  /** 硬冲突：应暂停自动循环。 */
  hardFail: boolean;
  findings: GateFinding[];
}

function isCatastrophicContinuityIssue(issue: string): boolean {
  const normalized = issue.replace(/\s+/g, '');
  return (
    /(?:死亡|已死).{0,24}(?:复活|再次出场|仍然活着|存活)/.test(normalized) ||
    /(?:拘留|被捕|关押|囚禁|昏迷|无法行动).{0,40}(?:自由行动|正常出现|出席|参战|自行离开)/.test(normalized) ||
    /(?:唯一|关键)(?:道具|物品|神器|钥匙).{0,40}(?:同时|同一时间).{0,24}(?:两处|两人|多人持有)/.test(normalized) ||
    /(?:提前知道|不该知道|尚未(?:公开|调查|获知).{0,24}(?:秘密|真相|信息))/.test(normalized) ||
    /(?:尚未获得|已经失去|已被封印|能力被封印).{0,32}(?:使用|发动|恢复|可用)/.test(normalized) ||
    /(?:重伤|濒死).{0,24}(?:完全恢复|痊愈|正常战斗|满状态|伤势消失)/.test(normalized) ||
    /(?:身份|性别).{0,24}(?:冲突|矛盾|错误|错置|不一致|被改写|改写)/.test(normalized) ||
    /(?:时间线|年代|时间顺序).{0,32}(?:不可能|倒置|无法成立)/.test(normalized) ||
    /(?:世界规则|力量体系|核心能力).{0,32}(?:冲突|矛盾|违反|不一致)/.test(normalized)
  );
}

const META_LEAK =
  /^(?:好的|当然|作为|以下是|我来|下面给出|根据你的要求|JSON|system prompt)/im;
const CHAPTER_NUMBER = '第[0-9一二三四五六七八九十百零〇两]+章';
const LEADING_CHAPTER_HEADING = new RegExp(
  `^(?:#{1,6}\\s*)?(?:——\\s*)?${CHAPTER_NUMBER}(?:[　 \\t]+[^\\n]{0,80})?(?:\\s*——)?$`,
  'u',
);
const NARRATIVE_CHAPTER_REFERENCE = new RegExp(
  CHAPTER_NUMBER,
  'gu',
);
const DOCUMENT_CHAPTER_QUALIFIER =
  /(?:协议|合同|小说|书籍|报告|文件|条例|法案|手册|卷宗|档案|目录|经文|剧本|教材)[^。！？\n]{0,8}$/u;

function narrativeChapterReference(text: string): string | undefined {
  const trimmed = text.trimStart();
  const newline = trimmed.indexOf('\n');
  const firstLine = (newline >= 0 ? trimmed.slice(0, newline) : trimmed).trim();
  const body = LEADING_CHAPTER_HEADING.test(firstLine)
    ? (newline >= 0 ? trimmed.slice(newline + 1) : '')
    : trimmed;
  for (const match of body.matchAll(NARRATIVE_CHAPTER_REFERENCE)) {
    const prefix = body.slice(Math.max(0, (match.index ?? 0) - 28), match.index ?? 0);
    if (DOCUMENT_CHAPTER_QUALIFIER.test(prefix.replace(/\s+/gu, ''))) continue;
    return match[0];
  }
  return undefined;
}

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
  const leakedChapterReference = narrativeChapterReference(text);
  if (leakedChapterReference) {
    findings.push({
      gate: 'format',
      severity: 'hard',
      message: `正文出现疑似章节编号元叙事「${leakedChapterReference}」，应改写为故事内时间或事件。`,
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
  // Reviewer labels are advisory. Only catastrophic, story-breaking facts may
  // halt an unattended run; appearance, outfit and ordinary scar drift remain
  // auto-fixable soft findings.
  const catastrophicIssues = (input.fatalIssues ?? []).filter(isCatastrophicContinuityIssue);
  const hasExplicitConflict = catastrophicIssues.length > 0;
  if (hasExplicitConflict) {
    findings.push({
      gate: 'continuity',
      severity: 'hard',
      message: `检测到明确 P0 连续性冲突：${catastrophicIssues.slice(0, 2).join('；')}`,
      autoFixable: true,
    });
  }
  if (input.inspectorScore !== undefined && input.inspectorScore < 50) {
    // A numeric score is a reviewer signal, not a deterministic conflict.  A
    // malformed/overly conservative reviewer must not halt a whole novel;
    // only an explicit fatal issue or structural lock failure is hard.
    findings.push({
      gate: 'continuity',
      severity: 'soft',
      message: `一致性评分过低（${input.inspectorScore}），先保留正文并记录待复核。`,
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
      severity: 'soft',
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
  maxWordsPerChapter: number;
  maxChaptersPerRun: number;
}>): import('../../../types/index.js').LongNovelModeConfig {
  const level = partial?.automationLevel ?? 'semi_auto';
  const perChapter = partial?.targetWordsPerChapter ?? 2000;
  const maxRun =
    partial?.maxChaptersPerRun ??
    (level === 'assistant' ? 1 : 5);
  return {
    enabled: true,
    automationLevel: level,
    targetWords: partial?.targetWords ?? 200_000,
    targetChapters: partial?.targetChapters,
    minWordsPerChapter: partial?.minWordsPerChapter ?? Math.max(300, Math.floor(perChapter * 0.45)),
    targetWordsPerChapter: perChapter,
    maxWordsPerChapter:
      partial?.maxWordsPerChapter ?? Math.min(8000, Math.floor(perChapter * 1.8)),
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
