import type {
  ScriptCreativeRulePreset,
  ScriptCreativeRules,
  ScriptQualityRuleMode,
} from '../types/index.js';

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

const HONGGUO_RULES: ScriptCreativeRules = {
  ...DEFAULT_SCRIPT_CREATIVE_RULES,
  preset: 'hongguo',
  fiveEpisodeArc: true,
  goldenLine: true,
  productionLabels: true,
  qualityMode: 'hongguo',
};

export function normalizeScriptCreativeRules(value?: ScriptCreativeRules): ScriptCreativeRules {
  return { ...DEFAULT_SCRIPT_CREATIVE_RULES, ...(value ?? {}) };
}

export function scriptCreativeRulePreset(
  preset: ScriptCreativeRulePreset,
  current?: ScriptCreativeRules,
): ScriptCreativeRules {
  const normalized = normalizeScriptCreativeRules(current);
  const retainedText = {
    writingInstructions: normalized.writingInstructions,
    formatInstructions: normalized.formatInstructions,
    qualityInstructions: normalized.qualityInstructions,
  };
  if (preset === 'hongguo') return { ...HONGGUO_RULES, ...retainedText };
  if (preset === 'light') return { ...DEFAULT_SCRIPT_CREATIVE_RULES, ...retainedText };
  if (preset === 'agent') {
    return {
      ...DEFAULT_SCRIPT_CREATIVE_RULES,
      ...retainedText,
      preset: 'agent',
      qualityMode: 'light',
    };
  }
  return { ...normalized, preset: 'custom' };
}

export const SCRIPT_CREATIVE_RULE_PRESET_LABELS: Record<ScriptCreativeRulePreset, string> = {
  light: '默认轻量（推荐）',
  hongguo: '红果短剧节奏',
  custom: '自定义',
  agent: '交给 AI 决定',
};

export const SCRIPT_QUALITY_RULE_MODE_LABELS: Record<ScriptQualityRuleMode, string> = {
  light: '轻量检查（推荐）',
  hongguo: '红果通用标准',
  custom: '自定义标准',
};

export function scriptCreativeRuleSummary(value?: ScriptCreativeRules): string {
  const rules = normalizeScriptCreativeRules(value);
  return `${SCRIPT_CREATIVE_RULE_PRESET_LABELS[rules.preset]} · ${SCRIPT_QUALITY_RULE_MODE_LABELS[rules.qualityMode]}（只提示，不阻断）`;
}
