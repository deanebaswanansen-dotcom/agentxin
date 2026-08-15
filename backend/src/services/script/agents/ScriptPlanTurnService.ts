import { randomUUID } from 'node:crypto';

import type { Project } from '../../../types/index.js';
import { ServiceError } from '../../ServiceError.js';
import type {
  ScriptCheckpointStore,
  ScriptDirector,
  ScriptPipelineCheckpoint,
} from './ScriptDirector.js';
import type {
  ScriptPlanningField,
  ScriptPlanningQuestion,
  ScriptPlanningSession,
  ScriptPlanningValues,
} from './ScriptPlanningAgent.js';
import { SCRIPT_PLANNING_FIELDS } from './ScriptPlanningAgent.js';

export type ScriptPlanAnswerValue = string | string[] | number | boolean;

export interface ScriptPlanTurnAnswer {
  field: string;
  value?: ScriptPlanAnswerValue;
  delegate?: boolean;
}
export interface ScriptPlanTurnRequest {
  projectId: string;
  seedPrompt?: string;
  answers: ScriptPlanTurnAnswer[];
  reset?: boolean;
}

export interface ScriptPlanTurnQuestion {
  field: ScriptPlanningField;
  label: string;
  help?: string;
  kind: 'single' | 'multi' | 'text' | 'number';
  required: boolean;
  options?: Array<{ label: string; value: string; description?: string }>;
}

export type ScriptPlanTurnResponse =
  | {
      status: 'asking';
      session: string;
      round: number;
      questions: ScriptPlanTurnQuestion[];
    }
  | {
      status: 'ready';
      session: string;
      round: number;
      plan: Extract<Awaited<ReturnType<ScriptDirector['run']>>, { kind: 'plan_draft' }>['plan'];
    };

interface StoredScriptPlanSession extends ScriptPlanningSession {
  id: string;
  projectId: string;
  seedPrompt: string;
  round: number;
  activeQuestions: ScriptPlanningQuestion[];
  createdAt: string;
  updatedAt: string;
}

interface ScriptProjectLookup {
  (projectId: string): Promise<Project | undefined>;
}

const SESSION_RUN_KEY = 'script_plan_session';

function isPlanningField(value: string): value is ScriptPlanningField {
  return (SCRIPT_PLANNING_FIELDS as readonly string[]).includes(value);
}

function integer(value: ScriptPlanAnswerValue | undefined, field: string, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw ServiceError.validation(`${field} 必须是 ${min}-${max} 的整数。`);
  }
  return parsed;
}

function text(value: ScriptPlanAnswerValue | undefined, field: string, maxLength = 4_000): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw ServiceError.validation(`${field} 必须是长度不超过 ${maxLength} 的非空文本。`);
  }
  return value.trim();
}

function applyAnswer(session: StoredScriptPlanSession, answer: ScriptPlanTurnAnswer): void {
  if (!isPlanningField(answer.field)) {
    throw ServiceError.validation(`未知短剧策划字段：${answer.field}`);
  }
  const field = answer.field;
  if (answer.delegate === true) {
    if (!session.delegatedFields.includes(field)) session.delegatedFields.push(field);
    delete session.values[field];
    return;
  }
  session.delegatedFields = session.delegatedFields.filter((item) => item !== field);
  switch (field) {
    case 'genres': {
      const values = Array.isArray(answer.value)
        ? answer.value
        : typeof answer.value === 'string'
          ? answer.value.split(/[，,、+]/)
          : [];
      const genres = [...new Set(values.map((item) => item.trim()).filter(Boolean))];
      if (genres.length < 1 || genres.length > 6) {
        throw ServiceError.validation('genres 必须包含 1-6 个题材。');
      }
      session.values.genres = genres;
      break;
    }
    case 'coreConflict':
    case 'audience':
    case 'endingDirection':
      session.values[field] = text(answer.value, field);
      break;
    case 'totalEpisodes':
      session.values.totalEpisodes = integer(answer.value, field, 1, 200);
      break;
    case 'targetCharsPerEpisode':
      session.values.targetCharsPerEpisode = integer(answer.value, field, 300, 3_000);
      break;
    case 'maxScenesPerEpisode':
      session.values.maxScenesPerEpisode = integer(answer.value, field, 1, 5);
      break;
    case 'dialogueDensityPercent':
      session.values.dialogueDensityPercent = integer(answer.value, field, 20, 90);
      break;
    case 'episodeDurationSeconds': {
      const raw = text(answer.value, field, 100);
      const values = raw.match(/\d+/g)?.map(Number) ?? [];
      const min = values[0];
      const max = values[1] ?? min;
      if (min === undefined || max === undefined || min < 30 || max > 180 || min > max) {
        throw ServiceError.validation('episodeDurationSeconds 必须是 30-180 秒的有效范围。');
      }
      session.values.episodeDurationSeconds = { min, max };
      break;
    }
  }
}

