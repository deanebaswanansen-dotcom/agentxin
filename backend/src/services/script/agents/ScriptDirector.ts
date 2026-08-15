import { randomUUID } from 'node:crypto';

import type {
  ScriptCharacter,
  ScriptContinuityState,
  ScriptEpisode,
  ScriptEpisodeCard,
  ScriptEpisodeOutline,
  ScriptPlannedScene,
  ScriptPlan,
  ScriptReviewIssueCollection,
  ScriptScene,
  ScriptSeriesOutline,
  ScriptWorldBible,
} from '../domain.js';
import type { ScriptStore } from '../ScriptStore.js';
import {
  createScriptReviewIssues,
  isBlockingScriptReviewIssue,
  validateScriptEpisode,
  type ScriptEvaluatedGateIssue,
  type ScriptGateIssue,
  type ScriptGateReport,
} from '../quality/ScriptQualityGates.js';
import {
  assessScriptPlanning,
  type ScriptPlanningSession,
} from './ScriptPlanningAgent.js';
import { parseStructuredModelOutput, ScriptModelOutputError } from './structuredOutput.js';

export type ScriptModelNode =
  | 'plan'
  | 'series_outline'
  | 'character_bible'
  | 'world_bible'
  | 'episode_outline'
  | 'scene_plan'
  | 'draft'
  | 'review'
  | 'revision';

export interface ScriptModelRequest {
  node: ScriptModelNode;
  projectId: string;
  episodeNumber?: number;
  chunkStart?: number;
  chunkEnd?: number;
  prompt: string;
  signal?: AbortSignal;
}

export interface ScriptModelAdapter {
  complete(request: ScriptModelRequest): Promise<string>;
}

export type ScriptCheckpointNode =
  | 'plan'
  | 'series_outline'
  | 'character_bible'
  | 'world_bible'
  | 'episode_outline'
  | 'scene_plan'
  | 'draft'
  | 'review'
  | 'revision'
  | 'completed'
  | 'batch_report';

export interface ScriptPipelineCheckpoint {
  projectId: string;
  runKey: string;
  node: ScriptCheckpointNode;
  status: 'running' | 'completed';
  attempt: number;
  artifactRevision: number;
  episodeNumber?: number;
  chunkStart?: number;
  artifact?: unknown;
  updatedAt: string;
}

export interface ScriptCheckpointStore {
  list(projectId: string, runKey: string): Promise<ScriptPipelineCheckpoint[]>;
  save(checkpoint: ScriptPipelineCheckpoint): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
}

export class InMemoryScriptCheckpointStore implements ScriptCheckpointStore {
  private readonly items = new Map<string, ScriptPipelineCheckpoint>();

  async list(projectId: string, runKey: string): Promise<ScriptPipelineCheckpoint[]> {
    return [...this.items.values()]
      .filter((item) => item.projectId === projectId && item.runKey === runKey)
      .map((item) => structuredClone(item));
  }

  async save(checkpoint: ScriptPipelineCheckpoint): Promise<void> {
    const key = [
      checkpoint.projectId,
      checkpoint.runKey,
      checkpoint.node,
      checkpoint.episodeNumber ?? '',
      checkpoint.chunkStart ?? '',
    ].join(':');
    this.items.set(key, structuredClone(checkpoint));
  }

  async deleteProject(projectId: string): Promise<void> {
    for (const [key, checkpoint] of this.items.entries()) {
      if (checkpoint.projectId === projectId) this.items.delete(key);
    }
  }
}

export interface ScriptDirectorDependencies {
  model: ScriptModelAdapter;
  store: ScriptStore;
  checkpoints: ScriptCheckpointStore;
  now?: () => string;
  id?: () => string;
}

export interface ScriptCheckpointProgress {
  episodeNumber?: number;
  node: ScriptCheckpointNode;
  attempt: number;
  artifactRevision: number;
}

export interface ScriptProgressEvent {
  phase: 'info';
  message: string;
  current?: number;
  total?: number;
  scriptCheckpoint: ScriptCheckpointProgress;
}

export type ScriptDirectorRequest =
  | {
      task: 'script_plan';
      projectId: string;
      planningSession: ScriptPlanningSession;
      seedPrompt?: string;
      signal?: AbortSignal;
    }
  | {
      task: 'script_series_outline';
      projectId: string;
      signal?: AbortSignal;
    }
  | {
      task: 'script_bible';
      projectId: string;
      signal?: AbortSignal;
    }
  | {
      task: 'script_episode_batch';
      projectId: string;
      startEpisode: number;
      episodeCount: number;
      expectedPlanRevision: number;
      signal?: AbortSignal;
      onProgress?: (event: ScriptProgressEvent) => void | Promise<void>;
    };

export type ScriptDirectorResult =
  | {
      kind: 'planning_questions';
      questions: ReturnType<typeof assessScriptPlanning> extends infer _T
        ? Extract<ReturnType<typeof assessScriptPlanning>, { kind: 'questions' }>['questions']
        : never;
      askedFields: Extract<ReturnType<typeof assessScriptPlanning>, { kind: 'questions' }>['askedFields'];
      questionCount: number;
    }
  | { kind: 'planning_waiting'; missingFields: string[] }
  | { kind: 'plan_draft'; plan: ScriptPlan }
  | { kind: 'series_outline'; outline: ScriptSeriesOutline }
  | { kind: 'bible'; characters: ScriptCharacter[]; worldBible: ScriptWorldBible }
  | {
      kind: 'episode_batch';
      episodes: ScriptEpisode[];
      reports: Array<{ episodeNumber: number; report: ScriptGateReport }>;
      skippedEpisodeNumbers: number[];
    };

export class ScriptBatchPausedError extends Error {
  readonly code = 'SCRIPT_BATCH_PAUSED';

  constructor(
    readonly episodeNumber: number,
    readonly report: ScriptGateReport,
  ) {
    const hardIssueSummary = report.issues
      .filter((issue) => issue.severity === 'hard')
      .slice(0, 4)
      .map((issue) => `${issue.code}：${issue.message}`)
      .join('；');
    super(
      `第 ${episodeNumber} 集未通过硬质量门，批次已暂停。${hardIssueSummary
        ? ` ${hardIssueSummary}`
        : ''}`,
    );
    this.name = 'ScriptBatchPausedError';
  }
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ScriptModelOutputError(`模型结果缺少字符串字段 ${field}。`);
  }
  return value.trim();
}

function numberField(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ScriptModelOutputError(`模型结果缺少数字字段 ${field}。`);
  }
  return value;
}

function stringsField(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ScriptModelOutputError(`模型结果缺少字符串数组 ${field}。`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function recordField(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ScriptModelOutputError(`模型结果缺少对象字段 ${field}。`);
  }
  return value as Record<string, unknown>;
}

function enumField<const T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ScriptModelOutputError(`模型结果字段 ${field} 的值无效。`);
  }
  return value as T;
}

function optionalStringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function scriptLengthInstruction(targetChars: number, currentChars?: number): string {
  const blockCount = Math.max(12, Math.min(100, Math.round(targetChars / 18)));
  const charsPerBlock = Math.round(targetChars / blockCount);
  const minimumPerBlock = Math.max(12, Math.floor(charsPerBlock * 0.9));
  const maximumPerBlock = Math.ceil(charsPerBlock * 1.1);
  const current = currentChars === undefined
    ? ''
    : `当前正文只有 ${currentChars} 个可见字符，需增删约 ${Math.abs(targetChars - currentChars)} 个字符。`;
  return [
    current,
    `请让全部场景合计恰好包含 ${blockCount} 个 caption/action/dialogue 正文块，`,
    `每个 blocks.text 约 ${minimumPerBlock}—${maximumPerBlock} 个可见字符；`,
    '每个 text 至少写成一个完整句子，长度可参考“她攥紧彩票退到监控灯下，盯着老板把兑奖记录藏进抽屉”，不要用四五字短句凑块数；',
    `篇幅只能写进 blocks.text，summary、newFacts、openedThreads、closedThreads 不计入正文。`,
  ].join('');
}

export class ScriptDirector {
  constructor(private readonly dependencies: ScriptDirectorDependencies) {}

  async run(request: ScriptDirectorRequest): Promise<ScriptDirectorResult> {
    if (request.task === 'script_series_outline') {
      return this.generateSeriesOutline(request.projectId, request.signal);
    }
    if (request.task === 'script_bible') {
      return this.generateBible(request.projectId, request.signal);
    }
    if (request.task === 'script_episode_batch') {
      return this.generateEpisodeBatch(request);
    }
    const assessment = assessScriptPlanning(request.planningSession);
    if (assessment.kind === 'questions') {
      return {
        kind: 'planning_questions',
        questions: assessment.questions,
        askedFields: assessment.askedFields,
        questionCount: assessment.questionCount,
      };
    }
    if (assessment.kind === 'waiting') {
      return { kind: 'planning_waiting', missingFields: assessment.missingFields };
    }
    const current = (await this.dependencies.store.getProjectState(request.projectId))?.plan;
    const raw = await this.dependencies.model.complete({
      node: 'plan',
      projectId: request.projectId,
      prompt: [
        '你是短剧策划 Agent。根据已确认选项补全专业策划。',
        '只返回与 ScriptPlan 对应的 JSON，不输出思考过程或 Markdown 围栏。',
        [
          '必须返回以下全部字段：',
          'title, theme, market, channel, genres, audience, coreConflict, logline, highlights,',
          'totalEpisodes, episodeDurationSeconds, targetCharsPerEpisode, maxPrimaryCharacters,',
          'maxScenesPerEpisode, dialogueDensityPercent, language, format, coreRequirements,',
          'forbiddenElements, endingDirection；coverPrompt 可选。',
        ].join(' '),
        'episodeDurationSeconds 必须是 {"min":数字,"max":数字}；genres、highlights、forbiddenElements 必须是字符串数组。',
        'market 只能是 domestic/overseas，channel 只能是 female/male/general，language 必须是 zh-CN，format 必须是 cn_short_drama。',
        '范围：总集数1—200，时长30—180秒，单集300—3000字，主要角色1—20，场景1—5，对话密度20—90。',
        `用户故事想法：${request.seedPrompt?.trim() || '未提供，由 Agent 原创'}`,
        `已确认：${JSON.stringify(assessment.values)}`,
        `委托 Agent 字段：${assessment.delegatedFields.join('、') || '无'}`,
      ].join('\n'),
      signal: request.signal,
    });
    const parsed = parseStructuredModelOutput(raw);
    const duration = recordField(parsed.episodeDurationSeconds, 'episodeDurationSeconds');
    const explicit = assessment.values;
    const now = this.dependencies.now?.() ?? new Date().toISOString();
    const plan: ScriptPlan = {
      id: current?.id ?? this.dependencies.id?.() ?? randomUUID(),
      projectId: request.projectId,
      status: 'draft',
      revision: current?.revision ?? 0,
      title: stringField(parsed.title, 'title'),
      theme: stringField(parsed.theme, 'theme'),
      market: enumField(parsed.market, 'market', ['domestic', 'overseas']),
      channel: enumField(parsed.channel, 'channel', ['female', 'male', 'general']),
      genres: explicit.genres ?? stringsField(parsed.genres, 'genres'),
      audience: explicit.audience ?? stringField(parsed.audience, 'audience'),
      coreConflict: explicit.coreConflict ?? stringField(parsed.coreConflict, 'coreConflict'),
      logline: stringField(parsed.logline, 'logline'),
      highlights: stringsField(parsed.highlights, 'highlights'),
      totalEpisodes: explicit.totalEpisodes ?? numberField(parsed.totalEpisodes, 'totalEpisodes'),
      episodeDurationSeconds:
        explicit.episodeDurationSeconds ?? {
          min: numberField(duration.min, 'episodeDurationSeconds.min'),
          max: numberField(duration.max, 'episodeDurationSeconds.max'),
        },
      targetCharsPerEpisode:
        explicit.targetCharsPerEpisode ?? numberField(parsed.targetCharsPerEpisode, 'targetCharsPerEpisode'),
      maxPrimaryCharacters: numberField(parsed.maxPrimaryCharacters, 'maxPrimaryCharacters'),
      maxScenesPerEpisode:
        explicit.maxScenesPerEpisode ?? numberField(parsed.maxScenesPerEpisode, 'maxScenesPerEpisode'),
      dialogueDensityPercent:
        explicit.dialogueDensityPercent ?? numberField(parsed.dialogueDensityPercent, 'dialogueDensityPercent'),
      language: enumField(parsed.language, 'language', ['zh-CN']),
      format: enumField(parsed.format, 'format', ['cn_short_drama']),
      coreRequirements: typeof parsed.coreRequirements === 'string' ? parsed.coreRequirements.trim() : '',
      forbiddenElements: stringsField(parsed.forbiddenElements ?? [], 'forbiddenElements'),
      endingDirection:
        explicit.endingDirection ?? stringField(parsed.endingDirection, 'endingDirection'),
      ...(typeof parsed.coverPrompt === 'string' && parsed.coverPrompt.trim()
        ? { coverPrompt: parsed.coverPrompt.trim() }
        : {}),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    const saved = await this.dependencies.store.savePlan(plan, current?.revision ?? 0);
    await this.dependencies.checkpoints.save({
      projectId: request.projectId,
      runKey: 'script_plan',
      node: 'plan',
      status: 'completed',
      attempt: 1,
      artifactRevision: saved.revision,
      updatedAt: now,
    });
    return { kind: 'plan_draft', plan: saved };
  }

  private async generateSeriesOutline(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<ScriptDirectorResult> {
    const state = await this.dependencies.store.getProjectState(projectId);
    const plan = state?.plan;
    if (!plan || (plan.status !== 'approved' && plan.status !== 'locked')) {
      throw new ScriptModelOutputError('生成全剧大纲前必须先确认策划。');
    }
    if (state?.seriesOutline?.episodeCards.length === plan.totalEpisodes) {
      return { kind: 'series_outline', outline: state.seriesOutline };
    }

    const runKey = 'script_series_outline';
    const checkpoints = await this.dependencies.checkpoints.list(projectId, runKey);
    const chunks: Record<string, unknown>[] = [];
    for (let start = 1; start <= plan.totalEpisodes; start += 10) {
      const end = Math.min(plan.totalEpisodes, start + 9);
      const restored = checkpoints.find(
        (checkpoint) =>
          checkpoint.node === 'series_outline' &&
          checkpoint.chunkStart === start &&
          checkpoint.status === 'completed' &&
          checkpoint.artifact !== undefined,
      );
      if (restored?.artifact) {
        chunks.push(recordField(restored.artifact, 'seriesOutlineChunk'));
        continue;
      }
      const raw = await this.dependencies.model.complete({
        node: 'series_outline',
        projectId,
        chunkStart: start,
        chunkEnd: end,
        prompt: [
          '你是 SeriesOutlineAgent，生成全剧总纲和指定范围的轻量分集卡。',
          `本段只返回第 ${start}—${end} 集，集号必须连续。`,
          '只返回 JSON，字段：synopsis, openingState, midpointTurn, climax, endingState, mainArc, subplotArcs, episodeCards。',
          '严格模板：{"synopsis":"字符串","openingState":"字符串","midpointTurn":"字符串","climax":"字符串","endingState":"字符串","mainArc":["字符串"],"subplotArcs":["字符串"],"episodeCards":[{"episodeNumber":1,"title":"字符串","logline":"字符串","mainEvent":"字符串","endingHook":"字符串"}]}。不得翻译、缩写或改名任何键。',
          `已锁定策划：${JSON.stringify(plan)}`,
        ].join('\n'),
        signal,
      });
      const parsed = parseStructuredModelOutput(raw);
      chunks.push(parsed);
      await this.dependencies.checkpoints.save({
        projectId,
        runKey,
        node: 'series_outline',
        status: 'completed',
        attempt: 1,
        artifactRevision: state?.seriesOutline?.revision ?? 0,
        chunkStart: start,
        artifact: parsed,
        updatedAt: this.dependencies.now?.() ?? new Date().toISOString(),
      });
    }
    const first = chunks[0];
    if (!first) throw new ScriptModelOutputError('全剧大纲未生成任何分段。');
    const cards: ScriptEpisodeCard[] = chunks.flatMap((chunk) => {
      if (!Array.isArray(chunk.episodeCards)) {
        throw new ScriptModelOutputError('分集卡 episodeCards 必须是数组。');
      }
      return chunk.episodeCards.map((candidate) => {
        const card = recordField(candidate, 'episodeCard');
        return {
          episodeNumber: numberField(card.episodeNumber, 'episodeNumber'),
          title: stringField(card.title, 'title'),
          logline: stringField(card.logline, 'logline'),
          mainEvent: stringField(card.mainEvent, 'mainEvent'),
          endingHook: stringField(card.endingHook, 'endingHook'),
        };
      });
    });
    cards.sort((left, right) => left.episodeNumber - right.episodeNumber);
    if (
      cards.length !== plan.totalEpisodes ||
      cards.some((card, index) => card.episodeNumber !== index + 1)
    ) {
      throw new ScriptModelOutputError(
        `分集卡必须完整覆盖 1—${plan.totalEpisodes} 集且集号唯一连续。`,
      );
    }
    const outline: ScriptSeriesOutline = {
      projectId,
      synopsis: stringField(first.synopsis, 'synopsis'),
      openingState: stringField(first.openingState, 'openingState'),
      midpointTurn: stringField(first.midpointTurn, 'midpointTurn'),
      climax: stringField(first.climax, 'climax'),
      endingState: stringField(first.endingState, 'endingState'),
      mainArc: stringsField(first.mainArc, 'mainArc'),
      subplotArcs: stringsField(first.subplotArcs, 'subplotArcs'),
      episodeCards: cards,
      revision: state?.seriesOutline?.revision ?? 0,
    };
    const saved = await this.dependencies.store.saveSeriesOutline(
      outline,
      state?.seriesOutline?.revision ?? 0,
    );
    return { kind: 'series_outline', outline: saved };
  }

  private async generateBible(projectId: string, signal?: AbortSignal): Promise<ScriptDirectorResult> {
    const state = await this.dependencies.store.getProjectState(projectId);
    if (!state?.plan || !state.seriesOutline) {
      throw new ScriptModelOutputError('生成剧本圣经前必须先完成策划和全剧大纲。');
    }
    const now = this.dependencies.now?.() ?? new Date().toISOString();
    const plan = state.plan;
    const outline = state.seriesOutline;
    const characterTask = state.characters.length > 0
      ? Promise.resolve(state.characters)
      : this.dependencies.model.complete({
          node: 'character_bible',
          projectId,
          prompt: [
            '你是 CharacterDesignAgent。根据策划和大纲生成结构化人物圣经。',
            '只返回 JSON 对象 {"characters": [...]} ，不输出思考过程。',
            '每个人物严格包含：id, name, aliases, role, age(可选), occupation(可选), identity, biography, motivation, goal, weakness, arc, appearance, hairstyle, physique, defaultOutfit, personality, skills, speechStyle, catchphrases, relationships。',
            'role 只能是 lead/supporting/antagonist/minor；aliases/personality/skills/catchphrases/relationships 必须是数组；relationship 使用 {"characterId":"已存在人物id","label":"关系","notes":"可选说明"}。不得改名任何键。',
            `策划：${JSON.stringify(plan)}`,
            `大纲：${JSON.stringify(outline)}`,
          ].join('\n'),
          signal,
        }).then((raw) => this.parseCharacters(parseStructuredModelOutput(raw), projectId, now));
    const worldTask = state.worldBible
      ? Promise.resolve(state.worldBible)
      : this.dependencies.model.complete({
          node: 'world_bible',
          projectId,
          prompt: [
            '你是 WorldDesignAgent。根据策划和大纲生成结构化世界圣经。',
            '只返回 JSON，不输出思考过程。',
            '严格模板：{"era":"字符串","primaryLocations":["字符串"],"worldState":"字符串","rules":["字符串"],"transport":["字符串"],"communication":["字符串"],"organizations":["字符串"],"recurringProps":["字符串"],"forbiddenAnachronisms":["字符串"]}。不得翻译、缩写或改名任何键。',
            `策划：${JSON.stringify(plan)}`,
            `大纲：${JSON.stringify(outline)}`,
          ].join('\n'),
          signal,
        }).then((raw) => this.parseWorld(parseStructuredModelOutput(raw), projectId, now));

    const [generatedCharacters, generatedWorld] = await Promise.all([characterTask, worldTask]);
    const characters = state.characters.length > 0
      ? generatedCharacters
      : await this.dependencies.store.saveCharacters(projectId, generatedCharacters, 0);
    const worldBible = state.worldBible
      ? generatedWorld
      : await this.dependencies.store.saveWorldBible(generatedWorld, 0);
    await Promise.all([
      this.dependencies.checkpoints.save({
        projectId,
        runKey: 'script_bible',
        node: 'character_bible',
        status: 'completed',
        attempt: 1,
        artifactRevision: Math.max(0, ...characters.map((item) => item.revision)),
        updatedAt: now,
      }),
      this.dependencies.checkpoints.save({
        projectId,
        runKey: 'script_bible',
        node: 'world_bible',
        status: 'completed',
        attempt: 1,
        artifactRevision: worldBible.revision,
        updatedAt: now,
      }),
    ]);
    return { kind: 'bible', characters, worldBible };
  }

  private parseCharacters(
    parsed: Record<string, unknown>,
    projectId: string,
    now: string,
  ): ScriptCharacter[] {
    if (!Array.isArray(parsed.characters) || parsed.characters.length === 0) {
      throw new ScriptModelOutputError('人物圣经 characters 必须是非空数组。');
    }
    return parsed.characters.map((candidate) => {
      const value = recordField(candidate, 'character');
      const relationships = Array.isArray(value.relationships)
        ? value.relationships.map((candidateRelationship) => {
            const relationship = recordField(candidateRelationship, 'relationship');
            return {
              characterId: stringField(relationship.characterId, 'relationship.characterId'),
              label: stringField(relationship.label, 'relationship.label'),
              ...(optionalStringField(relationship.notes) ? { notes: optionalStringField(relationship.notes) } : {}),
            };
          })
        : [];
      return {
        id: optionalStringField(value.id) ?? this.dependencies.id?.() ?? randomUUID(),
        projectId,
        name: stringField(value.name, 'name'),
        aliases: stringsField(value.aliases ?? [], 'aliases'),
        role: enumField(value.role, 'role', ['lead', 'supporting', 'antagonist', 'minor']),
        ...(typeof value.age === 'number' ? { age: value.age } : {}),
        ...(optionalStringField(value.occupation) ? { occupation: optionalStringField(value.occupation) } : {}),
        identity: stringField(value.identity, 'identity'),
        biography: stringField(value.biography, 'biography'),
        motivation: stringField(value.motivation, 'motivation'),
        goal: stringField(value.goal, 'goal'),
        weakness: stringField(value.weakness, 'weakness'),
        arc: stringField(value.arc, 'arc'),
        appearance: stringField(value.appearance, 'appearance'),
        hairstyle: stringField(value.hairstyle, 'hairstyle'),
        physique: stringField(value.physique, 'physique'),
        defaultOutfit: stringField(value.defaultOutfit, 'defaultOutfit'),
        personality: stringsField(value.personality, 'personality'),
        skills: stringsField(value.skills ?? [], 'skills'),
        speechStyle: stringField(value.speechStyle, 'speechStyle'),
        catchphrases: stringsField(value.catchphrases ?? [], 'catchphrases'),
        relationships,
        revision: 0,
        updatedAt: now,
      };
    });
  }

  private parseWorld(
    value: Record<string, unknown>,
    projectId: string,
    now: string,
  ): ScriptWorldBible {
    return {
      projectId,
      era: stringField(value.era, 'era'),
      primaryLocations: stringsField(value.primaryLocations, 'primaryLocations'),
      worldState: stringField(value.worldState, 'worldState'),
      rules: stringsField(value.rules ?? [], 'rules'),
      transport: stringsField(value.transport ?? [], 'transport'),
      communication: stringsField(value.communication ?? [], 'communication'),
      organizations: stringsField(value.organizations ?? [], 'organizations'),
      recurringProps: stringsField(value.recurringProps ?? [], 'recurringProps'),
      forbiddenAnachronisms: stringsField(value.forbiddenAnachronisms ?? [], 'forbiddenAnachronisms'),
      revision: 0,
      updatedAt: now,
    };
  }

  private async generateEpisodeBatch(
    request: Extract<ScriptDirectorRequest, { task: 'script_episode_batch' }>,
  ): Promise<ScriptDirectorResult> {
    if (!Number.isInteger(request.episodeCount) || request.episodeCount < 1 || request.episodeCount > 5) {
      throw new ScriptModelOutputError('每批只能生成 1—5 集。');
    }
    if (!Number.isInteger(request.startEpisode) || request.startEpisode < 1) {
      throw new ScriptModelOutputError('起始集号必须是正整数。');
    }
    let state = await this.dependencies.store.getProjectState(request.projectId);
    if (!state?.plan || !state.seriesOutline || !state.worldBible || state.characters.length === 0) {
      throw new ScriptModelOutputError('生成正文前必须完成策划、全剧大纲、人物和世界圣经。');
    }
    const endEpisode = request.startEpisode + request.episodeCount - 1;
    if (endEpisode > state.plan.totalEpisodes) {
      throw new ScriptModelOutputError('批次范围超过策划总集数。');
    }
    const range = Array.from({ length: request.episodeCount }, (_, index) => request.startEpisode + index);
    const completed = state.episodes.filter(
      (episode) => range.includes(episode.episodeNumber) && episode.status === 'completed',
    );
    if (completed.length === range.length) {
      return {
        kind: 'episode_batch',
        episodes: completed.sort((left, right) => left.episodeNumber - right.episodeNumber),
        reports: [],
        skippedEpisodeNumbers: [...range],
      };
    }

    const runKey = `script_episode_batch:${request.startEpisode}:${request.episodeCount}`;
    const existingCheckpoints = await this.dependencies.checkpoints.list(request.projectId, runKey);
    let plan = state.plan;
    if (plan.status === 'approved') {
      plan = await this.dependencies.store.savePlan(
        { ...plan, status: 'locked', updatedAt: this.now() },
        request.expectedPlanRevision,
      );
      await this.saveCheckpoint(request, {
        projectId: request.projectId,
        runKey,
        node: 'plan',
        status: 'completed',
        attempt: 1,
        artifactRevision: plan.revision,
        updatedAt: this.now(),
      }, '剧本策划已锁定。');
    } else if (
      plan.status !== 'locked' ||
      (plan.revision !== request.expectedPlanRevision && existingCheckpoints.length === 0)
    ) {
      throw new ScriptModelOutputError('策划修订版已变更，请重新创建批次。');
    }

    state = (await this.dependencies.store.getProjectState(request.projectId)) ?? state;
    const seriesOutline = state.seriesOutline;
    if (!seriesOutline) {
      throw new ScriptModelOutputError('生成正文前必须先生成全剧大纲。');
    }
    let outlines = state.episodeOutlines.filter((outline) => range.includes(outline.episodeNumber));
    const missingOutlineNumbers = range.filter(
      (episodeNumber) => !outlines.some((outline) => outline.episodeNumber === episodeNumber),
    );
    if (missingOutlineNumbers.length > 0) {
      const registeredCharacterIds = new Set(
        state.characters.map((character) => character.id),
      );
      const raw = await this.callModel({
        node: 'episode_outline',
        projectId: request.projectId,
        prompt: [
          '你是 EpisodeOutlineAgent。只展开当前 1—5 集详细大纲。',
          '只返回 JSON {"outlines":[...]} ，每集必须有冲突、节拍和结尾卡点。',
          '每项严格模板：{"episodeNumber":1,"title":"字符串","goal":"字符串","conflict":"字符串","beats":["字符串"],"characterIds":["人物id"],"plannedScenes":[],"reveal":"可选字符串","reversal":"可选字符串","endingHook":"字符串","requiredFacts":["字符串"],"forbiddenFacts":["字符串"]}。plannedScenes 必须原样返回空数组 []，场景由下一节点规划；不得改名任何键。',
          `characterIds 只能从以下人物 ID 白名单选择：${JSON.stringify([...registeredCharacterIds])}。`,
          `需要集号：${missingOutlineNumbers.join('、')}`,
          `策划：${JSON.stringify(plan)}`,
          `分集卡：${JSON.stringify(seriesOutline.episodeCards.filter((card) => range.includes(card.episodeNumber)))}`,
          `当前连续性：${JSON.stringify(state.continuity)}`,
        ].join('\n'),
        signal: request.signal,
      });
      const parsed = parseStructuredModelOutput(raw);
      if (!Array.isArray(parsed.outlines)) {
        throw new ScriptModelOutputError('详细分集大纲 outlines 必须是数组。');
      }
      const generated = parsed.outlines.map((candidate) =>
        this.parseEpisodeOutline(
          recordField(candidate, 'episodeOutline'),
          request.projectId,
          registeredCharacterIds,
        ),
      );
      for (const episodeNumber of missingOutlineNumbers) {
        const outline = generated.find((item) => item.episodeNumber === episodeNumber);
        if (!outline) throw new ScriptModelOutputError(`详细大纲缺少第 ${episodeNumber} 集。`);
        const saved = await this.dependencies.store.saveEpisodeOutline(
          outline,
          state.episodeOutlines.find(
            (item) => item.episodeNumber === episodeNumber,
          )?.revision ?? 0,
        );
        outlines.push(saved);
      }
      const artifactRevision = Math.max(0, ...outlines.map((item) => item.revision));
      await this.saveCheckpoint(request, {
        projectId: request.projectId,
        runKey,
        node: 'episode_outline',
        status: 'completed',
        attempt: 1,
        artifactRevision,
        episodeNumber: request.startEpisode,
        updatedAt: this.now(),
      }, `已保存第 ${request.startEpisode}—${endEpisode} 集详细大纲。`);
    }

    const reports: Array<{ episodeNumber: number; report: ScriptGateReport }> = [];
    const episodes: ScriptEpisode[] = [];
    const skippedEpisodeNumbers: number[] = [];
    for (const episodeNumber of range) {
      state = (await this.dependencies.store.getProjectState(request.projectId)) ?? state;
      const alreadyCompleted = state.episodes.find(
        (episode) => episode.episodeNumber === episodeNumber && episode.status === 'completed',
      );
      if (alreadyCompleted) {
        episodes.push(alreadyCompleted);
        skippedEpisodeNumbers.push(episodeNumber);
        continue;
      }
      let outline = state.episodeOutlines.find((item) => item.episodeNumber === episodeNumber)
        ?? outlines.find((item) => item.episodeNumber === episodeNumber);
      if (!outline) throw new ScriptModelOutputError(`第 ${episodeNumber} 集详细大纲不存在。`);
      if (outline.plannedScenes.length === 0) {
        const raw = await this.callModel({
          node: 'scene_plan',
          projectId: request.projectId,
          episodeNumber,
          prompt: [
            '你是 EpisodeScenePlanner。将详细大纲确认为 1—5 个可拍摄场景。',
            '只返回 JSON {"plannedScenes":[...]}。',
            '每个场景严格使用 {"ordinal":1,"location":"地点","timeOfDay":"day|night|dawn|dusk","interiorExterior":"interior|exterior","purpose":"场景目的"}，场号从1连续递增，不得改名任何键。',
            '每个场景必须承担不同的戏剧任务，依次完成开场抓人、冲突升级、反转或结尾卡点；地点要具体且可拍摄，禁止用“某处”“未知地点”等占位词。',
            '优先复用人物与世界圣经已有地点，控制换景成本；结尾卡点必须落实在最后一个场景的 purpose 中。',
            `场景上限：${plan.maxScenesPerEpisode}`,
            `大纲：${JSON.stringify(outline)}`,
          ].join('\n'),
          signal: request.signal,
        });
        const parsed = parseStructuredModelOutput(raw);
        outline = await this.dependencies.store.saveEpisodeOutline(
          { ...outline, plannedScenes: this.parsePlannedScenes(parsed.plannedScenes, plan.maxScenesPerEpisode) },
          outline.revision,
        );
        await this.saveCheckpoint(request, {
          projectId: request.projectId,
          runKey,
          node: 'scene_plan',
          status: 'completed',
          attempt: 1,
          artifactRevision: outline.revision,
          episodeNumber,
          updatedAt: this.now(),
        }, `第 ${episodeNumber} 集场景计划已保存。`);
      }

      state = (await this.dependencies.store.getProjectState(request.projectId)) ?? state;
      let draft = state.episodes.find(
        (episode) => episode.episodeNumber === episodeNumber && episode.status === 'reviewing',
      );
      if (!draft) {
        const raw = await this.callModel({
          node: 'draft',
          projectId: request.projectId,
          episodeNumber,
          prompt: [
            '你是 ScriptWriterAgent。一次生成当前单集的结构化短剧正文。',
            '只返回 JSON，不输出思考过程、Markdown 或提示词。',
            '严格顶层模板：{"episodeNumber":1,"title":"字符串","scenes":[...],"summary":"可为空字符串","newFacts":[],"openedThreads":[],"closedThreads":[]}。',
            '每个 scene 严格包含 ordinal, location, timeOfDay(day|night|dawn|dusk), interiorExterior(interior|exterior), characterIds, blocks。每个 block 的 type 只能是 caption/action/dialogue 且必须有 text；dialogue 还必须有已登记人物的 characterId、speaker，可选 delivery 和 mode(normal|os|vo)。不得改名任何键。',
            'blocks.text 只写内容本身：caption 不要包“【字幕：】”，action 不要带“△”，dialogue 不要重复说话人或冒号；这些格式由序列化器统一添加。',
            'scene.characterIds 必须列出本场所有实际出场或说话人物，且对白 speaker 与 characterId 必须一一匹配。普通对白 mode 使用 normal；只有画外音和内心独白才使用 vo/os。',
            '正文必须是可拍摄的竖屏短剧：前三个正文块内出现人物、处境与冲突；动作使用镜头可见行为，避免小说式心理概述；单句对白简洁、有对抗性，不写大段说教。',
            '首次出现的重要人物或地点可用 caption 交代身份；后续不得机械重复字幕。最后一至两个正文块必须兑现本集 endingHook，以反转、证据、人物闯入或未完成动作收尾。',
            '严格遵守大纲 requiredFacts 与 forbiddenFacts；继承上一集结尾状态、服装、道具、人物已知信息和未回收伏笔，禁止让角色无理由换装、瞬移或提前知道秘密。',
            scriptLengthInstruction(plan.targetCharsPerEpisode),
            `所有 blocks.text 去除空白后的总字符数以 ${plan.targetCharsPerEpisode} 为目标，必须在 ${Math.ceil(plan.targetCharsPerEpisode * 0.85)}—${Math.floor(plan.targetCharsPerEpisode * 1.15)} 之间；请在返回前逐块相加核对，优先贴近目标值。`,
            `对白只能使用这些已登记人物：${JSON.stringify(state.characters.map((character) => ({ id: character.id, name: character.name })))}`,
            this.assembleEpisodeContext(state, plan, outline, episodeNumber),
          ].join('\n'),
          signal: request.signal,
        });
        draft = this.parseEpisode(
          parseStructuredModelOutput(raw),
          request.projectId,
          outline,
          plan.targetCharsPerEpisode,
          state.episodes.find((item) => item.episodeNumber === episodeNumber),
        );
        draft = await this.dependencies.store.saveEpisode(
          draft,
          state.episodes.find((item) => item.episodeNumber === episodeNumber)?.revision ?? 0,
        );
        await this.saveCheckpoint(request, {
          projectId: request.projectId,
          runKey,
          node: 'draft',
          status: 'completed',
          attempt: 1,
          artifactRevision: draft.revision,
          episodeNumber,
          updatedAt: this.now(),
        }, `第 ${episodeNumber} 集初稿已保存，进入审查。`);
      }

      if (!state) throw new ScriptModelOutputError('短剧项目状态丢失。');
      const reviewState = state;
      const reviewDraft = async (
        candidate: ScriptEpisode,
        attempt: number,
      ): Promise<ReturnType<ScriptDirector['parseReview']>> => {
        const reviewRaw = await this.callModel({
          node: 'review',
          projectId: request.projectId,
          episodeNumber,
          prompt: [
            '你是 ScriptContinuityAgent。只返回定位到场景/字段的结构化问题与记忆写回。',
            '只返回 JSON，字段：issues, summary, newFacts, openedThreads, closedThreads, wardrobe。',
            '严格模板：{"issues":[{"code":"字符串","severity":"hard|soft","message":"字符串","sceneId":"可选","path":"可选"}],"summary":"150—300字摘要","newFacts":["字符串"],"openedThreads":["字符串"],"closedThreads":["字符串"],"wardrobe":[{"characterId":"人物id","outfit":"服装"}]}。没有问题时 issues 返回空数组，不得改名任何键。',
            '逐项检查：人物身份与口吻、场景人物和说话人、时间地点衔接、服装道具、人物已知信息、requiredFacts、forbiddenFacts、重复台词、不可拍摄动作、冲突升级、反转铺垫和结尾卡点。',
            '会造成剧情矛盾、人物串线、关键事实缺失、结尾无卡点或无法拍摄的问题标为 hard；措辞、节奏、对白密度等可优化项标为 soft。每条问题必须尽量给出 sceneId 和精确 path。',
            attempt > 1 ? '这是修订后复检。不得假设上一轮问题已解决，必须以当前正文重新判断。' : '',
            `策划：${JSON.stringify(plan)}`,
            `大纲：${JSON.stringify(outline)}`,
            `连续性：${JSON.stringify(reviewState.continuity)}`,
            `正文：${JSON.stringify(candidate)}`,
          ].filter(Boolean).join('\n'),
          signal: request.signal,
        });
        const parsedReview = this.parseReview(parseStructuredModelOutput(reviewRaw));
        await this.saveCheckpoint(request, {
          projectId: request.projectId,
          runKey,
          node: 'review',
          status: 'completed',
          attempt,
          artifactRevision: candidate.revision,
          episodeNumber,
          artifact: parsedReview,
          updatedAt: this.now(),
        }, attempt > 1
          ? `第 ${episodeNumber} 集修订后复检完成。`
          : `第 ${episodeNumber} 集审查完成。`);
        return parsedReview;
      };
      let review = await reviewDraft(draft, 1);
      draft = {
        ...draft,
        summary: review.summary,
        newFacts: review.newFacts,
        openedThreads: review.openedThreads,
        closedThreads: review.closedThreads,
        updatedAt: this.now(),
      };
      const validateDraft = (
        candidate: ScriptEpisode,
        reviewIssues?: readonly ScriptGateIssue[],
      ): ScriptGateReport => validateScriptEpisode(candidate, plan, {
        expectedEpisodeNumber: episodeNumber,
        registeredCharacterIds: new Set(reviewState.characters.map((character) => character.id)),
        registeredCharacterNames: new Set(reviewState.characters.map((character) => character.name)),
        characterNamesById: new Map(reviewState.characters.map((character) => [character.id, character.name])),
        outline,
        previousEpisode: reviewState.episodes
          .filter((item) => item.episodeNumber < episodeNumber)
          .sort((left, right) => right.episodeNumber - left.episodeNumber)[0],
        continuity: reviewState.continuity,
        ...(reviewIssues ? { reviewIssues } : {}),
      });
      let deterministicReport = validateDraft(draft);
      let report = validateDraft(
        draft,
        review.issues.map((issue) => ({ ...issue, source: 'ai' })),
      );

      if (report.hardFailed) {
        const raw = await this.callModel({
          node: 'revision',
          projectId: request.projectId,
          episodeNumber,
          prompt: [
            '你是 ScriptRevisionAgent。只修改硬错误指向的场景和字段，保持其他内容不变。',
            '只返回完整单集 JSON，不输出思考过程。',
            '返回结构必须与输入正文完全同形：顶层保留 episodeNumber, title, scenes, summary, newFacts, openedThreads, closedThreads；场景和块不得改名或省略必填键。',
            '必须保留所有未命中硬错误的 scene.id、block.id、场景顺序和正文原文；只改问题定位到的最小范围。blocks.text 不得加入“△”“【字幕：】”或说话人前缀。',
            '修订后重新核对本集 requiredFacts、forbiddenFacts、人物白名单、上下集连续性与最后卡点，不能为修一个错误制造新的剧情事实。',
            scriptLengthInstruction(plan.targetCharsPerEpisode, report.visibleChars),
            `当前所有 blocks.text 去除空白后的总字符数是 ${report.visibleChars}，目标是 ${plan.targetCharsPerEpisode}；请据此精确增加或删除约 ${Math.abs(plan.targetCharsPerEpisode - report.visibleChars)} 个字符。最终必须在 ${Math.ceil(plan.targetCharsPerEpisode * 0.85)}—${Math.floor(plan.targetCharsPerEpisode * 1.15)} 之间，并优先贴近 ${plan.targetCharsPerEpisode}，返回前逐块相加核对。`,
            `对白只能使用这些已登记人物；未知说话人必须改为其中一个人物：${JSON.stringify(state.characters.map((character) => ({ id: character.id, name: character.name })))}`,
            `本集大纲：${JSON.stringify(outline)}`,
            `阻断错误：${JSON.stringify(report.blockingIssues)}`,
            `正文：${JSON.stringify(draft)}`,
          ].join('\n'),
          signal: request.signal,
        });
        let revised = this.parseEpisode(
          parseStructuredModelOutput(raw),
          request.projectId,
          outline,
          plan.targetCharsPerEpisode,
          draft,
        );
        revised = await this.dependencies.store.saveEpisode(revised, draft.revision);
        await this.saveCheckpoint(request, {
          projectId: request.projectId,
          runKey,
          node: 'revision',
          status: 'completed',
          attempt: 1,
          artifactRevision: revised.revision,
          episodeNumber,
          updatedAt: this.now(),
        }, `第 ${episodeNumber} 集定点修订已保存。`);
        draft = { ...revised, summary: review.summary, newFacts: review.newFacts, openedThreads: review.openedThreads, closedThreads: review.closedThreads };
        review = await reviewDraft(draft, 2);
        draft = {
          ...draft,
          summary: review.summary,
          newFacts: review.newFacts,
          openedThreads: review.openedThreads,
          closedThreads: review.closedThreads,
          updatedAt: this.now(),
        };
        deterministicReport = validateDraft(draft);
        report = validateDraft(
          draft,
          review.issues.map((issue) => ({ ...issue, source: 'ai' })),
        );
      }
      if (report.hardFailed) {
        const failed = await this.dependencies.store.saveEpisode(
          { ...draft, status: 'failed', updatedAt: this.now() },
          draft.revision,
        );
        await this.persistReviewIssues(
          request.projectId,
          episodeNumber,
          deterministicReport.issues,
          review.issues,
        );
        reports.push({ episodeNumber, report });
        throw new ScriptBatchPausedError(failed.episodeNumber, report);
      }

      const persistedReview = await this.persistReviewIssues(
        request.projectId,
        episodeNumber,
        deterministicReport.issues,
        review.issues,
      );
      const retainedOpenHard = persistedReview.items.filter(
        (item) =>
          item.episodeNumber === episodeNumber && isBlockingScriptReviewIssue(item),
      );
      if (retainedOpenHard.length > 0) {
        const known = new Set(report.issues.map((issue) =>
          [issue.code, issue.sceneId ?? '', issue.blockId ?? '', issue.path ?? ''].join('\u0000'),
        ));
        const additional = retainedOpenHard
          .filter((issue) => !known.has(
            [issue.code, issue.sceneId ?? '', issue.blockId ?? '', issue.path ?? ''].join('\u0000'),
          ))
          .map((issue): ScriptEvaluatedGateIssue => ({
            code: issue.code,
            severity: 'hard',
            source: issue.source,
            blocking: true,
            message: issue.message,
            ...(issue.sceneId ? { sceneId: issue.sceneId } : {}),
            ...(issue.blockId ? { blockId: issue.blockId } : {}),
            ...(issue.path ? { path: issue.path } : {}),
          }));
        report = {
          ...report,
          hardFailed: true,
          issues: [...report.issues, ...additional],
          blockingIssues: [...report.blockingIssues, ...additional],
        };
        const failed = await this.dependencies.store.saveEpisode(
          { ...draft, status: 'failed', updatedAt: this.now() },
          draft.revision,
        );
        reports.push({ episodeNumber, report });
        throw new ScriptBatchPausedError(failed.episodeNumber, report);
      }
      const saved = await this.dependencies.store.saveEpisode(
        { ...draft, status: 'completed', updatedAt: this.now() },
        draft.revision,
      );
      const continuity = this.mergeContinuity(state.continuity, saved, review.wardrobe);
      await this.dependencies.store.saveContinuity(request.projectId, continuity);
      episodes.push(saved);
      reports.push({ episodeNumber, report });
      await this.saveCheckpoint(request, {
        projectId: request.projectId,
        runKey,
        node: 'completed',
        status: 'completed',
        attempt: 1,
        artifactRevision: saved.revision,
        episodeNumber,
        updatedAt: this.now(),
      }, `第 ${episodeNumber} 集已通过质量门。`);
    }
    await this.saveCheckpoint(request, {
      projectId: request.projectId,
      runKey,
      node: 'batch_report',
      status: 'completed',
      attempt: 1,
      artifactRevision: Math.max(0, ...episodes.map((episode) => episode.revision)),
      artifact: reports,
      updatedAt: this.now(),
    }, `第 ${request.startEpisode}—${endEpisode} 集批次完成。`);
    return {
      kind: 'episode_batch',
      episodes: episodes.sort((left, right) => left.episodeNumber - right.episodeNumber),
      reports,
      skippedEpisodeNumbers,
    };
  }

  private parseEpisodeOutline(
    value: Record<string, unknown>,
    projectId: string,
    registeredCharacterIds?: ReadonlySet<string>,
  ): ScriptEpisodeOutline {
    const plannedScenes = Array.isArray(value.plannedScenes) && value.plannedScenes.length > 0
      ? this.parsePlannedScenes(value.plannedScenes, 5)
      : [];
    const characterIds = stringsField(value.characterIds ?? [], 'characterIds');
    const unknownCharacterId = characterIds.find(
      (characterId) => registeredCharacterIds && !registeredCharacterIds.has(characterId),
    );
    if (unknownCharacterId) {
      throw new ScriptModelOutputError(`详细大纲引用了未登记人物 ID：${unknownCharacterId}。`);
    }
    return {
      id: optionalStringField(value.id) ?? this.createId(),
      projectId,
      episodeNumber: numberField(value.episodeNumber, 'episodeNumber'),
      title: stringField(value.title, 'title'),
      goal: stringField(value.goal, 'goal'),
      conflict: stringField(value.conflict, 'conflict'),
      beats: stringsField(value.beats, 'beats'),
      characterIds,
      plannedScenes,
      ...(optionalStringField(value.reveal) ? { reveal: optionalStringField(value.reveal) } : {}),
      ...(optionalStringField(value.reversal) ? { reversal: optionalStringField(value.reversal) } : {}),
      endingHook: stringField(value.endingHook, 'endingHook'),
      requiredFacts: stringsField(value.requiredFacts ?? [], 'requiredFacts'),
      forbiddenFacts: stringsField(value.forbiddenFacts ?? [], 'forbiddenFacts'),
      status: 'expanded',
      revision: 0,
    };
  }

  private parsePlannedScenes(value: unknown, maxScenes: number): ScriptPlannedScene[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > maxScenes) {
      throw new ScriptModelOutputError(`plannedScenes 数量必须为 1—${maxScenes}。`);
    }
    const ordinals = new Set<number>();
    return value.map((candidate) => {
      const scene = recordField(candidate, 'plannedScene');
      const ordinal = numberField(scene.ordinal, 'ordinal');
      if (ordinals.has(ordinal)) throw new ScriptModelOutputError(`场号 ${ordinal} 重复。`);
      ordinals.add(ordinal);
      return {
        ordinal,
        location: stringField(scene.location, 'location'),
        timeOfDay: enumField(scene.timeOfDay, 'timeOfDay', ['day', 'night', 'dawn', 'dusk']),
        interiorExterior: enumField(scene.interiorExterior, 'interiorExterior', ['interior', 'exterior']),
        purpose: stringField(scene.purpose, 'purpose'),
      };
    });
  }

  private parseEpisode(
    value: Record<string, unknown>,
    projectId: string,
    outline: ScriptEpisodeOutline,
    targetChars: number,
    current?: ScriptEpisode,
  ): ScriptEpisode {
    if (!Array.isArray(value.scenes)) throw new ScriptModelOutputError('scenes 必须是数组。');
    const scenes: ScriptScene[] = value.scenes.map((candidate) => {
      const scene = recordField(candidate, 'scene');
      if (!Array.isArray(scene.blocks)) throw new ScriptModelOutputError('blocks 必须是数组。');
      return {
        id: optionalStringField(scene.id) ?? this.createId(),
        ordinal: numberField(scene.ordinal, 'ordinal'),
        location: stringField(scene.location, 'location'),
        timeOfDay: enumField(scene.timeOfDay, 'timeOfDay', ['day', 'night', 'dawn', 'dusk']),
        interiorExterior: enumField(scene.interiorExterior, 'interiorExterior', ['interior', 'exterior']),
        characterIds: stringsField(scene.characterIds ?? [], 'characterIds'),
        blocks: scene.blocks.map((candidateBlock) => {
          const block = recordField(candidateBlock, 'block');
          const type = enumField(block.type, 'type', ['caption', 'action', 'dialogue']);
          const id = optionalStringField(block.id) ?? this.createId();
          const text = stringField(block.text, 'text');
          if (type === 'caption' || type === 'action') return { id, type, text };
          return {
            id,
            type: 'dialogue' as const,
            ...(optionalStringField(block.characterId) ? { characterId: optionalStringField(block.characterId) } : {}),
            speaker: stringField(block.speaker, 'speaker'),
            ...(optionalStringField(block.delivery) ? { delivery: optionalStringField(block.delivery) } : {}),
            ...(block.mode !== undefined
              ? { mode: enumField(block.mode, 'mode', ['normal', 'os', 'vo']) }
              : {}),
            text,
          };
        }),
      };
    });
    const now = this.now();
    return {
      id: current?.id ?? optionalStringField(value.id) ?? this.createId(),
      projectId,
      episodeNumber: numberField(value.episodeNumber, 'episodeNumber'),
      title: stringField(value.title, 'title'),
      outlineId: outline.id,
      status: 'reviewing',
      targetChars,
      scenes,
      summary: typeof value.summary === 'string' ? value.summary.trim() : '',
      newFacts: stringsField(value.newFacts ?? [], 'newFacts'),
      openedThreads: stringsField(value.openedThreads ?? [], 'openedThreads'),
      closedThreads: stringsField(value.closedThreads ?? [], 'closedThreads'),
      revision: current?.revision ?? 0,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
  }

  private parseReview(value: Record<string, unknown>): {
    issues: ScriptGateIssue[];
    summary: string;
    newFacts: string[];
    openedThreads: string[];
    closedThreads: string[];
    wardrobe: Array<{ characterId: string; outfit: string }>;
  } {
    const rawIssues = Array.isArray(value.issues) ? value.issues : [];
    const issues = rawIssues.map((candidate) => {
      const issue = recordField(candidate, 'issue');
      return {
        code: stringField(issue.code, 'issue.code'),
        severity: enumField(issue.severity, 'issue.severity', ['hard', 'soft']),
        message: stringField(issue.message, 'issue.message'),
        ...(optionalStringField(issue.sceneId) ? { sceneId: optionalStringField(issue.sceneId) } : {}),
        ...(optionalStringField(issue.path) ? { path: optionalStringField(issue.path) } : {}),
      };
    });
    const wardrobe = Array.isArray(value.wardrobe)
      ? value.wardrobe.map((candidate) => {
          const item = recordField(candidate, 'wardrobe');
          return {
            characterId: stringField(item.characterId, 'wardrobe.characterId'),
            outfit: stringField(item.outfit, 'wardrobe.outfit'),
          };
        })
      : [];
    return {
      issues,
      summary: stringField(value.summary, 'summary'),
      newFacts: stringsField(value.newFacts ?? [], 'newFacts'),
      openedThreads: stringsField(value.openedThreads ?? [], 'openedThreads'),
      closedThreads: stringsField(value.closedThreads ?? [], 'closedThreads'),
      wardrobe,
    };
  }

  private async persistReviewIssues(
    projectId: string,
    episodeNumber: number,
    deterministicIssues: readonly ScriptGateIssue[],
    aiIssues: readonly ScriptGateIssue[],
  ): Promise<ScriptReviewIssueCollection> {
    const now = this.now();
    return this.dependencies.store.replaceEpisodeReviewIssues(
      projectId,
      episodeNumber,
      ['deterministic', 'ai'],
      [
        ...createScriptReviewIssues(
          projectId,
          episodeNumber,
          'deterministic',
          deterministicIssues,
          now,
        ),
        ...createScriptReviewIssues(projectId, episodeNumber, 'ai', aiIssues, now),
      ],
    );
  }

  private mergeContinuity(
    current: ScriptContinuityState,
    episode: ScriptEpisode,
    wardrobe: Array<{ characterId: string; outfit: string }>,
  ): ScriptContinuityState {
    const closed = new Set(episode.closedThreads);
    return {
      currentState: [...current.currentState, ...episode.newFacts].slice(-100),
      openThreads: [...new Set([...current.openThreads.filter((item) => !closed.has(item)), ...episode.openedThreads])],
      wardrobeLedger: [
        ...current.wardrobeLedger.filter((item) => item.episodeNumber !== episode.episodeNumber),
        ...wardrobe.map((item) => ({ episodeNumber: episode.episodeNumber, ...item })),
      ],
    };
  }

  private assembleEpisodeContext(
    state: NonNullable<Awaited<ReturnType<ScriptStore['getProjectState']>>>,
    plan: ScriptPlan,
    outline: ScriptEpisodeOutline,
    episodeNumber: number,
  ): string {
    const previous = state.episodes.find((episode) => episode.episodeNumber === episodeNumber - 1);
    const cast = state.characters.filter((character) => outline.characterIds.includes(character.id));
    const sections = [
      ['锁定策划', JSON.stringify(plan), 2_500],
      ['世界圣经', JSON.stringify(state.worldBible), 2_500],
      ['本集人物', JSON.stringify(cast), 6_000],
      ['本集大纲', JSON.stringify(outline), 2_500],
      ['上集摘要', JSON.stringify(previous ? { summary: previous.summary, scenes: previous.scenes.slice(-1) } : {}), 2_000],
      ['伏笔与当前状态', JSON.stringify(state.continuity), 1_500],
      ['格式规则', '结构化 JSON；1—5 场；每场含地点、时间、内外景、人物与 caption/action/dialogue 块。', 1_000],
    ] as const;
    return sections
      .map(([label, content, limit]) => `${label}：${content.slice(0, limit)}`)
      .join('\n');
  }

  private async callModel(request: ScriptModelRequest): Promise<string> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const output = await this.dependencies.model.complete(request);
        if (!output.trim()) throw new ScriptModelOutputError('模型返回空内容。');
        return output;
      } catch (error) {
        if (attempt === 3 || !this.isTransient(error)) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, attempt === 1 ? 2_000 : 5_000));
      }
    }
    throw new ScriptModelOutputError('模型请求失败。');
  }

  private isTransient(error: unknown): boolean {
    if (error instanceof ScriptModelOutputError) return false;
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as { status?: unknown; code?: unknown };
    const status = typeof candidate.status === 'number' ? candidate.status : undefined;
    return status === 429 || (status !== undefined && status >= 500) ||
      ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(String(candidate.code ?? ''));
  }

  private async saveCheckpoint(
    request: Extract<ScriptDirectorRequest, { task: 'script_episode_batch' }>,
    checkpoint: ScriptPipelineCheckpoint,
    message: string,
  ): Promise<void> {
    await this.dependencies.checkpoints.save(checkpoint);
    await request.onProgress?.({
      phase: 'info',
      message,
      ...(checkpoint.episodeNumber !== undefined ? { current: checkpoint.episodeNumber } : {}),
      total: request.startEpisode + request.episodeCount - 1,
      scriptCheckpoint: {
        ...(checkpoint.episodeNumber !== undefined ? { episodeNumber: checkpoint.episodeNumber } : {}),
        node: checkpoint.node,
        attempt: checkpoint.attempt,
        artifactRevision: checkpoint.artifactRevision,
      },
    });
  }

  private now(): string {
    return this.dependencies.now?.() ?? new Date().toISOString();
  }

  private createId(): string {
    return this.dependencies.id?.() ?? randomUUID();
  }
}
