import type { ScriptPlan } from '../domain.js';

export type ScriptPlanningField =
  | 'genres'
  | 'coreConflict'
  | 'audience'
  | 'totalEpisodes'
  | 'episodeDurationSeconds'
  | 'targetCharsPerEpisode'
  | 'maxScenesPerEpisode'
  | 'dialogueDensityPercent'
  | 'endingDirection';

export type ScriptPlanningValues = Partial<
  Pick<
    ScriptPlan,
    | 'genres'
    | 'coreConflict'
    | 'audience'
    | 'totalEpisodes'
    | 'episodeDurationSeconds'
    | 'targetCharsPerEpisode'
    | 'maxScenesPerEpisode'
    | 'dialogueDensityPercent'
    | 'endingDirection'
  >
>;

export interface ScriptPlanningSession {
  values: ScriptPlanningValues;
  delegatedFields: ScriptPlanningField[];
  askedFields: ScriptPlanningField[];
  questionCount: number;
}

export interface ScriptPlanningQuestion {
  field: ScriptPlanningField;
  prompt: string;
  options?: string[];
}

export type ScriptPlanningAssessment =
  | {
      kind: 'questions';
      questions: ScriptPlanningQuestion[];
      askedFields: ScriptPlanningField[];
      questionCount: number;
    }
  | { kind: 'waiting'; missingFields: ScriptPlanningField[] }
  | {
      kind: 'ready';
      values: ScriptPlanningValues;
      delegatedFields: ScriptPlanningField[];
    };

const REQUIRED_FIELDS: readonly ScriptPlanningField[] = [
  'genres',
  'coreConflict',
  'audience',
  'totalEpisodes',
  'episodeDurationSeconds',
  'targetCharsPerEpisode',
  'maxScenesPerEpisode',
  'dialogueDensityPercent',
  'endingDirection',
];

function hasValue(values: ScriptPlanningValues, field: ScriptPlanningField): boolean {
  const value = values[field];
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return value !== undefined && value !== null;
}

function questionFor(field: ScriptPlanningField, genre: string): ScriptPlanningQuestion {
  const context = genre || '当前题材';
  const questions: Record<ScriptPlanningField, ScriptPlanningQuestion> = {
    genres: {
      field,
      prompt: '这部短剧的核心题材是什么？',
      options: ['都市情感', '校园青春', '西方玄幻', '悬疑推理'],
    },
    coreConflict: {
      field,
      prompt: `「${context}」故事最核心、会推动全剧的冲突是什么？`,
    },
    audience: { field, prompt: `「${context}」主要写给哪类观众？` },
    totalEpisodes: { field, prompt: '全剧计划多少集？' },
    episodeDurationSeconds: { field, prompt: '每集时长范围是多少秒？' },
    targetCharsPerEpisode: { field, prompt: '每集正文目标字数是多少？' },
    maxScenesPerEpisode: { field, prompt: '每集最多允许多少个场景？' },
    dialogueDensityPercent: { field, prompt: '对白在正文中的目标占比是多少？' },
    endingDirection: { field, prompt: `「${context}」最终要走向什么结局？` },
  };
  return questions[field];
}

export function assessScriptPlanning(session: ScriptPlanningSession): ScriptPlanningAssessment {
  const delegated = new Set(session.delegatedFields);
  const missingFields = REQUIRED_FIELDS.filter(
    (field) => !hasValue(session.values, field) && !delegated.has(field),
  );
  if (missingFields.length === 0) {
    return {
      kind: 'ready',
      values: session.values,
      delegatedFields: [...session.delegatedFields],
    };
  }

  const alreadyAsked = new Set(session.askedFields);
  const availableBudget = Math.max(0, 12 - session.questionCount);
  const fields = missingFields
    .filter((field) => !alreadyAsked.has(field))
    .slice(0, Math.min(5, availableBudget));
  if (fields.length === 0) return { kind: 'waiting', missingFields };
  const genre = session.values.genres?.[0] ?? '';
  return {
    kind: 'questions',
    questions: fields.map((field) => questionFor(field, genre)),
    askedFields: [...session.askedFields, ...fields],
    questionCount: session.questionCount + fields.length,
  };
}

