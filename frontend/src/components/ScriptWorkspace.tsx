import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient, { isApiClientError, type ApiClient } from '../api/apiClient.js';
import type {
  Id,
  ScriptAgentJobSnapshot,
  ScriptBatchSummary,
  ScriptCharacter,
  ScriptConceptProposal,
  ScriptEpisode,
  ScriptEpisodeSummary,
  ScriptPlan,
  ScriptPlanAnswer,
  ScriptPlanQuestion,
  ScriptReviewIssue,
  ScriptReviewStatus,
  ScriptSeriesOutline,
  ScriptWorkspaceSnapshot,
  ScriptWorldBible,
} from '../types/index.js';
import { buildProjectDocxBlob, downloadBlobFile, sanitizeDownloadName } from '../lib/projectExport.js';
import {
  buildScriptBatchNavigation,
  ScriptCharactersReadView,
  ScriptEpisodeReader,
  ScriptOutlineReadView,
  ScriptPlanReadView,
  ScriptProductionSidebar,
  ScriptWorldReadView,
  type ScriptPrimaryStage,
} from './script/ScriptProductViews.js';
import './script-workspace.css';

type ScriptStage = ScriptPrimaryStage;
type ScriptExportRange = { startEpisode: number; episodeCount: number };

export interface ScriptWorkspaceProps {
  projectId: Id;
  projectName?: string;
  onError?: (error: unknown) => string | void;
  /** Dismisses only the transient polling error previously returned by onError. */
  onErrorClear?: (errorId: string) => void;
  client?: Pick<ApiClient, 'script'>;
}

interface ScriptWorkspaceData {
  plan: ScriptPlan;
  outline?: ScriptSeriesOutline;
  characters: ScriptCharacter[];
  world?: ScriptWorldBible;
  episodes: ScriptEpisodeSummary[];
  jobs: ScriptAgentJobSnapshot[];
  batchSummaries: ScriptBatchSummary[];
  reviewRevision: number;
  reviewIssues: ScriptReviewIssue[];
}

type EditableScriptResource = 'plan' | 'outline' | 'characters' | 'world';
type ScriptResourceFlags = Record<EditableScriptResource, boolean>;
type ScriptResourceVersions = Record<EditableScriptResource, number>;

const SCRIPT_RESOURCE_LABEL: Record<EditableScriptResource, string> = {
  plan: '策划',
  outline: '大纲',
  characters: '角色设定',
  world: '世界设定',
};

function cleanResourceFlags(): ScriptResourceFlags {
  return { plan: false, outline: false, characters: false, world: false };
}

function cleanResourceVersions(): ScriptResourceVersions {
  return { plan: 0, outline: 0, characters: 0, world: 0 };
}

function emptyPlan(projectId: Id, projectName?: string): ScriptPlan {
  const now = new Date().toISOString();
  return {
    id: `script-plan-${projectId}`,
    projectId,
    status: 'draft',
    revision: 0,
    title: projectName ?? '',
    theme: '',
    market: 'domestic',
    channel: 'general',
    genres: [],
    audience: '',
    coreConflict: '',
    logline: '',
    highlights: [],
    totalEpisodes: 60,
    episodeDurationSeconds: { min: 60, max: 90 },
    targetCharsPerEpisode: 1200,
    maxPrimaryCharacters: 10,
    maxScenesPerEpisode: 3,
    dialogueDensityPercent: 60,
    language: 'zh-CN',
    format: 'cn_short_drama',
    coreRequirements: '',
    forbiddenElements: [],
    endingDirection: '',
    createdAt: now,
    updatedAt: now,
  };
}

function emptyOutline(projectId: Id): ScriptSeriesOutline {
  return {
    projectId,
    synopsis: '',
    openingState: '',
    midpointTurn: '',
    climax: '',
    endingState: '',
    mainArc: [],
    subplotArcs: [],
    episodeCards: [],
    revision: 0,
  };
}

function emptyWorld(projectId: Id): ScriptWorldBible {
  return {
    projectId,
    era: '',
    primaryLocations: [],
    worldState: '',
    rules: [],
    transport: [],
    communication: [],
    organizations: [],
    recurringProps: [],
    forbiddenAnachronisms: [],
    revision: 0,
    updatedAt: new Date().toISOString(),
  };
}

function isMissing(error: unknown): boolean {
  return (isApiClientError(error) && error.status === 404) ||
    (typeof error === 'object' && error !== null && (error as { status?: number }).status === 404);
}

