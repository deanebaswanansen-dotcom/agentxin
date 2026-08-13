import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type {
  Id,
  NovelPlanAnswer,
  NovelPlanConfig,
  NovelPlanDepth,
  NovelPlanHistoryTurn,
  NovelPlanQuestion,
  NovelPlanTargetTask,
  NovelPlanTurnResponse,
} from '../../../types/index.js';

export type PlanDecisionStatus = 'unknown' | 'asked' | 'answered' | 'delegated' | 'locked';

export interface PlanDecision {
  key: string;
  status: PlanDecisionStatus;
  value?: string | number | string[];
  source: 'user' | 'agent' | 'config';
  questionId?: string;
  updatedAt: string;
}

export interface PlanSession {
  id: string;
  projectId: Id;
  seedPrompt: string;
  targetTask: NovelPlanTargetTask;
  depth?: NovelPlanDepth;
  planConfig?: NovelPlanConfig;
  history: NovelPlanHistoryTurn[];
  activeQuestions: NovelPlanQuestion[];
  decisions: Record<string, PlanDecision>;
  lastResponse: NovelPlanTurnResponse;
  createdAt: string;
  updatedAt: string;
}

interface FileShape {
  version: 1;
  byProject: Record<string, PlanSession>;
}

interface PlanSessionReduction {
  projectId: Id;
  seedPrompt: string;
  targetTask?: NovelPlanTargetTask;
  depth?: NovelPlanDepth;
  planConfig?: NovelPlanConfig;
  answers?: NovelPlanAnswer[];
  response: NovelPlanTurnResponse;
  history: NovelPlanHistoryTurn[];
}

export interface PlanSessionStorePort {
  get(projectId: Id): PlanSession | undefined;
  save(session: PlanSession): Promise<PlanSession>;
  clear(projectId: Id): Promise<void>;
}

export const DEFAULT_PLAN_SESSION_FILE = 'data/plan-sessions.json';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalDecisionKey(questionId: string): string {
  const id = questionId.trim().toLowerCase();
  if (/^(?:core_)?genre$|topic_type/.test(id)) return 'genre';
  if (/main_direction|campus_conflict|plot_direction|core_conflict/.test(id)) return 'main_conflict';
  if (/protagonist|campus_role|character_role|hero_identity/.test(id)) return 'protagonist_identity';
  if (/core_story|premise|story_hook/.test(id)) return 'core_story';
  if (/target_total_words|total_words/.test(id)) return 'target_total_words';
  if (/target_total_chapters|chapter_count/.test(id)) return 'target_total_chapters';
  if (/target_words_per_chapter|words_per_chapter/.test(id)) return 'target_words_per_chapter';
  if (/target_volume_count|volume_count/.test(id)) return 'target_volume_count';
  if (/ending_direction|ending_shape/.test(id)) return 'ending_direction';
  if (/writing_requirements|writing_style|pacing/.test(id)) return 'writing_requirements';
  return id.replace(/[^a-z0-9_:-]+/g, '_');
}

function answerValue(answer: NovelPlanAnswer): string[] {
  const values = answer.selectedOptionLabels?.length
    ? answer.selectedOptionLabels
    : answer.selectedOptionIds;
  const custom = answer.customText?.trim();
  return [...values, ...(custom ? [custom] : [])];
}

function putDecision(
  decisions: Record<string, PlanDecision>,
  key: string,
  status: PlanDecisionStatus,
  source: PlanDecision['source'],
  value: PlanDecision['value'],
  now: string,
  questionId?: string,
): void {
  decisions[key] = { key, status, source, value, questionId, updatedAt: now };
}

