import type { ScriptCreativeRules, ScriptPlan } from '../domain.js';

export const DEFAULT_SCRIPT_CREATIVE_RULES: ScriptCreativeRules = {
  preset: 'light',
  fiveEpisodeArc: false,
  openingHook: true,
  endingHook: true,
  goldenLine: false,
  firstAppearanceDetails: true,
  productionLabels: false,
  writingInstructions: '',
  formatInstructions: '',
  qualityMode: 'light',
  qualityInstructions: '',
};

export function scriptCreativeRules(plan: Pick<ScriptPlan, 'creativeRules'>): ScriptCreativeRules {
  return {
    ...DEFAULT_SCRIPT_CREATIVE_RULES,
    ...(plan.creativeRules ?? {}),
  };
}

function compact(value: string, max = 4_000): string {
  return value.replace(/\r\n?/gu, '\n').trim().slice(0, max);
}

/**
 * Adds preferences to calls that already exist. The last sentence is the P0
 * safety boundary: a preference may bend, but must never truncate the story.
 */
export function scriptCreativeWritingInstruction(
  plan: Pick<ScriptPlan, 'creativeRules'>,
): string {
  const rules = scriptCreativeRules(plan);
  const items: string[] = [];
  if (rules.preset === 'agent') {
    items.push('具体创作节奏与表现格式交给 Agent 按题材判断，优先自然、清楚、可拍摄');
  } else if (rules.preset === 'hongguo') {
    items.push('采用轻量红果短剧节奏：冲突快速进入、情绪逐步升级、单集有小闭环并留下下一步推动力');
  } else if (rules.preset === 'custom') {
    items.push('采用本项目的自定义创作规则');
  } else {
    items.push('采用默认轻量短剧规则，保证故事清楚完整，不为模板机械凑项');
  }
  if (rules.fiveEpisodeArc) {
    items.push('每五集作为一个松散推进单元，依次体现进入冲突、能力推进、信息反转、压力升级、阶段兑现；允许按剧情调整，不得重复套模板');
  }
  if (rules.openingHook) items.push('开场尽快出现人物处境或冲突');
  if (rules.endingHook) items.push('非终局集结尾保留自然卡点，终局集完整收束');
  if (rules.goldenLine) items.push('合适时安排一句可传播台词，不得为了金句破坏人物口吻');
  if (rules.firstAppearanceDetails) items.push('重要人物首次出场时简短交代可拍摄的身份或外观特征，后续不重复');
  if (rules.productionLabels) items.push('在不污染正文结构的前提下提供必要的镜头或场景时长提示');
  const writing = compact(rules.writingInstructions);
  const format = compact(rules.formatInstructions);
  if (writing) items.push(`用户自定义创作要求：${writing}`);
  if (format) items.push(`用户自定义输出格式：${format}`);
  return `创作规则（均为软约束）：${items.join('；')}。若规则互相冲突、资料不足或影响本集完整性，以剧情连贯、正文可用和正常完成流程为先；不得因未完美满足偏好而截断、拒绝输出或暂停任务。`;
}

/** Review preferences are advisory by contract and cannot enter hard issues. */
export function scriptQualityReviewInstruction(
  plan: Pick<ScriptPlan, 'creativeRules'>,
): string {
  const rules = scriptCreativeRules(plan);
  if (rules.qualityMode === 'light') {
    return 'qualityNotes 必须返回空数组；本项目使用轻量检查，只处理前述明显逻辑错误。';
  }
  const custom = compact(rules.qualityInstructions);
  const criteria = rules.qualityMode === 'hongguo'
    ? '可从结构节奏、人物、剧情逻辑、情绪价值、格式与改编适配中选择最明显的改进点'
    : custom
      ? `仅按用户标准检查：${custom}`
      : '按本集的自定义创作要求选择最明显的改进点';
  return [
    `${criteria}；如有必要，在 qualityNotes 中最多写 2 条简短建议，没有则返回空数组。`,
    'qualityNotes 永远只是可选优化建议，不属于 issues，不得标 hard，不得据此判 major_issue、触发自动重写、拒绝正文或暂停任务。',
  ].join('');
}

export function scriptQualityNoteIssues(notes: readonly string[]): Array<{
  code: string;
  severity: 'soft';
  source: 'ai';
  message: string;
}> {
  return notes
    .map((note) => compact(note, 500))
    .filter(Boolean)
    .slice(0, 2)
    .map((message) => ({
      code: 'CREATIVE_PREFERENCE',
      severity: 'soft' as const,
      source: 'ai' as const,
      message,
    }));
}