async function optional<T>(request: Promise<T>): Promise<T | undefined> {
  try {
    return await request;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function PlanEditor({
  value,
  busy,
  conceptBusy,
  conceptPrompt,
  concepts,
  questions,
  answers,
  onChange,
  onConceptPromptChange,
  onGenerateConcepts,
  onAdoptConcept,
  onSave,
  onAgentPlan,
  onAutoComplete,
  onAnswer,
  onDelegate,
  onSubmitAnswers,
  onApprove,
}: {
  value: ScriptPlan;
  busy: boolean;
  conceptBusy: boolean;
  conceptPrompt: string;
  concepts: ScriptConceptProposal[];
  questions: ScriptPlanQuestion[];
  answers: Record<string, ScriptPlanAnswer>;
  onChange: (value: ScriptPlan) => void;
  onConceptPromptChange: (value: string) => void;
  onGenerateConcepts: () => void;
  onAdoptConcept: (concept: ScriptConceptProposal) => void;
  onSave: () => void;
  onAgentPlan: () => void;
  onAutoComplete: () => void;
  onAnswer: (field: string, value: NonNullable<ScriptPlanAnswer['value']>) => void;
  onDelegate: (field: string) => void;
  onSubmitAnswers: () => void;
  onApprove: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<'read' | 'edit'>(() => value.status === 'draft' ? 'edit' : 'read');
  const patch = <K extends keyof ScriptPlan>(key: K, next: ScriptPlan[K]) =>
    onChange({ ...value, [key]: next });
  return (
    <section className="script-stage-panel" aria-labelledby="script-plan-heading">
      <header className="script-stage-heading">
        <div><span>第一阶段</span><h2 id="script-plan-heading">剧本策划</h2></div>
        <div className="script-stage-heading__actions">
          <div className="script-view-switch" role="group" aria-label="策划查看模式">
            <button type="button" aria-pressed={mode === 'read'} onClick={() => setMode('read')}>阅读模式</button>
            <button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>编辑模式</button>
          </div>
          <span className="script-status-chip">{value.status === 'draft' ? '草稿' : value.status === 'approved' ? '已确认' : '已锁定'}</span>
        </div>
      </header>
      <section className="script-concept-studio" aria-labelledby="script-concept-heading">
        <div className="script-concept-studio__intro"><span>从一个灵感开始</span><h3 id="script-concept-heading">AI 选题</h3><p>输入题材、冲突或受众，生成 3 个可继续深化的短剧方向。</p></div>
        <div className="script-concept-input"><input aria-label="选题灵感" value={conceptPrompt} onChange={(event) => onConceptPromptChange(event.target.value)} placeholder="例如：都市女频，儿媳用美食反击情绪勒索" /><button type="button" className="nwa-button" disabled={conceptBusy} onClick={onGenerateConcepts}>{conceptBusy ? '选题生成中…' : concepts.length > 0 ? 'AI 重新生成选题' : '生成 3 个选题'}</button></div>
        {concepts.length ? <div className="script-concept-cards">{concepts.map((concept, index) => <article key={`${concept.title}-${index}`}><header><span>方向 {index + 1}</span><strong>{concept.title}</strong></header><p>{concept.logline}</p><div className="script-read-tags">{concept.genres.map((genre) => <span key={genre}>{genre}</span>)}</div><dl><div><dt>受众</dt><dd>{concept.audience}</dd></div><div><dt>核心冲突</dt><dd>{concept.coreConflict}</dd></div></dl><button type="button" className="nwa-button nwa-button--ghost" onClick={() => onAdoptConcept(concept)}>采用此方案</button></article>)}</div> : <div className="script-concept-empty">还没有候选方案。AI 只会基于你的灵感生成真实候选，不会用占位内容覆盖现有策划。</div>}
      </section>
      {mode === 'read' ? <ScriptPlanReadView value={value} /> : <>
      <div className="script-form-grid">
        <label className="script-field script-field--wide">剧本名称<input value={value.title} onChange={(e) => patch('title', e.target.value)} /></label>
        <label className="script-field script-field--wide">主题<textarea value={value.theme} onChange={(e) => patch('theme', e.target.value)} /></label>
        <label className="script-field">市场<select value={value.market} onChange={(e) => patch('market', e.target.value as ScriptPlan['market'])}><option value="domestic">国内</option><option value="overseas">海外</option></select></label>
        <label className="script-field">频道<select value={value.channel} onChange={(e) => patch('channel', e.target.value as ScriptPlan['channel'])}><option value="female">女频</option><option value="male">男频</option><option value="general">通用</option></select></label>
        <label className="script-field script-field--wide">题材（逗号分隔）<input value={value.genres.join('，')} onChange={(e) => patch('genres', e.target.value.split(/[，,]/).map((item) => item.trim()).filter(Boolean))} /></label>
        <label className="script-field script-field--wide">一句话梗概<textarea value={value.logline} onChange={(e) => patch('logline', e.target.value)} /></label>
        <label className="script-field script-field--wide">核心冲突<textarea value={value.coreConflict} onChange={(e) => patch('coreConflict', e.target.value)} /></label>
        <label className="script-field script-field--wide">核心亮点（每行一项）<textarea value={value.highlights.join('\n')} onChange={(e) => patch('highlights', e.target.value.split('\n').map((item) => item.trim()).filter(Boolean))} /></label>
        <label className="script-field">总集数<input type="number" min={1} max={200} value={value.totalEpisodes} onChange={(e) => patch('totalEpisodes', Number(e.target.value))} /></label>
        <label className="script-field">单集目标字数<input type="number" min={300} max={3000} value={value.targetCharsPerEpisode} onChange={(e) => patch('targetCharsPerEpisode', Number(e.target.value))} /></label>
        <label className="script-field">对白目标比例（%）<input type="number" min={20} max={90} value={value.dialogueDensityPercent} onChange={(e) => patch('dialogueDensityPercent', Number(e.target.value))} /></label>
        <label className="script-field">单集时长下限（秒）<input type="number" min={30} max={180} value={value.episodeDurationSeconds.min} onChange={(e) => patch('episodeDurationSeconds', { ...value.episodeDurationSeconds, min: Number(e.target.value) })} /></label>
        <label className="script-field">单集时长上限（秒）<input type="number" min={30} max={180} value={value.episodeDurationSeconds.max} onChange={(e) => patch('episodeDurationSeconds', { ...value.episodeDurationSeconds, max: Number(e.target.value) })} /></label>
        <label className="script-field">主要角色上限<input type="number" min={1} max={20} value={value.maxPrimaryCharacters} onChange={(e) => patch('maxPrimaryCharacters', Number(e.target.value))} /></label>
        <label className="script-field">每集场景上限<input type="number" min={1} max={5} value={value.maxScenesPerEpisode} onChange={(e) => patch('maxScenesPerEpisode', Number(e.target.value))} /></label>
        <label className="script-field script-field--wide">目标受众<input value={value.audience} onChange={(e) => patch('audience', e.target.value)} /></label>
        <label className="script-field script-field--wide">核心要求<textarea rows={5} value={value.coreRequirements} onChange={(e) => patch('coreRequirements', e.target.value)} /></label>
        <label className="script-field script-field--wide">禁用元素（每行一项）<textarea value={value.forbiddenElements.join('\n')} onChange={(e) => patch('forbiddenElements', e.target.value.split('\n').map((item) => item.trim()).filter(Boolean))} /></label>
        <label className="script-field script-field--wide">结局方向<textarea value={value.endingDirection} onChange={(e) => patch('endingDirection', e.target.value)} /></label>
        <label className="script-field script-field--wide">9:16 封面视觉提示词<textarea rows={4} value={value.coverPrompt ?? ''} onChange={(e) => patch('coverPrompt', e.target.value)} /></label>
      </div>
      {questions.length > 0 ? (
        <section className="script-plan-interview" aria-label="短剧策划问题">
          <h3>Agent 还需要确认</h3>
          {questions.map((question) => {
            const answer = answers[question.field];
            const selected = answer?.value;
            return (
              <fieldset key={question.field} className="script-plan-question">
                <legend>{question.label}</legend>
                {question.help ? <p>{question.help}</p> : null}
                {question.options?.length ? (
                  <div className="script-plan-options">
                    {question.options.map((option) => {
                      const pressed = Array.isArray(selected)
                        ? selected.includes(option.value)
                        : selected === option.value;
                      return <button key={option.value} type="button" className={pressed ? 'is-selected' : ''} aria-pressed={pressed} onClick={() => {
                        if (question.kind === 'multi') {
                          const values = Array.isArray(selected) ? selected : [];
                          onAnswer(question.field, pressed ? values.filter((item) => item !== option.value) : [...values, option.value]);
                        } else {
                          onAnswer(question.field, option.value);
                        }
                      }}>{option.label}</button>;
                    })}
                  </div>
                ) : (
                  <input
                    aria-label={question.label}
                    type={question.kind === 'number' ? 'number' : 'text'}
                    value={typeof selected === 'string' || typeof selected === 'number' ? selected : ''}
                    onChange={(event) => onAnswer(question.field, question.kind === 'number' ? Number(event.target.value) : event.target.value)}
                  />
                )}
                <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" aria-pressed={answer?.delegate === true} onClick={() => onDelegate(question.field)}>交给 Agent</button>
              </fieldset>
            );
          })}
          <button type="button" className="nwa-button" disabled={busy} onClick={onSubmitAnswers}>提交本轮答案</button>
        </section>
      ) : null}
      </>}
      <footer className="script-stage-actions">
        <button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={onAgentPlan}>Agent 帮我策划</button>
        <button type="button" className="nwa-button script-ai-skip" disabled={busy} onClick={onAutoComplete}>跳过手填，AI 自动完成策划</button>
        {value.revision > 0 ? <button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={onAutoComplete}>AI 重新生成策划</button> : null}
        <button type="button" className="nwa-button" disabled={busy} onClick={onSave}>{busy ? '保存中…' : '保存策划'}</button>
        {value.status === 'draft' ? <button type="button" className="nwa-button" disabled={busy} onClick={onApprove}>确认策划</button> : null}
      </footer>
    </section>
  );
}

function fromWorkspaceSnapshot(
  snapshot: ScriptWorkspaceSnapshot,
  jobs: ScriptAgentJobSnapshot[],
  projectId: Id,
  projectName?: string,
): ScriptWorkspaceData {
  return {
    plan: snapshot.plan ?? emptyPlan(projectId, projectName),
    outline: snapshot.outline,
    characters: snapshot.characters ?? [],
    world: snapshot.worldBible,
    episodes: snapshot.episodeSummaries ?? [],
    jobs,
    batchSummaries: snapshot.batchSummaries ?? [],
    reviewRevision: Number.isInteger(snapshot.reviewRevision) ? snapshot.reviewRevision : 0,
    reviewIssues: snapshot.reviewIssues ?? [],
  };
}

function mergeWorkspaceSnapshot(
  current: ScriptWorkspaceData,
  incoming: ScriptWorkspaceData,
  dirty: ScriptResourceFlags,
): ScriptWorkspaceData {
  return {
    ...incoming,
    plan: dirty.plan ? current.plan : incoming.plan,
    outline: dirty.outline ? current.outline : incoming.outline,
    characters: dirty.characters ? current.characters : incoming.characters,
    world: dirty.world ? current.world : incoming.world,
  };
}

const POLLING_JOB_STATUSES = new Set<ScriptAgentJobSnapshot['status']>([
  'queued',
  'running',
  'retrying',
]);

const BLOCKING_JOB_STATUSES = new Set<ScriptAgentJobSnapshot['status']>([
  ...POLLING_JOB_STATUSES,
  'waiting_user',
]);

function summarizeEpisode(episode: ScriptEpisode): ScriptEpisodeSummary {
  const visibleChars = episode.scenes.reduce(
    (total, scene) => total + scene.blocks.reduce(
      (sceneTotal, block) => sceneTotal + block.text.replace(/\s/gu, '').length,
      0,
    ),
    0,
  );
  return {
    id: episode.id,
    episodeNumber: episode.episodeNumber,
    title: episode.title,
    status: episode.status,
    targetChars: episode.targetChars,
    visibleChars,
    sceneCount: episode.scenes.length,
    revision: episode.revision,
    updatedAt: episode.updatedAt,
  };
}

function jobResourceSignature(jobs: ScriptAgentJobSnapshot[]): string {
  return jobs
    .map((job) => {
      const latestEvent = job.events?.at(-1);
      return [
        job.id,
        job.status,
        job.updatedAt ?? '',
        job.checkpoint?.episodeNumber ?? '',
        job.checkpoint?.node ?? '',
        job.checkpoint?.artifactRevision ?? '',
        latestEvent?.message ?? '',
        latestEvent?.current ?? '',
        latestEvent?.total ?? '',
      ].join(':');
    })
    .sort()
    .join('|');
}

function OutlineEditor({
  value,
  busy,
  onChange,
  onSave,
  onGenerate,
}: {
  value: ScriptSeriesOutline;
  busy: boolean;
  onChange: (value: ScriptSeriesOutline) => void;
  onSave: () => void;
  onGenerate: (regenerate?: boolean) => void;
}): JSX.Element {
  const [mode, setMode] = useState<'read' | 'edit'>(() => value.revision > 0 ? 'read' : 'edit');
  const patch = <K extends keyof ScriptSeriesOutline>(key: K, next: ScriptSeriesOutline[K]) =>
    onChange({ ...value, [key]: next });
  return (
    <section className="script-stage-panel" aria-labelledby="script-outline-heading">
      <header className="script-stage-heading"><div><span>第二阶段</span><h2 id="script-outline-heading">剧本大纲</h2></div><div className="script-stage-heading__actions"><div className="script-view-switch" role="group" aria-label="大纲查看模式"><button type="button" aria-pressed={mode === 'read'} onClick={() => setMode('read')}>阅读模式</button><button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>编辑模式</button></div><span className="script-status-chip">{value.episodeCards.length} 张分集卡</span></div></header>
      {mode === 'read' ? <ScriptOutlineReadView value={value} /> : <>
      <div className="script-form-grid">
        <label className="script-field script-field--wide">
          <span className="script-field-heading">
            <span>全剧梗概</span>
            <small className={value.synopsis.trim().length < 350 ? 'is-warning' : ''}>建议约 500 字 · 当前 {value.synopsis.trim().length} 字</small>
          </span>
          <textarea aria-label="全剧梗概" rows={12} value={value.synopsis} onChange={(e) => patch('synopsis', e.target.value)} />
        </label>
        <label className="script-field">开局状态<textarea value={value.openingState} onChange={(e) => patch('openingState', e.target.value)} /></label>
        <label className="script-field">中点转折<textarea value={value.midpointTurn} onChange={(e) => patch('midpointTurn', e.target.value)} /></label>
        <label className="script-field">高潮<textarea value={value.climax} onChange={(e) => patch('climax', e.target.value)} /></label>
        <label className="script-field">结局状态<textarea value={value.endingState} onChange={(e) => patch('endingState', e.target.value)} /></label>
        <label className="script-field script-field--wide">主线节拍（每行一条）<textarea rows={5} value={value.mainArc.join('\n')} onChange={(e) => patch('mainArc', e.target.value.split('\n').map((item) => item.trim()).filter(Boolean))} /></label>
        <label className="script-field script-field--wide">支线（每行一条）<textarea rows={4} value={value.subplotArcs.join('\n')} onChange={(e) => patch('subplotArcs', e.target.value.split('\n').map((item) => item.trim()).filter(Boolean))} /></label>
      </div>
      {value.episodeCards.length > 0 ? <div className="script-outline-cards"><h3>分集卡</h3>{value.episodeCards.map((card, index) => {
        const updateCard = (changes: Partial<typeof card>) => patch(
          'episodeCards',
          value.episodeCards.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item),
        );
        return <article className="script-outline-edit-card" key={card.episodeNumber}>
          <header className="script-outline-edit-card__heading">
            <strong>第 {card.episodeNumber} 集</strong>
            <span>分集卡</span>
          </header>
          <div className="script-outline-edit-card__fields">
            <label className="script-outline-edit-field">
              <span>标题</span>
              <input aria-label={`第 ${card.episodeNumber} 集标题`} value={card.title} onChange={(e) => updateCard({ title: e.target.value })} />
            </label>
            <label className="script-outline-edit-field">
              <span>本集梗概</span>
              <textarea rows={3} aria-label={`第 ${card.episodeNumber} 集梗概`} value={card.logline} onChange={(e) => updateCard({ logline: e.target.value })} />
            </label>
            <label className="script-outline-edit-field">
              <span>主要事件</span>
              <textarea rows={3} aria-label={`第 ${card.episodeNumber} 集主要事件`} value={card.mainEvent} onChange={(e) => updateCard({ mainEvent: e.target.value })} />
            </label>
            <label className="script-outline-edit-field">
              <span>结尾卡点</span>
              <textarea rows={3} aria-label={`第 ${card.episodeNumber} 集结尾卡点`} value={card.endingHook} onChange={(e) => updateCard({ endingHook: e.target.value })} />
            </label>
          </div>
        </article>;
      })}</div> : <p className="script-muted">保存策划后，可让 Agent 生成全剧总纲与连续分集卡。</p>}
      </>}
      <footer className="script-stage-actions"><button type="button" aria-label="Agent 生成大纲" className="nwa-button script-ai-skip" disabled={busy} onClick={() => onGenerate(false)}>跳过手填，AI 自动生成大纲</button>{value.revision > 0 || value.episodeCards.length > 0 ? <button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={() => onGenerate(true)}>AI 重新生成大纲</button> : null}<button type="button" className="nwa-button" disabled={busy} onClick={onSave}>{busy ? '保存中…' : '保存大纲'}</button></footer>
    </section>
  );
}

let fallbackCharacterId = 0;

function createCharacterId(projectId: Id, characters: readonly ScriptCharacter[]): Id {
  const existingIds = new Set(characters.map((character) => character.id));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const randomId = globalThis.crypto?.randomUUID?.();
    if (randomId) {
      const candidate = `${projectId}-character-${randomId}`;
      if (!existingIds.has(candidate)) return candidate;
    }
  }
  let candidate: string;
  do {
    fallbackCharacterId += 1;
    candidate = `${projectId}-character-local-${fallbackCharacterId}`;
  } while (existingIds.has(candidate));
  return candidate;
}

function emptyCharacter(projectId: Id, characters: readonly ScriptCharacter[]): ScriptCharacter {
  return {
    id: createCharacterId(projectId, characters),
    projectId,
    name: '',
    aliases: [],
    role: 'supporting',
    identity: '',
    biography: '',
    motivation: '',
    goal: '',
    weakness: '',
    arc: '',
    appearance: '',
    hairstyle: '',
    physique: '',
    defaultOutfit: '',
    personality: [],
    skills: [],
    speechStyle: '',
    catchphrases: [],
    relationships: [],
    revision: 0,
    updatedAt: new Date().toISOString(),
  };
}

function uniqueLines(value: string): string[] {
  return [...new Set(value.split('\n').map((item) => item.trim()).filter(Boolean))];
}

function CharacterLinesField({
  label,
  ariaLabel,
  value,
  wide = false,
  invalid = false,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  value: string[];
  wide?: boolean;
  invalid?: boolean;
  onChange: (value: string[]) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(() => value.join('\n'));
  useEffect(() => {
    const normalizedDraft = uniqueLines(draft).join('\n');
    const normalizedValue = value.join('\n');
    if (normalizedDraft !== normalizedValue) setDraft(normalizedValue);
  }, [draft, value]);
  return (
    <label className={`script-field${wide ? ' script-field--wide' : ''}`}>{label}<textarea
      aria-label={ariaLabel}
      aria-invalid={invalid}
      value={draft}
      onBlur={() => setDraft(value.join('\n'))}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(uniqueLines(event.target.value));
      }}
    /></label>
  );
}

interface CharacterValidationError {
  characterIndex: number;
  field: string;
  message: string;
}

const REQUIRED_CHARACTER_TEXT_FIELDS: Array<{
  field: keyof Pick<
    ScriptCharacter,
    | 'name'
    | 'identity'
    | 'biography'
    | 'motivation'
    | 'goal'
    | 'weakness'
    | 'arc'
    | 'appearance'
    | 'hairstyle'
    | 'physique'
    | 'defaultOutfit'
    | 'speechStyle'
  >;
  label: string;
}> = [
  { field: 'name', label: '姓名' },
  { field: 'identity', label: '人物身份' },
  { field: 'biography', label: '人物小传' },
  { field: 'motivation', label: '动机' },
  { field: 'goal', label: '目标' },
  { field: 'weakness', label: '弱点' },
  { field: 'arc', label: '人物弧光' },
  { field: 'appearance', label: '外貌' },
  { field: 'hairstyle', label: '发型' },
  { field: 'physique', label: '体格' },
  { field: 'defaultOutfit', label: '默认服装' },
  { field: 'speechStyle', label: '语言风格' },
];

function validateCharacters(value: ScriptCharacter[]): CharacterValidationError[] {
  const errors: CharacterValidationError[] = [];
  const characterIds = new Set(value.map((character) => character.id));
  value.forEach((character, characterIndex) => {
    REQUIRED_CHARACTER_TEXT_FIELDS.forEach(({ field, label }) => {
      if (!character[field].trim()) {
        errors.push({ characterIndex, field, message: `角色 ${characterIndex + 1} 缺少${label}` });
      }
    });
    if (character.personality.length === 0) {
      errors.push({ characterIndex, field: 'personality', message: `角色 ${characterIndex + 1} 至少需要一项性格` });
    }
    character.relationships.forEach((relationship, relationshipIndex) => {
      if (!relationship.characterId.trim()) {
        errors.push({
          characterIndex,
          field: `relationships.${relationshipIndex}.characterId`,
          message: `角色 ${characterIndex + 1} 的关系 ${relationshipIndex + 1} 缺少目标人物`,
        });
      } else if (relationship.characterId === character.id) {
        errors.push({
          characterIndex,
          field: `relationships.${relationshipIndex}.characterId`,
          message: `角色 ${characterIndex + 1} 的关系 ${relationshipIndex + 1} 不能指向自己`,
        });
      } else if (!characterIds.has(relationship.characterId)) {
        errors.push({
          characterIndex,
          field: `relationships.${relationshipIndex}.characterId`,
          message: `角色 ${characterIndex + 1} 的关系 ${relationshipIndex + 1} 指向不存在的人物`,
        });
      }
      if (!relationship.label.trim()) {
        errors.push({
          characterIndex,
          field: `relationships.${relationshipIndex}.label`,
          message: `角色 ${characterIndex + 1} 的关系 ${relationshipIndex + 1} 缺少关系标签`,
        });
      }
    });
  });
  return errors;
}