function applyConfigDecisions(
  decisions: Record<string, PlanDecision>,
  config: NovelPlanConfig | undefined,
  now: string,
): void {
  if (!config) return;
  const rows: Array<[string, PlanDecision['value']]> = [
    ['genre', config.genres],
    ['core_story', config.coreStory],
    ['target_total_words', config.targetTotalWords],
    ['target_total_chapters', config.targetTotalChapters],
    [
      'target_words_per_chapter',
      config.targetWordsPerChapter
        ? `${config.targetWordsPerChapter.min}-${config.targetWordsPerChapter.max}`
        : undefined,
    ],
    ['target_volume_count', config.targetVolumeCount],
    ['ending_direction', config.endingDirection],
    ['writing_requirements', config.writingRequirements],
  ];
  for (const [key, value] of rows) {
    if (value !== undefined && (!Array.isArray(value) || value.length > 0)) {
      putDecision(decisions, key, 'locked', 'config', value, now);
    }
  }
}

export function reducePlanSession(
  current: PlanSession | undefined,
  update: PlanSessionReduction,
): PlanSession {
  const now = new Date().toISOString();
  const decisions = clone(current?.decisions ?? {});
  applyConfigDecisions(decisions, update.planConfig ?? current?.planConfig, now);

  for (const answer of update.answers ?? []) {
    const value = answerValue(answer);
    if (value.length === 0) continue;
    const key = canonicalDecisionKey(answer.questionId);
    putDecision(decisions, key, 'answered', 'user', value, now, answer.questionId);
  }

  const activeQuestions = update.response.status === 'asking'
    ? clone(update.response.questions ?? [])
    : [];
  for (const question of activeQuestions) {
    const key = canonicalDecisionKey(question.id);
    const existing = decisions[key];
    if (existing?.status === 'answered' || existing?.status === 'locked') continue;
    putDecision(decisions, key, 'asked', 'agent', undefined, now, question.id);
  }

  return {
    id: current?.id ?? randomUUID(),
    projectId: update.projectId,
    seedPrompt: update.seedPrompt,
    targetTask: update.targetTask ?? current?.targetTask ?? 'long_novel',
    depth: update.depth ?? current?.depth,
    planConfig: update.planConfig ?? current?.planConfig,
    history: clone(update.history),
    activeQuestions,
    decisions,
    lastResponse: clone(update.response),
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
}

export class PlanSessionStore implements PlanSessionStorePort {
  private readonly filePath: string;
  private readonly persistent: boolean;
  private data: FileShape = { version: 1, byProject: {} };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    filePath: string = DEFAULT_PLAN_SESSION_FILE,
    options: { persistent?: boolean } = {},
  ) {
    this.filePath = resolve(filePath);
    this.persistent = options.persistent ?? true;
  }

  static async create(filePath: string = DEFAULT_PLAN_SESSION_FILE): Promise<PlanSessionStore> {
    const store = new PlanSessionStore(filePath);
    await store.load();
    return store;
  }

  static ephemeral(): PlanSessionStore {
    return new PlanSessionStore(DEFAULT_PLAN_SESSION_FILE, { persistent: false });
  }

  private async load(): Promise<void> {
    if (!this.persistent) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<FileShape>;
      this.data = {
        version: 1,
        byProject:
          parsed.byProject && typeof parsed.byProject === 'object'
            ? parsed.byProject
            : {},
      };
    } catch {
      this.data = { version: 1, byProject: {} };
    }
  }

  private persist(): Promise<void> {
    if (!this.persistent) return Promise.resolve();
    const run = async (): Promise<void> => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(this.data, null, 2), 'utf8');
      await rename(temporary, this.filePath);
    };
    this.writeQueue = this.writeQueue.then(run, run);
    return this.writeQueue;
  }

  get(projectId: Id): PlanSession | undefined {
    const session = this.data.byProject[projectId];
    return session ? clone(session) : undefined;
  }

  async save(session: PlanSession): Promise<PlanSession> {
    this.data.byProject[session.projectId] = clone(session);
    await this.persist();
    return clone(session);
  }

  async clear(projectId: Id): Promise<void> {
    delete this.data.byProject[projectId];
    await this.persist();
  }
}
