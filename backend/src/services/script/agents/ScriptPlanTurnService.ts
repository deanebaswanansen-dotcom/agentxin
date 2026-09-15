import { randomUUID } from 'node:crypto';

import type { Project } from '../../../types/index.js';
import { ERROR_CODES } from '../../../types/index.js';
import { ServiceError } from '../../ServiceError.js';
import { getCurrentClientId } from '../../client/clientScope.js';
import {
  ScriptStructuredNeedsReviewError,
  type ScriptCheckpointStore,
  type ScriptDirector,
  type ScriptPipelineCheckpointWrite,
} from './ScriptDirector.js';
import { ScriptModelOutputError } from './structuredOutput.js';
import {
  latestScriptCheckpoint,
  nextScriptCheckpointArtifactRevision,
} from './ScriptCheckpoint.js';
import type {
  ScriptPlanningField,
  ScriptPlanningQuestion,
  ScriptPlanningSession,
  ScriptPlanningValues,
} from './ScriptPlanningAgent.js';
import { SCRIPT_PLANNING_FIELDS } from './ScriptPlanningAgent.js';
import type { ScriptPlanDraftContext } from '../domain.js';
import { decodeScriptPlanDraftContext } from '../ScriptCanonicalInput.js';
import { scriptPlanningFailureMessage } from './ScriptPlanModelContent.js';

export type ScriptPlanAnswerValue = string | string[] | number | boolean;

export interface ScriptPlanTurnAnswer {
  field: string;
  value?: ScriptPlanAnswerValue;
  delegate?: boolean;
}
export interface ScriptPlanTurnRequest {
  projectId: string;
  seedPrompt?: string;
  draft?: ScriptPlanDraftContext;
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
  draft?: ScriptPlanDraftContext;
  round: number;
  activeQuestions: ScriptPlanningQuestion[];
  createdAt: string;
  updatedAt: string;
}

interface ScriptProjectLookup {
  (projectId: string): Promise<Project | undefined>;
}

interface PlanningOperation {
  key: string;
  controller: AbortController;
  signal: AbortSignal;
}