function CharacterEditor({
  projectId,
  value,
  busy,
  onChange,
  onSave,
  onGenerate,
}: {
  projectId: Id;
  value: ScriptCharacter[];
  busy: boolean;
  onChange: (value: ScriptCharacter[]) => void;
  onSave: () => void;
  onGenerate: (regenerate?: boolean) => void;
}): JSX.Element {
  const [mode, setMode] = useState<'read' | 'edit'>(() => value.length > 0 ? 'read' : 'edit');
  const [validationErrors, setValidationErrors] = useState<CharacterValidationError[]>([]);
  const update = (index: number, fields: Partial<ScriptCharacter>) => {
    setValidationErrors([]);
    onChange(value.map((item, itemIndex) => itemIndex === index ? { ...item, ...fields } : item));
  };
  const hasError = (characterIndex: number, field: string) => validationErrors.some((error) => (
    error.characterIndex === characterIndex && error.field === field
  ));
  const save = () => {
    const errors = validateCharacters(value);
    setValidationErrors(errors);
    if (errors.length === 0) onSave();
  };
  return (
    <section className="script-stage-panel" aria-labelledby="script-characters-heading">
      <header className="script-stage-heading"><div><span>第三阶段</span><h2 id="script-characters-heading">角色设定</h2></div><div className="script-stage-heading__actions"><div className="script-view-switch" role="group" aria-label="角色查看模式"><button type="button" aria-pressed={mode === 'read'} onClick={() => setMode('read')}>人物卡</button><button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>编辑模式</button></div><button type="button" aria-label="Agent 补全人物与世界" className="nwa-button script-ai-skip" disabled={busy} onClick={() => onGenerate(false)}>跳过手填，AI 自动补全人物</button>{value.length > 0 ? <button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={() => onGenerate(true)}>AI 重新生成人物与世界</button> : null}<button type="button" className="nwa-button nwa-button--ghost" onClick={() => { setValidationErrors([]); onChange([...value, emptyCharacter(projectId, value)]); }}>添加角色</button></div></header>
      {mode === 'read' ? <ScriptCharactersReadView value={value} /> : <>
      {validationErrors.length > 0 ? <div className="script-character-errors" role="alert"><strong>请补全人物卡后再保存</strong><ul>{validationErrors.map((error) => <li key={`${error.characterIndex}-${error.field}`}>{error.message}</li>)}</ul></div> : null}
      {value.length === 0 ? <p className="script-muted">尚无角色。可手动添加，或让 Agent 根据策划和总纲补全人物与世界圣经。</p> : <div className="script-character-list">{value.map((character, index) => (
        <article key={character.id} className="script-character-card">
          <header><strong>{character.name || `角色 ${index + 1}`}</strong><button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" onClick={() => { setValidationErrors([]); onChange(value.filter((_, itemIndex) => itemIndex !== index)); }}>删除</button></header>
          <div className="script-form-grid">
            <label className="script-field">姓名<input aria-label={`角色姓名 ${index + 1}`} aria-invalid={hasError(index, 'name')} value={character.name} onChange={(e) => update(index, { name: e.target.value })} /></label>
            <label className="script-field">定位<select value={character.role} onChange={(e) => update(index, { role: e.target.value as ScriptCharacter['role'] })}><option value="lead">主角</option><option value="supporting">配角</option><option value="antagonist">反派</option><option value="minor">次要角色</option></select></label>
            <label className="script-field">年龄<input type="number" min={0} max={150} value={character.age ?? ''} onChange={(e) => update(index, { age: e.target.value ? Number(e.target.value) : undefined })} /></label>
            <label className="script-field">职业<input value={character.occupation ?? ''} onChange={(e) => update(index, { occupation: e.target.value })} /></label>
            <CharacterLinesField label="别名（每行一项）" ariaLabel={`角色别名 ${index + 1}`} value={character.aliases} wide onChange={(aliases) => update(index, { aliases })} />
            <label className="script-field">人物身份<textarea aria-label={`角色身份 ${index + 1}`} aria-invalid={hasError(index, 'identity')} value={character.identity} onChange={(e) => update(index, { identity: e.target.value })} /></label>
            <label className="script-field">人物小传<textarea aria-label={`角色小传 ${index + 1}`} aria-invalid={hasError(index, 'biography')} value={character.biography} onChange={(e) => update(index, { biography: e.target.value })} /></label>
            <label className="script-field">动机<textarea aria-label={`角色动机 ${index + 1}`} aria-invalid={hasError(index, 'motivation')} value={character.motivation} onChange={(e) => update(index, { motivation: e.target.value })} /></label>
            <label className="script-field">目标<textarea aria-label={`角色目标 ${index + 1}`} aria-invalid={hasError(index, 'goal')} value={character.goal} onChange={(e) => update(index, { goal: e.target.value })} /></label>
            <label className="script-field">弱点<textarea aria-label={`角色弱点 ${index + 1}`} aria-invalid={hasError(index, 'weakness')} value={character.weakness} onChange={(e) => update(index, { weakness: e.target.value })} /></label>
            <label className="script-field">人物弧光<textarea aria-label={`角色弧光 ${index + 1}`} aria-invalid={hasError(index, 'arc')} value={character.arc} onChange={(e) => update(index, { arc: e.target.value })} /></label>
            <label className="script-field">外貌<textarea aria-label={`角色外貌 ${index + 1}`} aria-invalid={hasError(index, 'appearance')} value={character.appearance} onChange={(e) => update(index, { appearance: e.target.value })} /></label>
            <label className="script-field">发型<textarea aria-label={`角色发型 ${index + 1}`} aria-invalid={hasError(index, 'hairstyle')} value={character.hairstyle} onChange={(e) => update(index, { hairstyle: e.target.value })} /></label>
            <label className="script-field">体格<textarea aria-label={`角色体格 ${index + 1}`} aria-invalid={hasError(index, 'physique')} value={character.physique} onChange={(e) => update(index, { physique: e.target.value })} /></label>
            <label className="script-field">默认服装<textarea aria-label={`角色服装 ${index + 1}`} aria-invalid={hasError(index, 'defaultOutfit')} value={character.defaultOutfit} onChange={(e) => update(index, { defaultOutfit: e.target.value })} /></label>
            <CharacterLinesField label="性格（每行一项）" ariaLabel={`角色性格 ${index + 1}`} value={character.personality} invalid={hasError(index, 'personality')} onChange={(personality) => update(index, { personality })} />
            <CharacterLinesField label="技能（每行一项）" ariaLabel={`角色技能 ${index + 1}`} value={character.skills} onChange={(skills) => update(index, { skills })} />
            <label className="script-field">语言风格<textarea aria-label={`角色语言风格 ${index + 1}`} aria-invalid={hasError(index, 'speechStyle')} value={character.speechStyle} onChange={(e) => update(index, { speechStyle: e.target.value })} /></label>
            <CharacterLinesField label="口头禅（每行一项）" ariaLabel={`角色口头禅 ${index + 1}`} value={character.catchphrases} onChange={(catchphrases) => update(index, { catchphrases })} />
          </div>
          <section className="script-character-relationships" aria-label={`角色关系 ${index + 1}`}>
            <header><strong>人物关系</strong><button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" onClick={() => update(index, { relationships: [...character.relationships, { characterId: '', label: '' }] })}>添加关系</button></header>
            {character.relationships.length === 0 ? <p className="script-muted">暂无人物关系。</p> : character.relationships.map((relationship, relationshipIndex) => {
              const knownTarget = value.some((candidate) => candidate.id === relationship.characterId && candidate.id !== character.id);
              return (
                <div className="script-character-relationship" key={`${relationship.characterId}-${relationshipIndex}`}>
                  <label className="script-field">目标人物<select aria-label={`角色关系目标 ${index + 1}-${relationshipIndex + 1}`} aria-invalid={hasError(index, `relationships.${relationshipIndex}.characterId`)} value={relationship.characterId} onChange={(event) => update(index, { relationships: character.relationships.map((item, itemIndex) => itemIndex === relationshipIndex ? { ...item, characterId: event.target.value } : item) })}><option value="">请选择人物</option>{!knownTarget && relationship.characterId ? <option value={relationship.characterId}>{relationship.characterId}</option> : null}{value.filter((candidate) => candidate.id !== character.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name || candidate.id}</option>)}</select></label>
                  <label className="script-field">关系标签<input aria-label={`角色关系标签 ${index + 1}-${relationshipIndex + 1}`} aria-invalid={hasError(index, `relationships.${relationshipIndex}.label`)} value={relationship.label} onChange={(event) => update(index, { relationships: character.relationships.map((item, itemIndex) => itemIndex === relationshipIndex ? { ...item, label: event.target.value } : item) })} /></label>
                  <label className="script-field">备注<input aria-label={`角色关系备注 ${index + 1}-${relationshipIndex + 1}`} value={relationship.notes ?? ''} onChange={(event) => update(index, { relationships: character.relationships.map((item, itemIndex) => itemIndex === relationshipIndex ? { ...item, notes: event.target.value } : item) })} /></label>
                  <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" onClick={() => update(index, { relationships: character.relationships.filter((_, itemIndex) => itemIndex !== relationshipIndex) })}>删除关系</button>
                </div>
              );
            })}
          </section>
        </article>
      ))}</div>}
      </>}
      <footer className="script-stage-actions"><button type="button" className="nwa-button" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存角色设定'}</button></footer>
    </section>
  );
}

function WorldEditor({
  value,
  busy,
  onChange,
  onSave,
  onGenerate,
}: {
  value: ScriptWorldBible;
  busy: boolean;
  onChange: (value: ScriptWorldBible) => void;
  onSave: () => void;
  onGenerate: (regenerate?: boolean) => void;
}): JSX.Element {
  const [mode, setMode] = useState<'read' | 'edit'>(() => value.revision > 0 ? 'read' : 'edit');
  const patch = <K extends keyof ScriptWorldBible>(key: K, next: ScriptWorldBible[K]) =>
    onChange({ ...value, [key]: next });
  const lines = (text: string) => text.split('\n').map((item) => item.trim()).filter(Boolean);
  return (
    <section className="script-stage-panel" aria-labelledby="script-world-heading">
      <header className="script-stage-heading"><div><span>第四阶段</span><h2 id="script-world-heading">世界设定</h2></div><div className="script-stage-heading__actions"><div className="script-view-switch" role="group" aria-label="世界设定查看模式"><button type="button" aria-pressed={mode === 'read'} onClick={() => setMode('read')}>阅读模式</button><button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>编辑模式</button></div><button type="button" aria-label="Agent 补全人物与世界" className="nwa-button script-ai-skip" disabled={busy} onClick={() => onGenerate(false)}>跳过手填，AI 自动补全世界</button>{value.revision > 0 ? <button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={() => onGenerate(true)}>AI 重新生成人物与世界</button> : null}<span className="script-status-chip">版本 {value.revision}</span></div></header>
      {mode === 'read' ? <ScriptWorldReadView value={value} /> : <>
      <div className="script-form-grid">
        <label className="script-field">时代<input aria-label="时代" value={value.era} onChange={(e) => patch('era', e.target.value)} /></label>
        <label className="script-field">主要地点（每行一项）<textarea value={value.primaryLocations.join('\n')} onChange={(e) => patch('primaryLocations', lines(e.target.value))} /></label>
        <label className="script-field script-field--wide">世界状态<textarea rows={5} value={value.worldState} onChange={(e) => patch('worldState', e.target.value)} /></label>
        <label className="script-field">世界规则（每行一项）<textarea rows={5} value={value.rules.join('\n')} onChange={(e) => patch('rules', lines(e.target.value))} /></label>
        <label className="script-field">组织（每行一项）<textarea rows={5} value={value.organizations.join('\n')} onChange={(e) => patch('organizations', lines(e.target.value))} /></label>
        <label className="script-field">交通手段<textarea value={value.transport.join('\n')} onChange={(e) => patch('transport', lines(e.target.value))} /></label>
        <label className="script-field">通信手段<textarea value={value.communication.join('\n')} onChange={(e) => patch('communication', lines(e.target.value))} /></label>
        <label className="script-field">关键道具<textarea value={value.recurringProps.join('\n')} onChange={(e) => patch('recurringProps', lines(e.target.value))} /></label>
        <label className="script-field">禁止的时代错误<textarea value={value.forbiddenAnachronisms.join('\n')} onChange={(e) => patch('forbiddenAnachronisms', lines(e.target.value))} /></label>
      </div>
      </>}
      <footer className="script-stage-actions"><button type="button" className="nwa-button" disabled={busy} onClick={onSave}>{busy ? '保存中…' : '保存世界设定'}</button></footer>
    </section>
  );
}

const JOB_STATUS_LABEL: Record<ScriptAgentJobSnapshot['status'], string> = {
  queued: '排队中',
  running: '运行中',
  waiting_user: '等待确认',
  retrying: '重试中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const JOB_TASK_LABEL: Record<ScriptAgentJobSnapshot['task'], string> = {
  script_plan: '剧本策划',
  script_series_outline: '剧本大纲',
  script_bible: '人物与世界',
  script_episode_batch: '分批正文',
};

function jobDisplayLabel(job: ScriptAgentJobSnapshot): string {
  if (job.task !== 'script_episode_batch' || !job.scriptBatchOptions) return JOB_TASK_LABEL[job.task];
  const start = job.scriptBatchOptions.startEpisode;
  const end = start + job.scriptBatchOptions.episodeCount - 1;
  return `第 ${start}–${end} 集正文`;
}