function questionKind(field: ScriptPlanningField, question: ScriptPlanningQuestion): ScriptPlanTurnQuestion['kind'] {
  if (field === 'genres') return 'multi';
  if (question.options?.length) return 'single';
  if (field === 'totalEpisodes' || field === 'targetCharsPerEpisode' ||
      field === 'maxScenesPerEpisode' || field === 'dialogueDensityPercent') return 'number';
  return 'text';
}

function transportQuestion(question: ScriptPlanningQuestion): ScriptPlanTurnQuestion {
  return {
    field: question.field,
    label: question.prompt,
    kind: questionKind(question.field, question),
    required: true,
    ...(question.options?.length
      ? { options: question.options.map((value) => ({ label: value, value })) }
      : {}),
  };
}

function storedSession(value: unknown): StoredScriptPlanSession | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const session = value as Partial<StoredScriptPlanSession>;
  if (
    typeof session.id !== 'string' || typeof session.projectId !== 'string' ||
    typeof session.seedPrompt !== 'string' || typeof session.round !== 'number' ||
    !session.values || !Array.isArray(session.delegatedFields) ||
    !Array.isArray(session.askedFields) || typeof session.questionCount !== 'number' ||
    !Array.isArray(session.activeQuestions) || typeof session.createdAt !== 'string' ||
    typeof session.updatedAt !== 'string'
  ) return undefined;
  return structuredClone(session as StoredScriptPlanSession);
}

export class ScriptPlanTurnService {
  constructor(
    private readonly director: Pick<ScriptDirector, 'run'>,
    private readonly checkpoints: ScriptCheckpointStore,
    private readonly projectLookup: ScriptProjectLookup,
  ) {}

  async turn(request: ScriptPlanTurnRequest, signal?: AbortSignal): Promise<ScriptPlanTurnResponse> {
    const project = await this.projectLookup(request.projectId);
    if (!project) throw ServiceError.notFound(`项目 ${request.projectId} 不存在`);
    if (project.kind !== 'short_drama') {
      throw ServiceError.validation('短剧策划只能用于 short_drama 项目。');
    }
    const prior = request.reset === true ? undefined : await this.load(request.projectId);
    const now = new Date().toISOString();
    const session: StoredScriptPlanSession = prior ?? {
      id: randomUUID(),
      projectId: request.projectId,
      seedPrompt: request.seedPrompt?.trim() ?? '',
      values: {} as ScriptPlanningValues,
      delegatedFields: [],
      askedFields: [],
      questionCount: 0,
      round: 0,
      activeQuestions: [],
      createdAt: now,
      updatedAt: now,
    };
    if (typeof request.seedPrompt === 'string' && request.seedPrompt.trim()) {
      session.seedPrompt = request.seedPrompt.trim();
    }
    for (const answer of request.answers) applyAnswer(session, answer);
    session.round += 1;
    session.updatedAt = now;

    const result = await this.director.run({
      task: 'script_plan',
      projectId: request.projectId,
      seedPrompt: session.seedPrompt,
      planningSession: session,
      signal,
    });
    if (result.kind === 'planning_questions') {
      session.askedFields = result.askedFields;
      session.questionCount = result.questionCount;
      session.activeQuestions = result.questions;
      await this.save(session, 'running', session.questionCount);
      return {
        status: 'asking',
        session: session.id,
        round: session.round,
        questions: result.questions.map(transportQuestion),
      };
    }
    if (result.kind === 'planning_waiting') {
      if (session.activeQuestions.length === 0) {
        throw ServiceError.validation(`短剧策划仍缺少：${result.missingFields.join('、')}`);
      }
      await this.save(session, 'running', session.questionCount);
      return {
        status: 'asking',
        session: session.id,
        round: session.round,
        questions: session.activeQuestions.map(transportQuestion),
      };
    }
    if (result.kind !== 'plan_draft') {
      throw ServiceError.validation('短剧策划任务返回了不匹配的结果。');
    }
    session.activeQuestions = [];
    await this.save(session, 'completed', result.plan.revision);
    return {
      status: 'ready',
      session: session.id,
      round: session.round,
      plan: result.plan,
    };
  }

  private async load(projectId: string): Promise<StoredScriptPlanSession | undefined> {
    const checkpoints = await this.checkpoints.list(projectId, SESSION_RUN_KEY);
    const latest = checkpoints
      .filter((item) => item.node === 'plan')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return storedSession(latest?.artifact);
  }

  private save(
    session: StoredScriptPlanSession,
    status: ScriptPipelineCheckpoint['status'],
    artifactRevision: number,
  ): Promise<void> {
    return this.checkpoints.save({
      projectId: session.projectId,
      runKey: SESSION_RUN_KEY,
      node: 'plan',
      status,
      attempt: session.round,
      artifactRevision,
      artifact: session,
      updatedAt: session.updatedAt,
    });
  }
}