const SESSION_RUN_KEY = 'script_plan_session';
function rethrowPlanGeneration(error: unknown): never {
  if (error instanceof ScriptStructuredNeedsReviewError || error instanceof ScriptModelOutputError) {
    const message = error instanceof ScriptStructuredNeedsReviewError
      ? scriptPlanningFailureMessage('策划', error.cause)
      : 'AI 策划未生成有效故事内容，原策划已保留。请重试或手动编辑。';
    throw new ServiceError(ERROR_CODES.PROVIDER_ERROR, message, { cause: error });
  }
  throw error;
}

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
  private readonly operations = new Map<string, PlanningOperation>();
  private readonly sessionWrites = new Map<string, Promise<void>>();

  constructor(
    private readonly director: Pick<ScriptDirector, 'run'>,
    private readonly checkpoints: ScriptCheckpointStore,
    private readonly projectLookup: ScriptProjectLookup,
  ) {}

  async turn(request: ScriptPlanTurnRequest, signal?: AbortSignal): Promise<ScriptPlanTurnResponse> {
    signal?.throwIfAborted();
    const key = JSON.stringify([getCurrentClientId(), request.projectId]);
    const previous = this.operations.get(key);
    if (previous && !request.reset) {
      throw ServiceError.conflict('当前策划请求仍在处理中，请等待完成后继续回答。');
    }
    // Claim ownership before any asynchronous lookup. A reset must be able to
    // supersede an in-flight model call without waiting for that call to settle.
    previous?.controller.abort(ServiceError.conflict('策划会话已更新，请继续当前会话。'));
    const controller = new AbortController();
    const operation: PlanningOperation = {
      key,
      controller,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    };
    this.operations.set(key, operation);
    try {
      const response = await this.runTurn(request, operation);
      this.assertCurrent(operation);
      return response;
    } finally {
      if (this.operations.get(key) === operation) this.operations.delete(key);
    }
  }

  private assertCurrent(operation: PlanningOperation): void {
    operation.signal.throwIfAborted();
    if (this.operations.get(operation.key) !== operation) {
      throw ServiceError.conflict('策划会话已更新，请继续当前会话。');
    }
  }

  private async runTurn(request: ScriptPlanTurnRequest, operation: PlanningOperation): Promise<ScriptPlanTurnResponse> {
    const project = await this.projectLookup(request.projectId);
    this.assertCurrent(operation);
    if (!project) throw ServiceError.notFound(`项目 ${request.projectId} 不存在`);
    if (project.kind !== 'short_drama') {
      throw ServiceError.validation('短剧策划只能用于 short_drama 项目。');
    }
    // Finish only pending storage work; model generation never holds this queue.
    await this.sessionWrites.get(operation.key);
    this.assertCurrent(operation);
    const prior = request.reset === true ? undefined : await this.load(request.projectId);
    this.assertCurrent(operation);
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
    if (request.draft !== undefined) session.draft = decodeScriptPlanDraftContext(request.draft);
    for (const answer of request.answers) applyAnswer(session, answer);
    session.round += 1;
    session.updatedAt = now;

    let result: Awaited<ReturnType<ScriptDirector['run']>>;
    try {
      // The Director owns the bounded primary/fixup/configured-fallback budget.
      result = await this.director.run({
        task: 'script_plan',
        projectId: request.projectId,
        seedPrompt: session.seedPrompt,
        draft: session.draft,
        projectContext: { name: project.name, kind: 'short_drama' },
        planningSession: session,
        signal: operation.signal,
      });
    } catch (error) {
      this.assertCurrent(operation);
      if (error instanceof ScriptStructuredNeedsReviewError || error instanceof ScriptModelOutputError) {
        await this.save(session, 'needs_review', operation);
      }
      rethrowPlanGeneration(error);
    }
    this.assertCurrent(operation);
    if (result.kind === 'planning_questions') {
      session.askedFields = result.askedFields;
      session.questionCount = result.questionCount;
      session.activeQuestions = result.questions;
      await this.save(session, 'running', operation);
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
      await this.save(session, 'running', operation);
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
    await this.save(session, 'completed', operation);
    return {
      status: 'ready',
      session: session.id,
      round: session.round,
      plan: result.plan,
    };
  }

  private async load(projectId: string): Promise<StoredScriptPlanSession | undefined> {
    const checkpoints = await this.checkpoints.list(projectId, SESSION_RUN_KEY);
    const latest = latestScriptCheckpoint(checkpoints, { node: 'plan' });
    return storedSession(latest?.artifact);
  }

  private async save(
    session: StoredScriptPlanSession,
    status: ScriptPipelineCheckpointWrite['status'],
    operation: PlanningOperation,
  ): Promise<void> {
    this.assertCurrent(operation);
    const write = (this.sessionWrites.get(operation.key) ?? Promise.resolve()).then(async () => {
      this.assertCurrent(operation);
      const checkpoints = await this.checkpoints.list(session.projectId, SESSION_RUN_KEY);
      this.assertCurrent(operation);
      const artifactRevision = nextScriptCheckpointArtifactRevision(checkpoints, { node: 'plan' });
      await this.checkpoints.save({
        projectId: session.projectId,
        runKey: SESSION_RUN_KEY,
        node: 'plan',
        status,
        attempt: session.round,
        artifactRevision,
        artifact: session,
        updatedAt: session.updatedAt,
      });
    });
    const settled = write.catch(() => {});
    this.sessionWrites.set(operation.key, settled);
    try {
      await write;
      this.assertCurrent(operation);
    } finally {
      if (this.sessionWrites.get(operation.key) === settled) this.sessionWrites.delete(operation.key);
    }
  }
}