function TaskRecordPanel({
  mode,
  jobs,
  busy,
  loading,
  onClose,
  onTrash,
  onRestore,
  onDeletePermanently,
}: {
  mode: 'history' | 'trash';
  jobs: ScriptAgentJobSnapshot[];
  busy: boolean;
  loading: boolean;
  onClose: () => void;
  onTrash: (jobId: string) => void;
  onRestore: (jobId: string) => void;
  onDeletePermanently: (jobId: string) => void;
}): JSX.Element {
  const isTrash = mode === 'trash';
  return (
    <section className="script-task-records" aria-label={isTrash ? '任务回收站' : '任务记录'}>
      <header>
        <div>
          <span>{isTrash ? '删除保护' : '后台任务'}</span>
          <h2>{isTrash ? '任务回收站' : '任务记录'}</h2>
          <p>{isTrash ? '恢复不会重新调用 AI；永久删除只删除任务记录，不删除已经生成的剧本。' : '已完成、失败或已取消的任务可以删除到回收站。正在运行的任务请先取消。'}</p>
        </div>
        <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" onClick={onClose}>关闭</button>
      </header>
      {loading ? <p className="script-muted">正在读取回收站…</p> : jobs.length === 0 ? (
        <p className="script-task-records__empty">{isTrash ? '回收站是空的。' : '当前项目还没有任务记录。'}</p>
      ) : (
        <div className="script-task-records__list">
          {jobs.map((job) => {
            const terminal = !BLOCKING_JOB_STATUSES.has(job.status);
            const updatedAt = job.updatedAt ? new Date(job.updatedAt) : undefined;
            const updatedLabel = updatedAt && !Number.isNaN(updatedAt.getTime())
              ? updatedAt.toLocaleString('zh-CN', { hour12: false })
              : '时间未知';
            return (
              <article key={job.id} className="script-task-record">
                <div>
                  <strong>{jobDisplayLabel(job)}</strong>
                  <span>{JOB_STATUS_LABEL[job.status]} · {isTrash ? '删除于' : '更新于'} {updatedLabel}</span>
                </div>
                <div className="script-task-record__actions">
                  {isTrash ? <>
                    <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy} onClick={() => onRestore(job.id)}>恢复</button>
                    <button type="button" className="nwa-button nwa-button--danger nwa-button--sm" disabled={busy} onClick={() => onDeletePermanently(job.id)}>永久删除</button>
                  </> : terminal ? (
                    <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy} onClick={() => onTrash(job.id)}>删除</button>
                  ) : <span>运行中不可删除</span>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

const CHECKPOINT_LABEL: Record<NonNullable<ScriptAgentJobSnapshot['checkpoint']>['node'], string> = {
  plan: '策划锁定',
  series_outline: '全剧大纲',
  character_bible: '人物圣经',
  world_bible: '世界圣经',
  episode_outline: '详细大纲',
  scene_plan: '场景计划',
  direct_draft: '照分集卡写作',
  continuation: '从结尾自然续写',
  handoff_review: '明显错误检查',
  direct_rewrite: '按明显问题重写',
  draft: '正文初稿',
  review: '连续性审查',
  revision: '定向修订',
  completed: '本集完成',
  batch_report: '批次报告',
};

function MaterialJobPanel({
  job,
  label,
  busy,
  onResume,
  onCancel,
}: {
  job: ScriptAgentJobSnapshot;
  label: string;
  busy: boolean;
  onResume: (jobId: string) => void;
  onCancel: (jobId: string) => void;
}): JSX.Element {
  const canCancel = BLOCKING_JOB_STATUSES.has(job.status);
  const latestEvent = job.events?.at(-1);
  const latestProgress = latestEvent?.current !== undefined && latestEvent.total !== undefined
    ? `，${latestEvent.current}/${latestEvent.total}`
    : '';
  const checkpoint = job.checkpoint
    ? CHECKPOINT_LABEL[job.checkpoint.node]
    : '等待第一个保存点';
  const updatedAt = job.updatedAt ? new Date(job.updatedAt) : undefined;
  const updatedLabel = updatedAt && !Number.isNaN(updatedAt.getTime())
    ? `最近更新 ${updatedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
    : '后台任务状态';
  return (
    <section className="script-material-job" aria-label={`${label}任务状态`}>
      <div className="script-material-job__body">
        <div className="script-job-card__status">
          <strong>{label}任务：{JOB_STATUS_LABEL[job.status]}</strong>
          <span>{updatedLabel}</span>
        </div>
        {latestEvent ? <p className="script-material-job__progress">{latestEvent.message}{latestProgress}</p> : null}
        <p>{checkpoint}</p>
        {job.error ? <p className="script-job-error">{job.error.message}</p> : null}
      </div>
      <div className="script-material-job__actions">
        {job.continuable ? <button type="button" className="nwa-button nwa-button--sm" disabled={busy} onClick={() => onResume(job.id)}>从检查点继续{label}任务</button> : null}
        {canCancel ? <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy} onClick={() => onCancel(job.id)}>取消{label}任务</button> : null}
      </div>
    </section>
  );
}

const REVIEW_SEVERITY_LABEL: Record<ScriptReviewIssue['severity'], string> = {
  hard: '硬性问题',
  soft: '软性问题',
  suggestion: '优化建议',
};

const REVIEW_STATUS_LABEL: Record<ScriptReviewIssue['status'], string> = {
  open: '待处理',
  fixed: '已修复',
  ignored: '已忽略',
};

function isBlockingReviewIssue(issue: ScriptReviewIssue): boolean {
  return issue.status === 'open' && issue.severity === 'hard' && issue.source !== 'ai';
}

function reviewSeverityLabel(issue: ScriptReviewIssue): string {
  return issue.source === 'ai' && issue.severity === 'hard'
    ? 'AI 重点建议'
    : REVIEW_SEVERITY_LABEL[issue.severity];
}

function fixedBatchStartForEpisode(episodeNumber: number): number {
  return Math.floor((Math.max(1, episodeNumber) - 1) / 5) * 5 + 1;
}

function jobBatchStart(job: ScriptAgentJobSnapshot): number | undefined {
  if (job.task !== 'script_episode_batch') return undefined;
  const episodeNumber = job.scriptBatchOptions?.startEpisode ?? job.checkpoint?.episodeNumber;
  return typeof episodeNumber === 'number' ? fixedBatchStartForEpisode(episodeNumber) : undefined;
}

function EpisodeBatchPanel({
  data,
  busy,
  batchStart,
  batchEpisodes,
  batchLoading,
  episode,
  episodeLoading,
  onStart,
  onResume,
  onCancel,
  onTrash,
  onOpenEpisode,
  onEpisodeChange,
  onSaveEpisode,
  onReviewEpisode,
  onReviewBatch,
  onReviewStatus,
  onExport,
}: {
  data: ScriptWorkspaceData;
  busy: boolean;
  batchStart: number;
  batchEpisodes: ScriptEpisode[];
  batchLoading: boolean;
  episode?: ScriptEpisode;
  episodeLoading: boolean;
  onStart: (startEpisode: number, episodeCount: number, regenerate?: boolean) => void;
  onResume: (jobId: string) => void;
  onCancel: (jobId: string) => void;
  onTrash: (jobId: string) => void;
  onOpenEpisode: (episodeNumber: number) => void;
  onEpisodeChange: (episode: ScriptEpisode) => void;
  onSaveEpisode: () => void;
  onReviewEpisode: (episodeNumber: number) => void;
  onReviewBatch: (episodeNumbers: number[]) => void;
  onReviewStatus: (issueId: Id, status: ScriptReviewStatus) => void;
  onExport: (format: 'txt' | 'md' | 'docx' | 'fountain', range?: ScriptExportRange) => void;
}): JSX.Element {
  const [exportScope, setExportScope] = useState<'all' | 'batch'>('all');
  const [contentMode, setContentMode] = useState<'read' | 'edit'>('read');
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fullscreen]);
  const fixedBatchStart = fixedBatchStartForEpisode(batchStart);
  const batchEnd = Math.min(fixedBatchStart + 4, data.plan.totalEpisodes);
  const batchCount = Math.max(0, batchEnd - fixedBatchStart + 1);
  const batchSummaries = data.episodes.filter((item) => item.episodeNumber >= fixedBatchStart && item.episodeNumber <= batchEnd);
  const completedBatchEpisodes = new Set(batchSummaries.filter((item) => item.status === 'completed').map((item) => item.episodeNumber));
  const batchCompleted = batchCount > 0 && Array.from({ length: batchCount }, (_, index) => fixedBatchStart + index)
    .every((episodeNumber) => completedBatchEpisodes.has(episodeNumber));
  const allCompletedEpisodes = new Set(
    data.episodes.filter((item) => item.status === 'completed').map((item) => item.episodeNumber),
  );
  const precedingEpisodesCompleted = fixedBatchStart === 1 || Array.from(
    { length: fixedBatchStart - 1 },
    (_, index) => index + 1,
  ).every((episodeNumber) => allCompletedEpisodes.has(episodeNumber));
  const continuableBatchJob = data.jobs.find((job) => (
    job.task === 'script_episode_batch' && job.continuable && jobBatchStart(job) === fixedBatchStart
  ));
  const visibleJobs = data.jobs.filter((job) => (
    job.task !== 'script_episode_batch' || jobBatchStart(job) === undefined || jobBatchStart(job) === fixedBatchStart
  ));
  const batchIssues = data.reviewIssues
    .filter((item) => item.episodeNumber >= fixedBatchStart && item.episodeNumber <= batchEnd)
    .sort((left, right) => {
      if (left.status === 'open' && right.status !== 'open') return -1;
      if (left.status !== 'open' && right.status === 'open') return 1;
      if (left.episodeNumber !== right.episodeNumber) return left.episodeNumber - right.episodeNumber;
      return left.createdAt.localeCompare(right.createdAt);
    });
  const unresolvedIssues = batchIssues.filter((item) => item.status === 'open');
  const unresolvedHardIssues = unresolvedIssues.filter(isBlockingReviewIssue).length;
  const referenceEpisode = episode?.episodeNumber ?? batchStart;
  const exportBatchStart = Math.floor((referenceEpisode - 1) / 5) * 5 + 1;
  const exportRange = exportScope === 'batch'
    ? { startEpisode: exportBatchStart, episodeCount: Math.min(5, data.plan.totalEpisodes - exportBatchStart + 1) }
    : undefined;
  return (
    <section className={`script-stage-panel script-episodes-panel${fullscreen ? ' is-fullscreen' : ''}`} aria-labelledby="script-episodes-heading">
      <header className="script-stage-heading">
        <div><span>第五阶段 · 五集一批</span><h2 id="script-episodes-heading">{fixedBatchStart}–{batchEnd}集剧本正文</h2></div>
        <div className="script-stage-heading__actions">
          <span className="script-status-chip" title="按分集卡直接写正文，只检查明显剧情和人物错误">Flash 直接写作</span>
          <div className="script-view-switch" role="group" aria-label="正文查看模式"><button type="button" aria-pressed={contentMode === 'read'} onClick={() => setContentMode('read')}>成品阅读</button><button type="button" aria-pressed={contentMode === 'edit'} onClick={() => setContentMode('edit')}>编辑模式</button></div>
          <button type="button" className="nwa-button nwa-button--ghost" onClick={() => setFullscreen((value) => !value)}>{fullscreen ? '退出全屏' : '全屏阅读'}</button>
          <select aria-label="导出范围" value={exportScope} onChange={(event) => setExportScope(event.target.value as 'all' | 'batch')}><option value="all">整本</option><option value="batch">当前五集</option></select>
          <button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={() => onExport('txt', exportRange)}>导出 TXT</button>
          <button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={() => onExport('md', exportRange)}>导出 MD</button>
          <button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={() => onExport('docx', exportRange)}>导出 DOCX</button>
          <button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={() => onExport('fountain', exportRange)}>导出 Fountain</button>
          {continuableBatchJob ? <><button type="button" className="nwa-button" disabled={busy} onClick={() => onResume(continuableBatchJob.id)}>继续第 {continuableBatchJob.checkpoint?.episodeNumber ?? fixedBatchStart} 集所在的 {fixedBatchStart}–{batchEnd} 集任务</button><button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={() => onStart(fixedBatchStart, batchCount, true)}>放弃错误结果，AI 重新写本批</button></>
            : batchCompleted ? <><span className="script-status-chip">本批已完成</span><button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={() => onStart(fixedBatchStart, batchCount, true)}>AI 重新写第 {fixedBatchStart}–{batchEnd} 集</button></>
              : !precedingEpisodesCompleted ? <span className="script-status-chip">请先完成第 1–{fixedBatchStart - 1} 集</span>
              : batchCount > 0 ? <button type="button" aria-label={`生成第 ${fixedBatchStart}–${batchEnd} 集`} className="nwa-button script-ai-skip" disabled={busy} onClick={() => onStart(fixedBatchStart, batchCount)}>跳过手写，AI 生成第 {fixedBatchStart}–{batchEnd} 集</button>
                : <span className="script-status-chip">全剧已完成</span>}
        </div>
      </header>
      <div className="script-production-grid">
        <div>
          <h3>分集进度</h3>
          {batchSummaries.length === 0 ? <p className="script-muted">本批尚未生成正文。每批最多 5 集，完成一集立即保存。</p> : (
            <ol className="script-episode-list">
              {batchSummaries.map((item) => <li key={item.episodeNumber}><button type="button" className="script-episode-open" aria-label={`打开第 ${item.episodeNumber} 集`} onClick={() => { setContentMode('edit'); onOpenEpisode(item.episodeNumber); }}>打开第 {item.episodeNumber} 集<span>{item.title}</span></button><span>{JOB_STATUS_LABEL[item.status === 'generating' || item.status === 'reviewing' ? 'running' : item.status === 'planned' ? 'queued' : item.status]} · {item.visibleChars} 字</span></li>)}
            </ol>
          )}
        </div>
        <aside className="script-job-panel" aria-label="生成任务">
          <h3>任务与检查点</h3>
          {visibleJobs.length === 0 ? <p className="script-muted">当前批次暂无后台任务。</p> : visibleJobs.map((job) => (
            <article className="script-job-card" key={job.id}>
              <div className="script-job-card__status"><strong>{JOB_STATUS_LABEL[job.status]}</strong><span>{job.task === 'script_episode_batch' ? '分批正文' : '资料生成'}</span></div>
              {job.events?.at(-1) ? <p className="script-material-job__progress">{job.events.at(-1)!.message}{job.events.at(-1)!.current !== undefined && job.events.at(-1)!.total !== undefined
                ? `，${job.events.at(-1)!.current}/${job.events.at(-1)!.total}`
                : ''}</p> : null}
              {job.checkpoint ? <p>{job.checkpoint.episodeNumber === undefined
                ? CHECKPOINT_LABEL[job.checkpoint.node]
                : `第 ${job.checkpoint.episodeNumber} 集 · ${CHECKPOINT_LABEL[job.checkpoint.node]}`}</p> : <p>等待首个检查点</p>}
              {job.error ? <p className="script-job-error">{job.error.message}</p> : null}
              {job.continuable ? <button type="button" className="nwa-button nwa-button--sm" disabled={busy} onClick={() => onResume(job.id)}>从检查点继续</button> : null}
              {BLOCKING_JOB_STATUSES.has(job.status) ? <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy} onClick={() => onCancel(job.id)}>取消任务</button> : null}
              {!BLOCKING_JOB_STATUSES.has(job.status) ? <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy} onClick={() => onTrash(job.id)}>删除</button> : null}
            </article>
          ))}
        </aside>
      </div>
      <section className="script-proofread-panel" aria-labelledby="script-proofread-heading">
        <header>
          <div>
            <span>质量门</span>
            <h3 id="script-proofread-heading">校稿与连续性检查</h3>
            <p>AI也可能会走神，请注意校稿。规则检查或人工标注的硬性问题会阻止完成；AI 判断默认作为建议展示。</p>
          </div>
          <div className="script-proofread-summary" aria-label="校稿问题统计">
            <span className={unresolvedHardIssues > 0 ? 'is-danger' : ''}>{unresolvedHardIssues} 个硬性</span>
            <span>{unresolvedIssues.length - unresolvedHardIssues} 个待优化</span>
            {unresolvedIssues.length > 0 ? <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy} onClick={() => onStart(fixedBatchStart, batchCount, true)}>有错误，AI 重新写本批</button> : null}
          </div>
        </header>
        {batchSummaries.length > 0 ? (
          <div className="script-proofread-actions" aria-label="运行单集校稿">
            <button type="button" className="nwa-button script-ai-skip" disabled={busy} onClick={() => onReviewBatch(batchSummaries.map((item) => item.episodeNumber))}>
              AI 校稿当前五集
            </button>
            {batchSummaries.map((item) => (
              <button key={item.episodeNumber} type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy} onClick={() => onReviewEpisode(item.episodeNumber)}>
                校稿第 {item.episodeNumber} 集
              </button>
            ))}
          </div>
        ) : <p className="script-muted">正文生成后，可在这里逐集运行格式、人物、伏笔和连续性检查。</p>}
        {batchIssues.length > 0 ? (
          <div className="script-proofread-list">
            {batchIssues.map((issue) => (
              <article key={issue.id} className={`script-proofread-issue is-${issue.source === 'ai' && issue.severity === 'hard' ? 'suggestion' : issue.severity} is-${issue.status}`}>
                <header>
                  <div><strong>第 {issue.episodeNumber} 集 · {reviewSeverityLabel(issue)}</strong><span>{issue.category} · {issue.source === 'deterministic' ? '规则检查' : issue.source === 'ai' ? 'AI 审读' : '人工标注'}</span></div>
                  <span>{REVIEW_STATUS_LABEL[issue.status]}</span>
                </header>
                <p>{issue.message}</p>
                {issue.suggestion ? <p className="script-proofread-suggestion">建议：{issue.suggestion}</p> : null}
                <footer>
                  {issue.status === 'open' ? <>
                    <button type="button" className="nwa-button nwa-button--sm" disabled={busy} onClick={() => onReviewStatus(issue.id, 'fixed')}>标记已修复</button>
                    {!isBlockingReviewIssue(issue)
                      ? <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy} onClick={() => onReviewStatus(issue.id, 'ignored')}>忽略</button>
                      : <span className="script-proofread-required">硬性问题不可忽略</span>}
                  </> : <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy} onClick={() => onReviewStatus(issue.id, 'open')}>重新打开</button>}
                </footer>
              </article>
            ))}
          </div>
        ) : <div className="script-proofread-empty">当前批次暂无校稿问题。建议在正文修改后重新运行单集校稿。</div>}
      </section>
      {episodeLoading ? <div className="script-loading script-loading--compact" role="status">正在加载单集正文…</div> : null}
      {contentMode === 'read' ? <ScriptEpisodeReader episodes={batchEpisodes} summaries={data.episodes} characters={data.characters} batchStart={fixedBatchStart} batchEnd={batchEnd} loading={batchLoading} onEditEpisode={(episodeNumber) => { setContentMode('edit'); onOpenEpisode(episodeNumber); }} /> : null}
      {contentMode === 'edit' && !episode ? <div className="script-editor-empty"><strong>请选择要编辑的单集</strong><span>从上方分集进度中打开一集，或切回“成品阅读”连续查看本批正文。</span></div> : null}
      {contentMode === 'edit' && episode ? (
        <section className="script-episode-editor" aria-label={`第 ${episode.episodeNumber} 集编辑器`}>
          <header>
            <div><span>第 {episode.episodeNumber} 集</span><input aria-label={`第 ${episode.episodeNumber} 集标题`} value={episode.title} onChange={(event) => onEpisodeChange({ ...episode, title: event.target.value })} /></div>
            <button type="button" className="nwa-button" disabled={busy} onClick={onSaveEpisode}>保存第 {episode.episodeNumber} 集</button>
          </header>
          {episode.scenes.map((scene, sceneIndex) => (
            <article className="script-scene-editor" key={scene.id}>
              <div className="script-scene-editor__heading">
                <strong>{episode.episodeNumber}-{scene.ordinal}</strong>
                <input aria-label={`第 ${episode.episodeNumber} 集场景 ${scene.ordinal} 地点`} value={scene.location} onChange={(event) => onEpisodeChange({ ...episode, scenes: episode.scenes.map((item, index) => index === sceneIndex ? { ...item, location: event.target.value } : item) })} />
                <select aria-label={`第 ${episode.episodeNumber} 集场景 ${scene.ordinal} 时间`} value={scene.timeOfDay} onChange={(event) => onEpisodeChange({ ...episode, scenes: episode.scenes.map((item, index) => index === sceneIndex ? { ...item, timeOfDay: event.target.value as typeof scene.timeOfDay } : item) })}><option value="day">日</option><option value="night">夜</option><option value="dawn">清晨</option><option value="dusk">黄昏</option></select>
                <select aria-label={`第 ${episode.episodeNumber} 集场景 ${scene.ordinal} 内外景`} value={scene.interiorExterior} onChange={(event) => onEpisodeChange({ ...episode, scenes: episode.scenes.map((item, index) => index === sceneIndex ? { ...item, interiorExterior: event.target.value as typeof scene.interiorExterior } : item) })}><option value="interior">内</option><option value="exterior">外</option></select>
              </div>
              <div className="script-block-list">
                {scene.blocks.map((block, blockIndex) => (
                  <label className="script-block-editor" key={block.id}>
                    <span>{block.type === 'caption' ? '字幕' : block.type === 'action' ? '动作' : `${block.speaker}${block.delivery ? `（${block.delivery}）` : ''}`}</span>
                    <textarea
                      aria-label={`第 ${episode.episodeNumber} 集场景 ${scene.ordinal} 块 ${blockIndex + 1}`}
                      value={block.text}
                      onChange={(event) => onEpisodeChange({
                        ...episode,
                        scenes: episode.scenes.map((item, index) => index === sceneIndex
                          ? { ...item, blocks: item.blocks.map((part, partIndex) => partIndex === blockIndex ? { ...part, text: event.target.value } : part) }
                          : item),
                      })}
                    />
                  </label>
                ))}
              </div>
            </article>
          ))}
        </section>
      ) : null}
    </section>
  );
}

export function ScriptWorkspace({
  projectId,
  projectName,
  onError,
  onErrorClear,
  client = apiClient,
}: ScriptWorkspaceProps): JSX.Element {
  const [stage, setStage] = useState<ScriptStage>('plan');
  const [data, setData] = useState<ScriptWorkspaceData | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [selectedEpisode, setSelectedEpisode] = useState<ScriptEpisode>();
  const [episodeLoading, setEpisodeLoading] = useState(false);
  const [selectedBatchStart, setSelectedBatchStart] = useState(1);
  const [batchEpisodes, setBatchEpisodes] = useState<ScriptEpisode[]>([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [conceptPrompt, setConceptPrompt] = useState('');
  const [concepts, setConcepts] = useState<ScriptConceptProposal[]>([]);
  const [conceptBusy, setConceptBusy] = useState(false);
  const [planQuestions, setPlanQuestions] = useState<ScriptPlanQuestion[]>([]);
  const [planAnswers, setPlanAnswers] = useState<Record<string, ScriptPlanAnswer>>({});
  const [taskRecordMode, setTaskRecordMode] = useState<'history' | 'trash'>();
  const [trashJobs, setTrashJobs] = useState<ScriptAgentJobSnapshot[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const episodeRequest = useRef<AbortController>();
  const batchRequest = useRef<AbortController>();
  const jobSignature = useRef('');
  const pollErrorReported = useRef(false);
  const pollErrorId = useRef<string>();
  const projectNameRef = useRef(projectName);
  const dirtyResources = useRef<ScriptResourceFlags>(cleanResourceFlags());
  const resourceEditVersions = useRef<ScriptResourceVersions>(cleanResourceVersions());
  const stageRef = useRef<ScriptStage>('plan');
  const selectedBatchStartRef = useRef(1);
  const selectedEpisodeRef = useRef<ScriptEpisode>();
  const selectedEpisodeDirty = useRef(false);
  const selectedEpisodeEditVersion = useRef(0);

  // A rename only changes the project's display metadata. Keep the newest
  // value available to async loads without treating it as a workspace switch,
  // which would otherwise discard unsaved screenplay edits.
  projectNameRef.current = projectName;

  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  useEffect(() => {
    const controller = new AbortController();
    setStage('plan');
    setData(null);
    setNotice('');
    setSelectedEpisode(undefined);
    setEpisodeLoading(false);
    setSelectedBatchStart(1);
    setBatchEpisodes([]);
    setBatchLoading(false);
    setConceptPrompt('');
    setConcepts([]);
    setConceptBusy(false);
    setPlanQuestions([]);
    setPlanAnswers({});
    setTaskRecordMode(undefined);
    setTrashJobs([]);
    setTrashLoading(false);
    episodeRequest.current?.abort();
    batchRequest.current?.abort();
    jobSignature.current = '';
    pollErrorReported.current = false;
    pollErrorId.current = undefined;
    dirtyResources.current = cleanResourceFlags();
    resourceEditVersions.current = cleanResourceVersions();
    stageRef.current = 'plan';
    selectedBatchStartRef.current = 1;
    selectedEpisodeRef.current = undefined;
    selectedEpisodeDirty.current = false;
    selectedEpisodeEditVersion.current = 0;
    void (async () => {
      try {
        const jobs = await client.script.jobs.list(projectId, controller.signal);
        if (controller.signal.aborted) return;
        const workspaceRequest = client.script.workspace?.get;
        if (workspaceRequest) {
          try {
            const snapshot = await workspaceRequest(projectId, controller.signal);
            if (controller.signal.aborted) return;
            jobSignature.current = jobResourceSignature(jobs);
            setData(fromWorkspaceSnapshot(snapshot, jobs, projectId, projectNameRef.current));
            return;
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        }

        // Backward-compatible fallback for an older backend during rolling deploys.
        const [plan, characters, world, outline, episodes] = await Promise.all([
          optional(client.script.plan.get(projectId, controller.signal)),
          client.script.characters.list(projectId, controller.signal),
          optional(client.script.world.get(projectId, controller.signal)),
          optional(client.script.outline.get(projectId, controller.signal)),
          client.script.episodes.list(projectId, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        jobSignature.current = jobResourceSignature(jobs);
        setData({
          plan: plan ?? emptyPlan(projectId, projectNameRef.current),
          characters,
          world,
          outline,
          episodes,
          jobs,
          batchSummaries: [],
          reviewRevision: 0,
          reviewIssues: [],
        });
      } catch (error) {
        if (!controller.signal.aborted) onError?.(error);
      }
    })();
    return () => {
      controller.abort();
      episodeRequest.current?.abort();
      batchRequest.current?.abort();
    };
  }, [client, onError, projectId]);

  const hasPollingJobs = data?.jobs.some((job) => POLLING_JOB_STATUSES.has(job.status)) ?? false;

  useEffect(() => {
    if (!hasPollingJobs) return undefined;
    const controller = new AbortController();
    let inFlight = false;
    const poll = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const jobs = await client.script.jobs.list(projectId, controller.signal);
        if (controller.signal.aborted) return;
        const nextSignature = jobResourceSignature(jobs);
        const resourcesChanged = nextSignature !== jobSignature.current;
        if (resourcesChanged && client.script.workspace?.get) {
          // Do not keep showing a stale queued card while the larger workspace
          // snapshot and open episode bodies are being synchronized. Terminal
          // states still wait for that synchronization so the UI never claims
          // completion before the generated body is available.
          if (jobs.some((job) => POLLING_JOB_STATUSES.has(job.status))) {
            setData((current) => current ? { ...current, jobs } : current);
          }
          const snapshot = await client.script.workspace.get(projectId, controller.signal);
          if (controller.signal.aborted) return;

          let refreshedBatch: ScriptEpisode[] | undefined;
          const batchStart = selectedBatchStartRef.current;
          if (stageRef.current === 'episodes') {
            const batchEnd = Math.min(batchStart + 4, snapshot.plan?.totalEpisodes ?? batchStart + 4);
            const episodeNumbers = snapshot.episodeSummaries
              .filter((item) => item.episodeNumber >= batchStart && item.episodeNumber <= batchEnd)
              .map((item) => item.episodeNumber);
            refreshedBatch = await Promise.all(
              episodeNumbers.map((episodeNumber) => (
                client.script.episodes.get(projectId, episodeNumber, controller.signal)
              )),
            );
            if (controller.signal.aborted) return;
          }

          jobSignature.current = nextSignature;
          const incoming = fromWorkspaceSnapshot(snapshot, jobs, projectId, projectNameRef.current);
          setData((current) => current
            ? mergeWorkspaceSnapshot(current, incoming, dirtyResources.current)
            : incoming);

          if (
            refreshedBatch !== undefined &&
            stageRef.current === 'episodes' &&
            selectedBatchStartRef.current === batchStart
          ) {
            const dirtyEpisode = selectedEpisodeDirty.current ? selectedEpisodeRef.current : undefined;
            const mergedBatch = refreshedBatch
              .map((episode) => episode.episodeNumber === dirtyEpisode?.episodeNumber ? dirtyEpisode : episode)
              .sort((left, right) => left.episodeNumber - right.episodeNumber);
            setBatchEpisodes(mergedBatch);
            const currentSelection = selectedEpisodeRef.current;
            if (currentSelection && !selectedEpisodeDirty.current) {
              const refreshedSelection = mergedBatch.find(
                (episode) => episode.episodeNumber === currentSelection.episodeNumber,
              );
              if (refreshedSelection) {
                selectedEpisodeRef.current = refreshedSelection;
                setSelectedEpisode(refreshedSelection);
              }
            }
          }
        } else if (!controller.signal.aborted) {
          jobSignature.current = nextSignature;
          setData((current) => current ? { ...current, jobs } : current);
        }

        if (pollErrorReported.current) {
          if (pollErrorId.current !== undefined) onErrorClear?.(pollErrorId.current);
          pollErrorId.current = undefined;
          pollErrorReported.current = false;
        }
      } catch (error) {
        if (!controller.signal.aborted && !pollErrorReported.current) {
          pollErrorReported.current = true;
          const errorId = onError?.(error);
          if (typeof errorId === 'string') pollErrorId.current = errorId;
        }
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(poll, 2_000);
    return () => {
      controller.abort();
      clearInterval(timer);
      if (pollErrorId.current !== undefined) onErrorClear?.(pollErrorId.current);
      pollErrorId.current = undefined;
      pollErrorReported.current = false;
    };
  }, [client, hasPollingJobs, onError, onErrorClear, projectId]);

  const markResourceDirty = useCallback((resource: EditableScriptResource) => {
    dirtyResources.current[resource] = true;
    resourceEditVersions.current[resource] += 1;
  }, []);

  const applyPlanTurn = useCallback((
    result: Awaited<ReturnType<ApiClient['script']['plan']['turn']>>,
    requestEditVersion: number,
  ) => {
    if (resourceEditVersions.current.plan !== requestEditVersion) {
      if (result.status === 'ready' && result.plan) {
        setData((current) => current ? {
          ...current,
          plan: {
            ...current.plan,
            status: result.plan!.status,
            revision: result.plan!.revision,
            updatedAt: result.plan!.updatedAt,
          },
        } : current);
      }
      setPlanQuestions([]);
      setPlanAnswers({});
      setNotice('策划已修改，已保留本地内容，请保存后重新发起 Agent 策划');
      return;
    }
    if (result.status === 'asking') {
      setPlanQuestions(result.questions ?? []);
      setPlanAnswers({});
      setNotice(`策划 Agent 第 ${result.round} 轮需要确认 ${result.questions?.length ?? 0} 项`);
      return;
    }
    if (result.plan) {
      dirtyResources.current.plan = false;
      setData((current) => current ? { ...current, plan: result.plan! } : current);
      setPlanQuestions([]);
      setPlanAnswers({});
      setNotice('Agent 已生成策划草稿，请检查后确认');
    }
  }, []);

  const generateConcepts = useCallback(async () => {
    if (!data) return;
    setConceptBusy(true);
    setNotice('');
    try {
      const fallbackPrompt = [data.plan.title, data.plan.logline, data.plan.coreRequirements]
        .map((item) => item.trim()).filter(Boolean).join('\n');
      const result = await client.script.plan.concepts(projectId, conceptPrompt.trim() || fallbackPrompt);
      setConcepts(result.proposals);
      setNotice(`AI 已生成 ${result.proposals.length} 个选题方向，采用前不会覆盖当前策划`);
    } catch (error) {
      onError?.(error);
    } finally {
      setConceptBusy(false);
    }
  }, [client, conceptPrompt, data, onError, projectId]);

  const adoptConcept = useCallback((concept: ScriptConceptProposal) => {
    markResourceDirty('plan');
    setData((current) => {
      if (!current) return current;
      const mainArcHint = `主线提示：${concept.mainArc}`;
      const existingRequirements = current.plan.coreRequirements
        .split('\n')
        .map((item) => item.trim())
        .filter((item) => item && !item.startsWith('主线提示：'));
      const coreRequirements = [...existingRequirements, mainArcHint].join('\n');
      return {
        ...current,
        plan: {
          ...current.plan,
          title: concept.title,
          theme: concept.theme,
          market: concept.market,
          channel: concept.channel,
          genres: concept.genres,
          logline: concept.logline,
          audience: concept.audience,
          coreConflict: concept.coreConflict,
          highlights: concept.highlights,
          endingDirection: concept.endingDirection,
          coverPrompt: concept.coverPrompt,
          totalEpisodes: concept.totalEpisodes,
          coreRequirements,
        },
      };
    });
    setNotice(`已采用选题《${concept.title}》，请检查后保存策划`);
  }, [markResourceDirty]);

  const startPlanInterview = useCallback(async () => {
    if (!data) return;
    const editVersion = resourceEditVersions.current.plan;
    setBusy(true);
    setNotice('');
    try {
      const seedPrompt = [data.plan.title, data.plan.logline, data.plan.coreRequirements]
        .map((item) => item.trim()).filter(Boolean).join('\n');
      applyPlanTurn(await client.script.plan.turn({
        projectId,
        seedPrompt,
        answers: [],
        reset: true,
      }), editVersion);
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [applyPlanTurn, client, data, onError, projectId]);

  const autoCompletePlan = useCallback(async () => {
    if (!data) return;
    setBusy(true);
    setNotice('AI 正在自动补全策划，请稍候…');
    try {
      const seedPrompt = [
        conceptPrompt.trim(),
        `项目名称：${projectNameRef.current ?? ''}`,
        `当前草稿：${JSON.stringify({
          title: data.plan.title,
          theme: data.plan.theme,
          market: data.plan.market,
          channel: data.plan.channel,
          genres: data.plan.genres,
          audience: data.plan.audience,
          coreConflict: data.plan.coreConflict,
          logline: data.plan.logline,
          totalEpisodes: data.plan.totalEpisodes,
          targetCharsPerEpisode: data.plan.targetCharsPerEpisode,
          coreRequirements: data.plan.coreRequirements,
          endingDirection: data.plan.endingDirection,
        })}`,
      ].filter(Boolean).join('\n');
      let result = await client.script.plan.turn({
        projectId,
        seedPrompt,
        answers: [],
        reset: true,
      });
      for (let round = 0; result.status === 'asking' && round < 16; round += 1) {
        const questions = result.questions ?? [];
        if (questions.length === 0) throw new Error('AI 策划没有返回可委托的问题。');
        result = await client.script.plan.turn({
          projectId,
          answers: questions.map((question) => ({ field: question.field, delegate: true })),
        });
      }
      if (result.status !== 'ready' || !result.plan) {
        throw new Error('AI 策划尚未完成，请重试。');
      }
      const approved = result.plan.status === 'draft'
        ? await client.script.plan.approve(projectId, result.plan.revision)
        : result.plan;
      dirtyResources.current.plan = false;
      setData((current) => current ? { ...current, plan: approved } : current);
      setPlanQuestions([]);
      setPlanAnswers({});
      setNotice('AI 已自动完成并确认策划；你仍可点“编辑模式”修改，修改后记得保存');
    } catch (error) {
      setNotice('AI 自动策划未完成，请按错误提示处理后重试');
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, conceptPrompt, data, onError, projectId]);

  const submitPlanAnswers = useCallback(async () => {
    const incomplete = planQuestions.some((question) => {
      const answer = planAnswers[question.field];
      const value = answer?.value;
      return answer?.delegate !== true &&
        (value === undefined || value === '' || (Array.isArray(value) && value.length === 0));
    });
    if (incomplete) {
      setNotice('请回答本轮全部问题，或明确选择“交给 Agent”。');
      return;
    }
    const editVersion = resourceEditVersions.current.plan;
    setBusy(true);
    setNotice('');
    try {
      applyPlanTurn(await client.script.plan.turn({
        projectId,
        answers: planQuestions.map((question) => planAnswers[question.field]!),
      }), editVersion);
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [applyPlanTurn, client, onError, planAnswers, planQuestions, projectId]);

  const approvePlan = useCallback(async () => {
    if (!data) return;
    if (dirtyResources.current.plan) {
      setNotice('请先保存策划，再确认');
      return;
    }
    const editVersion = resourceEditVersions.current.plan;
    setBusy(true);
    setNotice('');
    try {
      const plan = await client.script.plan.approve(projectId, data.plan.revision);
      const unchangedWhileApproving = resourceEditVersions.current.plan === editVersion;
      setData((current) => current ? {
        ...current,
        plan: unchangedWhileApproving
          ? plan
          : {
              ...current.plan,
              status: plan.status,
              revision: plan.revision,
              updatedAt: plan.updatedAt,
            },
      } : current);
      setNotice(unchangedWhileApproving
        ? '策划已确认，可生成大纲、角色与世界设定'
        : '策划已确认，仍有未保存修改');
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, data, onError, projectId]);

  const savePlan = useCallback(async () => {
    if (!data) return;
    const editVersion = resourceEditVersions.current.plan;
    setBusy(true);
    setNotice('');
    try {
      const saved = await client.script.plan.save(projectId, data.plan, data.plan.revision);
      const unchangedWhileSaving = resourceEditVersions.current.plan === editVersion;
      if (unchangedWhileSaving) dirtyResources.current.plan = false;
      setData((current) => current ? {
        ...current,
        plan: unchangedWhileSaving
          ? saved
          : { ...current.plan, revision: saved.revision, updatedAt: saved.updatedAt },
      } : current);
      setNotice(unchangedWhileSaving ? '策划已保存' : '策划已保存，仍有未保存修改');
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, data, onError, projectId]);

  const saveOutline = useCallback(async () => {
    if (!data) return;
    const outline = data.outline ?? emptyOutline(projectId);
    const editVersion = resourceEditVersions.current.outline;
    setBusy(true);
    setNotice('');
    try {
      const saved = await client.script.outline.save(projectId, outline, outline.revision);
      const unchangedWhileSaving = resourceEditVersions.current.outline === editVersion;
      if (unchangedWhileSaving) dirtyResources.current.outline = false;
      setData((current) => current ? {
        ...current,
        outline: unchangedWhileSaving
          ? saved
          : { ...(current.outline ?? emptyOutline(projectId)), revision: saved.revision },
      } : current);
      setNotice(unchangedWhileSaving ? '大纲已保存' : '大纲已保存，仍有未保存修改');
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, data, onError, projectId]);

  const saveCharacters = useCallback(async () => {
    if (!data) return;
    const editVersion = resourceEditVersions.current.characters;
    setBusy(true);
    setNotice('');
    try {
      const revision = data.characters.reduce((max, item) => Math.max(max, item.revision), 0);
      const saved = await client.script.characters.save(projectId, data.characters, revision);
      const unchangedWhileSaving = resourceEditVersions.current.characters === editVersion;
      if (unchangedWhileSaving) dirtyResources.current.characters = false;
      setData((current) => current ? {
        ...current,
        characters: unchangedWhileSaving
          ? saved
          : current.characters.map((item) => {
              const persisted = saved.find((candidate) => candidate.id === item.id);
              return persisted ? { ...item, revision: persisted.revision, updatedAt: persisted.updatedAt } : item;
            }),
      } : current);
      setNotice(unchangedWhileSaving ? '角色设定已保存' : '角色设定已保存，仍有未保存修改');
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, data, onError, projectId]);

  const saveWorld = useCallback(async () => {
    if (!data) return;
    const world = data.world ?? emptyWorld(projectId);
    const editVersion = resourceEditVersions.current.world;
    setBusy(true);
    setNotice('');
    try {
      const saved = await client.script.world.save(projectId, world, world.revision);
      const unchangedWhileSaving = resourceEditVersions.current.world === editVersion;
      if (unchangedWhileSaving) dirtyResources.current.world = false;
      setData((current) => current ? {
        ...current,
        world: unchangedWhileSaving
          ? saved
          : { ...(current.world ?? emptyWorld(projectId)), revision: saved.revision, updatedAt: saved.updatedAt },
      } : current);
      setNotice(unchangedWhileSaving ? '世界设定已保存' : '世界设定已保存，仍有未保存修改');
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, data, onError, projectId]);

  const startEpisodeBatch = useCallback(async (
    startEpisode: number,
    episodeCount: number,
    regenerate = false,
  ) => {
    if (!data) return;
    const fixedBatchStart = fixedBatchStartForEpisode(startEpisode);
    const fixedBatchCount = Math.min(5, Math.max(0, data.plan.totalEpisodes - fixedBatchStart + 1));
    if (startEpisode !== fixedBatchStart || episodeCount !== fixedBatchCount) {
      setNotice(`正文只能按固定批次生成：第 ${fixedBatchStart}–${fixedBatchStart + fixedBatchCount - 1} 集`);
      return;
    }
    const unsavedResources = (Object.keys(dirtyResources.current) as EditableScriptResource[])
      .filter((resource) => dirtyResources.current[resource]);
    if (unsavedResources.length > 0) {
      setNotice(`请先保存${unsavedResources.map((resource) => SCRIPT_RESOURCE_LABEL[resource]).join('、')}，再生成正文`);
      return;
    }
    if (selectedEpisodeDirty.current) {
      setNotice('请先保存当前集');
      return;
    }
    const endEpisode = startEpisode + episodeCount - 1;
    const hasOverlappingBatch = data.jobs.some((job) => {
      if (job.task !== 'script_episode_batch' || !BLOCKING_JOB_STATUSES.has(job.status)) return false;
      const options = job.scriptBatchOptions;
      if (!options) return false;
      const jobEnd = options.startEpisode + options.episodeCount - 1;
      return options.startEpisode <= endEpisode && startEpisode <= jobEnd;
    });
    if (hasOverlappingBatch) {
      setNotice(`第 ${startEpisode}–${endEpisode} 集已有生成任务正在运行`);
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const job = await client.script.jobs.create({
        projectId,
        task: 'script_episode_batch',
        ...(regenerate ? { regenerate: true } : {}),
        scriptBatchOptions: {
          startEpisode,
          episodeCount,
          expectedPlanRevision: data.plan.revision,
          draftMode: 'direct_text',
        },
      });
      setData((current) => current ? { ...current, jobs: [job, ...current.jobs.filter((item) => item.id !== job.id)] } : current);
      setNotice(`已提交第 ${startEpisode}–${startEpisode + episodeCount - 1} 集${regenerate ? '重新写作' : '生成'}任务`);
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, data, onError, projectId]);

  const startMaterialJob = useCallback(async (
    task: 'script_series_outline' | 'script_bible',
    requiredCleanResources: EditableScriptResource[],
    regenerate = false,
  ) => {
    const unsavedResources = requiredCleanResources
      .filter((resource) => dirtyResources.current[resource]);
    if (unsavedResources.length > 0) {
      setNotice(`请先保存${unsavedResources.map((resource) => SCRIPT_RESOURCE_LABEL[resource]).join('、')}，再启动 Agent`);
      return;
    }
    if (data?.jobs.some((job) => job.task === task && BLOCKING_JOB_STATUSES.has(job.status))) {
      setNotice(task === 'script_bible'
        ? '人物与世界补全任务正在运行，请勿重复提交'
        : '大纲生成任务正在运行，请勿重复提交');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const job = await client.script.jobs.create({
        projectId,
        task,
        ...(regenerate ? { regenerate: true } : {}),
      });
      setData((current) => current ? {
        ...current,
        jobs: [job, ...current.jobs.filter((item) => item.id !== job.id)],
      } : current);
      setNotice(task === 'script_bible'
        ? `人物与世界${regenerate ? '重新生成' : '补全'}任务已提交，可切换项目后继续后台运行`
        : `大纲${regenerate ? '重新生成' : '生成'}任务已提交，可切换项目后继续后台运行`);
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, data?.jobs, onError, projectId]);

  const resumeJob = useCallback(async (jobId: string) => {
    const unsavedResources = (Object.keys(dirtyResources.current) as EditableScriptResource[])
      .filter((resource) => dirtyResources.current[resource]);
    if (unsavedResources.length > 0) {
      setNotice(`请先保存${unsavedResources.map((resource) => SCRIPT_RESOURCE_LABEL[resource]).join('、')}，再继续任务`);
      return;
    }
    if (selectedEpisodeDirty.current) {
      setNotice('请先保存当前集');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const job = await client.script.jobs.resume(jobId);
      // The resume endpoint launches the background runner asynchronously. On
      // a very fast response the persisted job can still be waiting/failed for
      // one event-loop turn, which would otherwise leave this page with no
      // polling job and make a successful resume look stuck forever. Treat a
      // resumable response as queued until the next authoritative jobs poll.
      const resumedJob: ScriptAgentJobSnapshot = (
        job.status === 'waiting_user' || job.status === 'failed' || job.status === 'cancelled'
      )
        ? { ...job, status: 'queued', continuable: false }
        : job;
      setData((current) => current ? {
        ...current,
        jobs: current.jobs.map((item) => item.id === resumedJob.id ? resumedJob : item),
      } : current);
      setNotice('任务已从检查点继续');
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, onError]);

  const cancelJob = useCallback(async (jobId: string) => {
    setBusy(true);
    setNotice('');
    try {
      const job = await client.script.jobs.cancel(jobId);
      setData((current) => current ? { ...current, jobs: current.jobs.map((item) => item.id === job.id ? job : item) } : current);
      setNotice('任务已取消，可稍后从已保存内容继续');
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, onError]);

  const openBatch = useCallback(async (startEpisode: number) => {
    if (selectedEpisodeDirty.current) {
      stageRef.current = 'episodes';
      setStage('episodes');
      setNotice('请先保存当前集');
      return;
    }
    const editVersion = selectedEpisodeEditVersion.current;
    const selectionAtStart = selectedEpisodeRef.current;
    stageRef.current = 'episodes';
    setStage('episodes');
    setNotice('');
    episodeRequest.current?.abort();
    episodeRequest.current = undefined;
    setEpisodeLoading(false);
    batchRequest.current?.abort();
    const controller = new AbortController();
    batchRequest.current = controller;
    const endEpisode = Math.min(startEpisode + 4, data?.plan.totalEpisodes ?? startEpisode + 4);
    const episodeNumbers = (data?.episodes ?? [])
      .filter((item) => item.episodeNumber >= startEpisode && item.episodeNumber <= endEpisode)
      .map((item) => item.episodeNumber);
    const selectionChanged = () => (
      selectedEpisodeDirty.current ||
      selectedEpisodeEditVersion.current !== editVersion ||
      selectedEpisodeRef.current !== selectionAtStart
    );
    const commitBatch = (episodes: ScriptEpisode[]) => {
      selectedBatchStartRef.current = startEpisode;
      setSelectedBatchStart(startEpisode);
      setSelectedEpisode(undefined);
      selectedEpisodeRef.current = undefined;
      selectedEpisodeDirty.current = false;
      selectedEpisodeEditVersion.current = 0;
      setBatchEpisodes(episodes);
    };
    if (episodeNumbers.length === 0) {
      if (selectionChanged()) setNotice('请先保存当前集');
      else commitBatch([]);
      setBatchLoading(false);
      return;
    }
    setBatchLoading(true);
    try {
      const results = await Promise.allSettled(
        episodeNumbers.map((episodeNumber) => client.script.episodes.get(projectId, episodeNumber, controller.signal)),
      );
      if (!controller.signal.aborted) {
        if (selectionChanged()) {
          setNotice('请先保存当前集');
          return;
        }
        const episodes = results
          .filter((result): result is PromiseFulfilledResult<ScriptEpisode> => result.status === 'fulfilled' && Boolean(result.value))
          .map((result) => result.value)
          .sort((left, right) => left.episodeNumber - right.episodeNumber);
        commitBatch(episodes);
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (rejected) onError?.(rejected.reason);
      }
    } finally {
      if (!controller.signal.aborted) setBatchLoading(false);
    }
  }, [client, data?.episodes, data?.plan.totalEpisodes, onError, projectId]);

  const openEpisode = useCallback(async (episodeNumber: number) => {
    if (selectedEpisodeDirty.current) {
      setNotice('请先保存当前集');
      return;
    }
    const editVersion = selectedEpisodeEditVersion.current;
    const selectionAtStart = selectedEpisodeRef.current;
    episodeRequest.current?.abort();
    const controller = new AbortController();
    episodeRequest.current = controller;
    setEpisodeLoading(true);
    setNotice('');
    try {
      const episode = await client.script.episodes.get(projectId, episodeNumber, controller.signal);
      if (!controller.signal.aborted && episode) {
        if (
          selectedEpisodeDirty.current ||
          selectedEpisodeEditVersion.current !== editVersion ||
          selectedEpisodeRef.current !== selectionAtStart
        ) {
          setNotice('请先保存当前集');
          return;
        }
        selectedEpisodeRef.current = episode;
        selectedEpisodeDirty.current = false;
        selectedEpisodeEditVersion.current = 0;
        setSelectedEpisode(episode);
        setBatchEpisodes((current) => current.some((item) => item.episodeNumber === episode.episodeNumber)
          ? current.map((item) => item.episodeNumber === episode.episodeNumber ? episode : item)
          : [...current, episode].sort((left, right) => left.episodeNumber - right.episodeNumber));
      }
    } catch (error) {
      if (!controller.signal.aborted) onError?.(error);
    } finally {
      if (!controller.signal.aborted) setEpisodeLoading(false);
    }
  }, [client, onError, projectId]);

  const editSelectedEpisode = useCallback((episode: ScriptEpisode) => {
    selectedEpisodeRef.current = episode;
    selectedEpisodeDirty.current = true;
    selectedEpisodeEditVersion.current += 1;
    setSelectedEpisode(episode);
    setBatchEpisodes((current) => current.some((item) => item.episodeNumber === episode.episodeNumber)
      ? current.map((item) => item.episodeNumber === episode.episodeNumber ? episode : item)
      : [...current, episode].sort((left, right) => left.episodeNumber - right.episodeNumber));
  }, []);

  const saveEpisode = useCallback(async () => {
    if (!selectedEpisode) return;
    const editVersion = selectedEpisodeEditVersion.current;
    setBusy(true);
    setNotice('');
    try {
      const saved = await client.script.episodes.save(projectId, selectedEpisode.episodeNumber, selectedEpisode, selectedEpisode.revision);
      const summary = summarizeEpisode(saved);
      const sameEpisodeStillSelected = selectedEpisodeRef.current?.episodeNumber === saved.episodeNumber;
      const unchangedWhileSaving = selectedEpisodeEditVersion.current === editVersion;
      const editorEpisode = sameEpisodeStillSelected && !unchangedWhileSaving
        ? {
            ...selectedEpisodeRef.current!,
            revision: saved.revision,
            updatedAt: saved.updatedAt,
          }
        : saved;
      if (sameEpisodeStillSelected) {
        selectedEpisodeRef.current = editorEpisode;
        if (unchangedWhileSaving) selectedEpisodeDirty.current = false;
        setSelectedEpisode(editorEpisode);
      }
      setBatchEpisodes((current) => current.some((item) => item.episodeNumber === saved.episodeNumber)
        ? current.map((item) => item.episodeNumber === saved.episodeNumber ? editorEpisode : item)
        : [...current, editorEpisode].sort((left, right) => left.episodeNumber - right.episodeNumber));
      setData((current) => current ? {
        ...current,
        episodes: current.episodes.some((item) => item.episodeNumber === saved.episodeNumber)
          ? current.episodes.map((item) => item.episodeNumber === saved.episodeNumber ? summary : item)
          : [...current.episodes, summary].sort((left, right) => left.episodeNumber - right.episodeNumber),
      } : current);
      setNotice(unchangedWhileSaving
        ? `第 ${saved.episodeNumber} 集已保存`
        : `第 ${saved.episodeNumber} 集已保存，仍有未保存修改`);
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, onError, projectId, selectedEpisode]);

  const reviewEpisode = useCallback(async (episodeNumber: number) => {
    if (!data) return;
    if (
      selectedEpisodeDirty.current &&
      selectedEpisodeRef.current?.episodeNumber === episodeNumber
    ) {
      setNotice('请先保存当前集');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const result = await client.script.episodes.review(projectId, episodeNumber, data.reviewRevision);
      const reviewedEpisode = result.report.hardFailed
        ? undefined
        : await client.script.episodes.get(projectId, episodeNumber);
      const reviewedSummary = reviewedEpisode ? summarizeEpisode(reviewedEpisode) : undefined;
      setData((current) => current ? {
        ...current,
        reviewRevision: result.revision,
        reviewIssues: [
          ...current.reviewIssues.filter((item) => item.episodeNumber !== episodeNumber),
          ...result.items,
        ],
        episodes: reviewedSummary
          ? current.episodes.some((item) => item.episodeNumber === episodeNumber)
            ? current.episodes.map((item) => item.episodeNumber === episodeNumber ? reviewedSummary : item)
            : [...current.episodes, reviewedSummary].sort((left, right) => left.episodeNumber - right.episodeNumber)
          : current.episodes,
      } : current);
      if (reviewedEpisode) {
        setBatchEpisodes((current) => current.some((item) => item.episodeNumber === episodeNumber)
          ? current.map((item) => item.episodeNumber === episodeNumber ? reviewedEpisode : item)
          : current);
        if (
          selectedEpisodeRef.current?.episodeNumber === episodeNumber &&
          !selectedEpisodeDirty.current
        ) {
          selectedEpisodeRef.current = reviewedEpisode;
          selectedEpisodeEditVersion.current = 0;
          setSelectedEpisode(reviewedEpisode);
        }
      }
      const hardCount = result.items.filter(isBlockingReviewIssue).length;
      setNotice(hardCount > 0
        ? `第 ${episodeNumber} 集校稿完成：发现 ${hardCount} 个必须修复的硬性问题`
        : `第 ${episodeNumber} 集校稿完成：未发现阻断完成的硬性问题`);
    } catch (error) {
      if (isApiClientError(error) && error.status === 409) {
        try {
          const latest = await client.script.reviews.list(projectId);
          setData((current) => current ? {
            ...current,
            reviewRevision: latest.revision,
            reviewIssues: latest.items,
          } : current);
          setNotice('校稿状态已被其他页面更新，已同步最新结果，请重试。');
        } catch {
          // The original conflict is the most useful error for the user.
        }
      }
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, data, onError, projectId]);

  const reviewCurrentBatch = useCallback(async (episodeNumbers: number[]) => {
    if (!data) return;
    if (selectedEpisodeDirty.current) {
      setNotice('请先保存当前集');
      return;
    }
    const numbers = [...new Set(episodeNumbers)].sort((left, right) => left - right);
    if (numbers.length === 0) {
      setNotice('当前五集还没有可校稿的正文');
      return;
    }
    setBusy(true);
    setNotice('AI 正在校稿当前五集，请稍候…');
    try {
      let reviewRevision = data.reviewRevision;
      let reviewIssues = [...data.reviewIssues];
      let episodeSummaries = [...data.episodes];
      const reviewedEpisodes: ScriptEpisode[] = [];
      let hardCount = 0;

      for (const episodeNumber of numbers) {
        const result = await client.script.episodes.review(projectId, episodeNumber, reviewRevision);
        reviewRevision = result.revision;
        reviewIssues = [
          ...reviewIssues.filter((item) => item.episodeNumber !== episodeNumber),
          ...result.items,
        ];
        hardCount += result.items.filter(isBlockingReviewIssue).length;
        if (!result.report.hardFailed) {
          const reviewedEpisode = await client.script.episodes.get(projectId, episodeNumber);
          const reviewedSummary = summarizeEpisode(reviewedEpisode);
          reviewedEpisodes.push(reviewedEpisode);
          episodeSummaries = episodeSummaries.some((item) => item.episodeNumber === episodeNumber)
            ? episodeSummaries.map((item) => item.episodeNumber === episodeNumber ? reviewedSummary : item)
            : [...episodeSummaries, reviewedSummary].sort((left, right) => left.episodeNumber - right.episodeNumber);
        }
      }

      setData((current) => current ? {
        ...current,
        reviewRevision,
        reviewIssues,
        episodes: episodeSummaries,
      } : current);
      if (reviewedEpisodes.length > 0) {
        const reviewedByNumber = new Map(reviewedEpisodes.map((episode) => [episode.episodeNumber, episode]));
        setBatchEpisodes((current) => current.map((episode) => reviewedByNumber.get(episode.episodeNumber) ?? episode));
        const selectedNumber = selectedEpisodeRef.current?.episodeNumber;
        const reviewedSelection = selectedNumber === undefined ? undefined : reviewedByNumber.get(selectedNumber);
        if (reviewedSelection && !selectedEpisodeDirty.current) {
          selectedEpisodeRef.current = reviewedSelection;
          selectedEpisodeEditVersion.current = 0;
          setSelectedEpisode(reviewedSelection);
        }
      }
      setNotice(hardCount > 0
        ? `当前五集 AI 校稿完成：发现 ${hardCount} 个必须修复的硬性问题`
        : '当前五集 AI 校稿完成：未发现阻断完成的硬性问题');
    } catch (error) {
      if (isApiClientError(error) && error.status === 409) {
        try {
          const latest = await client.script.reviews.list(projectId);
          setData((current) => current ? {
            ...current,
            reviewRevision: latest.revision,
            reviewIssues: latest.items,
          } : current);
          setNotice('校稿状态已被其他页面更新，已同步最新结果，请重试。');
        } catch {
          // The original conflict is the most useful error for the user.
        }
      }
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, data, onError, projectId]);

  const updateReviewStatus = useCallback(async (issueId: Id, status: ScriptReviewStatus) => {
    if (!data) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await client.script.reviews.updateStatus(
        projectId,
        issueId,
        status,
        data.reviewRevision,
      );
      setData((current) => current ? {
        ...current,
        reviewRevision: result.revision,
        reviewIssues: current.reviewIssues.map((item) => item.id === result.item.id ? result.item : item),
      } : current);
      setNotice(status === 'fixed' ? '校稿问题已标记为修复' : status === 'ignored' ? '校稿问题已忽略' : '校稿问题已重新打开');
    } catch (error) {
      if (isApiClientError(error) && error.status === 409) {
        try {
          const latest = await client.script.reviews.list(projectId);
          setData((current) => current ? {
            ...current,
            reviewRevision: latest.revision,
            reviewIssues: latest.items,
          } : current);
          setNotice('校稿状态已被其他页面更新，已同步最新结果，请重新操作。');
        } catch {
          // The original conflict is the most useful error for the user.
        }
      }
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, data, onError, projectId]);

  const exportScript = useCallback(async (
    format: 'txt' | 'md' | 'docx' | 'fountain',
    range?: ScriptExportRange,
  ) => {
    const unsavedResources = (Object.keys(dirtyResources.current) as EditableScriptResource[])
      .filter((resource) => dirtyResources.current[resource]);
    if (unsavedResources.length > 0) {
      setNotice(`请先保存${unsavedResources.map((resource) => SCRIPT_RESOURCE_LABEL[resource]).join('、')}，再导出`);
      return;
    }
    if (selectedEpisodeDirty.current) {
      setNotice('请先保存当前集');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const title = projectName ?? data?.plan.title ?? '短剧';
      if (format === 'docx') {
        const file = range
          ? await client.script.exportFile(projectId, 'txt', range)
          : await client.script.exportFile(projectId, 'txt');
        const content = await file.blob.text();
        downloadBlobFile(
          buildProjectDocxBlob(title, [{ title: '短剧剧本', content, position: 0 }]),
          `${sanitizeDownloadName(title)}.docx`,
        );
      } else {
        const file = range
          ? await client.script.exportFile(projectId, format, range)
          : await client.script.exportFile(projectId, format);
        downloadBlobFile(file.blob, file.filename);
      }
      setNotice(`已导出 ${format.toUpperCase()}`);
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, data?.plan.title, onError, projectId, projectName]);

  const openTaskRecords = useCallback(async (mode: 'history' | 'trash') => {
    setTaskRecordMode(mode);
    if (mode !== 'trash') return;
    if (!client.script.jobs.listTrash) {
      setNotice('回收站接口尚未部署，请先部署新版后端。');
      return;
    }
    setTrashLoading(true);
    try {
      setTrashJobs(await client.script.jobs.listTrash(projectId));
    } catch (error) {
      onError?.(error);
    } finally {
      setTrashLoading(false);
    }
  }, [client, onError, projectId]);

  const trashJob = useCallback(async (jobId: string) => {
    if (!client.script.jobs.trash) {
      setNotice('删除任务接口尚未部署，请先部署新版后端。');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const trashed = await client.script.jobs.trash(jobId);
      setData((current) => current ? {
        ...current,
        jobs: current.jobs.filter((job) => job.id !== jobId),
      } : current);
      setTrashJobs((current) => [trashed, ...current.filter((job) => job.id !== jobId)]);
      setNotice('任务已移入回收站，已生成的剧本没有删除。');
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, onError]);

  const restoreJob = useCallback(async (jobId: string) => {
    if (!client.script.jobs.restore) return;
    setBusy(true);
    setNotice('');
    try {
      const restored = await client.script.jobs.restore(jobId);
      setTrashJobs((current) => current.filter((job) => job.id !== jobId));
      setData((current) => current ? {
        ...current,
        jobs: [restored, ...current.jobs.filter((job) => job.id !== jobId)],
      } : current);
      setNotice('任务记录已恢复。');
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, onError]);

  const deleteJobPermanently = useCallback(async (jobId: string) => {
    if (!client.script.jobs.removePermanently) return;
    const confirmed = window.confirm('永久删除后无法恢复。只会删除任务记录，不会删除已经生成的剧本。确定永久删除吗？');
    if (!confirmed) return;
    setBusy(true);
    setNotice('');
    try {
      await client.script.jobs.removePermanently(jobId);
      setTrashJobs((current) => current.filter((job) => job.id !== jobId));
      setNotice('任务记录已永久删除，剧本内容仍然保留。');
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, onError]);

  const workspaceTitle = data?.plan.title || projectName || '未命名短剧';
  const totalEpisodes = data?.plan.totalEpisodes ?? 0;
  const completedEpisodes = data?.episodes.filter((item) => item.status === 'completed').length ?? 0;
  const totalVisibleChars = data?.episodes.reduce((total, item) => total + item.visibleChars, 0) ?? 0;
  const prerequisitesReady = Boolean(
    data && data.plan.status !== 'draft' && data.outline && data.characters.length > 0 && data.world,
  );
  const materialTask = stage === 'outline'
    ? 'script_series_outline'
    : stage === 'characters' || stage === 'world'
      ? 'script_bible'
      : undefined;
  const stageMaterialJob = materialTask
    ? data?.jobs.find((job) => (
      job.task === materialTask && (BLOCKING_JOB_STATUSES.has(job.status) || job.continuable === true)
    ))
    : undefined;
  const visibleBackgroundJob = stage === 'episodes'
    ? undefined
    : stageMaterialJob ?? data?.jobs.find((job) => (
      BLOCKING_JOB_STATUSES.has(job.status) || job.continuable === true
    ));
  const backgroundJobLabel = visibleBackgroundJob?.task === 'script_series_outline'
    ? '大纲'
    : visibleBackgroundJob?.task === 'script_bible'
      ? '人物与世界'
      : visibleBackgroundJob?.task === 'script_episode_batch'
        ? '正文'
        : '策划';
  const batches = data
    ? buildScriptBatchNavigation(data.plan.totalEpisodes, data.episodes, data.jobs, prerequisitesReady).map((batch) => {
        const serverSummary = data.batchSummaries.find((item) => item.startEpisode === batch.startEpisode);
        const openIssues = data.reviewIssues.filter((item) => (
          item.status === 'open' &&
          item.episodeNumber >= batch.startEpisode &&
          item.episodeNumber <= batch.endEpisode
        ));
        const hasHardIssue = openIssues.some(isBlockingReviewIssue);
        const status = batch.status === 'generating'
          ? batch.status
          : hasHardIssue
            ? 'failed'
            : openIssues.length > 0
              ? 'proofreading'
              : serverSummary?.status ?? batch.status;
        return {
          ...batch,
          status,
          completedEpisodes: serverSummary?.completedEpisodes ?? batch.completedEpisodes,
          visibleChars: serverSummary?.visibleChars ?? batch.visibleChars,
        };
      })
    : [];

  return (
    <div className="script-workspace" data-project-id={projectId}>
      <ScriptProductionSidebar
        title={workspaceTitle}
        activeStage={stage}
        activeBatchStart={selectedBatchStart}
        totalEpisodes={totalEpisodes}
        completedEpisodes={completedEpisodes}
        totalVisibleChars={totalVisibleChars}
        batches={batches}
        onStageChange={(nextStage) => {
          if (nextStage === 'episodes') void openBatch(selectedBatchStart);
          else {
            setStage(nextStage);
            setNotice('');
          }
        }}
        onBatchChange={(startEpisode) => void openBatch(startEpisode)}
      />
      <main className="script-workspace-main">
        <header className="script-workspace-header"><div><span className="script-workspace-kicker">短剧生产工作台</span><h1>{workspaceTitle}</h1></div><div className="script-workspace-summary"><span>{totalEpisodes} 集</span><span>{completedEpisodes} 已完成</span><span>{totalVisibleChars.toLocaleString('zh-CN')} 字</span><button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" aria-expanded={taskRecordMode === 'history'} onClick={() => void openTaskRecords('history')}>任务记录{data ? ` ${data.jobs.length}` : ''}</button><button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" aria-expanded={taskRecordMode === 'trash'} onClick={() => void openTaskRecords('trash')}>回收站{trashJobs.length > 0 ? ` ${trashJobs.length}` : ''}</button></div></header>
        {notice ? <div className="script-notice" role="status">{notice}</div> : null}
        {taskRecordMode ? <TaskRecordPanel mode={taskRecordMode} jobs={taskRecordMode === 'trash' ? trashJobs : data?.jobs ?? []} busy={busy} loading={taskRecordMode === 'trash' && trashLoading} onClose={() => setTaskRecordMode(undefined)} onTrash={(jobId) => void trashJob(jobId)} onRestore={(jobId) => void restoreJob(jobId)} onDeletePermanently={(jobId) => void deleteJobPermanently(jobId)} /> : null}
        {visibleBackgroundJob ? <MaterialJobPanel job={visibleBackgroundJob} label={backgroundJobLabel} busy={busy} onResume={(jobId) => void resumeJob(jobId)} onCancel={(jobId) => void cancelJob(jobId)} /> : null}
        {!data ? <div className="script-loading" role="status">正在加载短剧资料…</div> : null}
        {data && stage === 'plan' ? <PlanEditor value={data.plan} busy={busy} conceptBusy={conceptBusy} conceptPrompt={conceptPrompt} concepts={concepts} questions={planQuestions} answers={planAnswers} onChange={(plan) => { markResourceDirty('plan'); setData((current) => current ? { ...current, plan } : current); }} onConceptPromptChange={setConceptPrompt} onGenerateConcepts={() => void generateConcepts()} onAdoptConcept={adoptConcept} onSave={() => void savePlan()} onAgentPlan={() => void startPlanInterview()} onAutoComplete={() => void autoCompletePlan()} onAnswer={(field, value) => setPlanAnswers((current) => ({ ...current, [field]: { field, value } }))} onDelegate={(field) => setPlanAnswers((current) => ({ ...current, [field]: { field, delegate: true } }))} onSubmitAnswers={() => void submitPlanAnswers()} onApprove={() => void approvePlan()} /> : null}
        {data && stage === 'outline' ? <OutlineEditor value={data.outline ?? emptyOutline(projectId)} busy={busy} onChange={(outline) => { markResourceDirty('outline'); setData((current) => current ? { ...current, outline } : current); }} onSave={() => void saveOutline()} onGenerate={(regenerate) => void startMaterialJob('script_series_outline', ['plan', 'outline'], regenerate)} /> : null}
        {data && stage === 'characters' ? <CharacterEditor projectId={projectId} value={data.characters} busy={busy} onChange={(characters) => { markResourceDirty('characters'); setData((current) => current ? { ...current, characters } : current); }} onSave={() => void saveCharacters()} onGenerate={(regenerate) => void startMaterialJob('script_bible', ['plan', 'outline', 'characters', 'world'], regenerate)} /> : null}
        {data && stage === 'episodes' ? <EpisodeBatchPanel data={data} busy={busy} batchStart={selectedBatchStart} batchEpisodes={batchEpisodes} batchLoading={batchLoading} episode={selectedEpisode} episodeLoading={episodeLoading} onStart={(start, count, regenerate) => void startEpisodeBatch(start, count, regenerate)} onResume={(jobId) => void resumeJob(jobId)} onCancel={(jobId) => void cancelJob(jobId)} onTrash={(jobId) => void trashJob(jobId)} onOpenEpisode={(episodeNumber) => void openEpisode(episodeNumber)} onEpisodeChange={editSelectedEpisode} onSaveEpisode={() => void saveEpisode()} onReviewEpisode={(episodeNumber) => void reviewEpisode(episodeNumber)} onReviewBatch={(episodeNumbers) => void reviewCurrentBatch(episodeNumbers)} onReviewStatus={(issueId, status) => void updateReviewStatus(issueId, status)} onExport={(format, range) => void exportScript(format, range)} /> : null}
        {data && stage === 'world' ? <WorldEditor value={data.world ?? emptyWorld(projectId)} busy={busy} onChange={(world) => { markResourceDirty('world'); setData((current) => current ? { ...current, world } : current); }} onSave={() => void saveWorld()} onGenerate={(regenerate) => void startMaterialJob('script_bible', ['plan', 'outline', 'characters', 'world'], regenerate)} /> : null}
      </main>
    </div>
  );
}

export default ScriptWorkspace;
