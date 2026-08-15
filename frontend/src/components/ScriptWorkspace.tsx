import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient, { isApiClientError, type ApiClient } from '../api/apiClient.js';
import type {
  Id,
  ScriptAgentJobSnapshot,
  ScriptCharacter,
  ScriptEpisode,
  ScriptEpisodeSummary,
  ScriptPlan,
  ScriptSeriesOutline,
  ScriptWorldBible,
} from '../types/index.js';
import './script-workspace.css';

type ScriptStage = 'plan' | 'outline' | 'characters' | 'world' | 'episodes';

export interface ScriptWorkspaceProps {
  projectId: Id;
  projectName?: string;
  onError?: (error: unknown) => void;
  client?: Pick<ApiClient, 'script'>;
}

interface ScriptWorkspaceData {
  plan: ScriptPlan;
  outline?: ScriptSeriesOutline;
  characters: ScriptCharacter[];
  world?: ScriptWorldBible;
  episodes: ScriptEpisodeSummary[];
  jobs: ScriptAgentJobSnapshot[];
}

const STAGES: Array<{ id: ScriptStage; label: string }> = [
  { id: 'plan', label: '剧本策划' },
  { id: 'outline', label: '剧本大纲' },
  { id: 'characters', label: '角色设定' },
  { id: 'world', label: '世界设定' },
  { id: 'episodes', label: '分批正文' },
];

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
  onChange,
  onSave,
}: {
  value: ScriptPlan;
  busy: boolean;
  onChange: (value: ScriptPlan) => void;
  onSave: () => void;
}): JSX.Element {
  const patch = <K extends keyof ScriptPlan>(key: K, next: ScriptPlan[K]) =>
    onChange({ ...value, [key]: next });
  return (
    <section className="script-stage-panel" aria-labelledby="script-plan-heading">
      <header className="script-stage-heading">
        <div><span>第一阶段</span><h2 id="script-plan-heading">剧本策划</h2></div>
        <span className="script-status-chip">{value.status === 'draft' ? '草稿' : value.status === 'approved' ? '已确认' : '已锁定'}</span>
      </header>
      <div className="script-form-grid">
        <label className="script-field script-field--wide">剧本名称<input value={value.title} onChange={(e) => patch('title', e.target.value)} /></label>
        <label className="script-field script-field--wide">主题<textarea value={value.theme} onChange={(e) => patch('theme', e.target.value)} /></label>
        <label className="script-field">市场<select value={value.market} onChange={(e) => patch('market', e.target.value as ScriptPlan['market'])}><option value="domestic">国内</option><option value="overseas">海外</option></select></label>
        <label className="script-field">频道<select value={value.channel} onChange={(e) => patch('channel', e.target.value as ScriptPlan['channel'])}><option value="female">女频</option><option value="male">男频</option><option value="general">通用</option></select></label>
        <label className="script-field script-field--wide">题材（逗号分隔）<input value={value.genres.join('，')} onChange={(e) => patch('genres', e.target.value.split(/[，,]/).map((item) => item.trim()).filter(Boolean))} /></label>
        <label className="script-field script-field--wide">一句话梗概<textarea value={value.logline} onChange={(e) => patch('logline', e.target.value)} /></label>
        <label className="script-field script-field--wide">核心冲突<textarea value={value.coreConflict} onChange={(e) => patch('coreConflict', e.target.value)} /></label>
        <label className="script-field">总集数<input type="number" min={1} max={200} value={value.totalEpisodes} onChange={(e) => patch('totalEpisodes', Number(e.target.value))} /></label>
        <label className="script-field">单集目标字数<input type="number" min={300} max={3000} value={value.targetCharsPerEpisode} onChange={(e) => patch('targetCharsPerEpisode', Number(e.target.value))} /></label>
        <label className="script-field">单集时长下限（秒）<input type="number" min={30} max={180} value={value.episodeDurationSeconds.min} onChange={(e) => patch('episodeDurationSeconds', { ...value.episodeDurationSeconds, min: Number(e.target.value) })} /></label>
        <label className="script-field">单集时长上限（秒）<input type="number" min={30} max={180} value={value.episodeDurationSeconds.max} onChange={(e) => patch('episodeDurationSeconds', { ...value.episodeDurationSeconds, max: Number(e.target.value) })} /></label>
        <label className="script-field">主要角色上限<input type="number" min={1} max={20} value={value.maxPrimaryCharacters} onChange={(e) => patch('maxPrimaryCharacters', Number(e.target.value))} /></label>
        <label className="script-field">每集场景上限<input type="number" min={1} max={5} value={value.maxScenesPerEpisode} onChange={(e) => patch('maxScenesPerEpisode', Number(e.target.value))} /></label>
        <label className="script-field script-field--wide">目标受众<input value={value.audience} onChange={(e) => patch('audience', e.target.value)} /></label>
        <label className="script-field script-field--wide">核心要求<textarea rows={5} value={value.coreRequirements} onChange={(e) => patch('coreRequirements', e.target.value)} /></label>
        <label className="script-field script-field--wide">结局方向<textarea value={value.endingDirection} onChange={(e) => patch('endingDirection', e.target.value)} /></label>
      </div>
      <footer className="script-stage-actions"><button type="button" className="nwa-button" disabled={busy} onClick={onSave}>{busy ? '保存中…' : '保存策划'}</button></footer>
    </section>
  );
}

function OutlineEditor({
  value,
  busy,
  onChange,
  onSave,
}: {
  value: ScriptSeriesOutline;
  busy: boolean;
  onChange: (value: ScriptSeriesOutline) => void;
  onSave: () => void;
}): JSX.Element {
  const patch = <K extends keyof ScriptSeriesOutline>(key: K, next: ScriptSeriesOutline[K]) =>
    onChange({ ...value, [key]: next });
  return (
    <section className="script-stage-panel" aria-labelledby="script-outline-heading">
      <header className="script-stage-heading"><div><span>第二阶段</span><h2 id="script-outline-heading">剧本大纲</h2></div><span className="script-status-chip">{value.episodeCards.length} 张分集卡</span></header>
      <div className="script-form-grid">
        <label className="script-field script-field--wide">全剧梗概<textarea rows={8} value={value.synopsis} onChange={(e) => patch('synopsis', e.target.value)} /></label>
        <label className="script-field">开局状态<textarea value={value.openingState} onChange={(e) => patch('openingState', e.target.value)} /></label>
        <label className="script-field">中点转折<textarea value={value.midpointTurn} onChange={(e) => patch('midpointTurn', e.target.value)} /></label>
        <label className="script-field">高潮<textarea value={value.climax} onChange={(e) => patch('climax', e.target.value)} /></label>
        <label className="script-field">结局状态<textarea value={value.endingState} onChange={(e) => patch('endingState', e.target.value)} /></label>
        <label className="script-field script-field--wide">主线节拍（每行一条）<textarea rows={5} value={value.mainArc.join('\n')} onChange={(e) => patch('mainArc', e.target.value.split('\n').map((item) => item.trim()).filter(Boolean))} /></label>
        <label className="script-field script-field--wide">支线（每行一条）<textarea rows={4} value={value.subplotArcs.join('\n')} onChange={(e) => patch('subplotArcs', e.target.value.split('\n').map((item) => item.trim()).filter(Boolean))} /></label>
      </div>
      {value.episodeCards.length > 0 ? <div className="script-outline-cards"><h3>分集卡</h3>{value.episodeCards.map((card, index) => <article key={card.episodeNumber}><strong>第 {card.episodeNumber} 集</strong><input aria-label={`第 ${card.episodeNumber} 集标题`} value={card.title} onChange={(e) => patch('episodeCards', value.episodeCards.map((item, itemIndex) => itemIndex === index ? { ...item, title: e.target.value } : item))} /><textarea aria-label={`第 ${card.episodeNumber} 集梗概`} value={card.logline} onChange={(e) => patch('episodeCards', value.episodeCards.map((item, itemIndex) => itemIndex === index ? { ...item, logline: e.target.value } : item))} /></article>)}</div> : <p className="script-muted">保存策划后，可让 Agent 生成全剧总纲与连续分集卡。</p>}
      <footer className="script-stage-actions"><button type="button" className="nwa-button" disabled={busy} onClick={onSave}>{busy ? '保存中…' : '保存大纲'}</button></footer>
    </section>
  );
}

function emptyCharacter(projectId: Id, index: number): ScriptCharacter {
  return {
    id: `${projectId}-character-${index}`,
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

function CharacterEditor({
  projectId,
  value,
  busy,
  onChange,
  onSave,
}: {
  projectId: Id;
  value: ScriptCharacter[];
  busy: boolean;
  onChange: (value: ScriptCharacter[]) => void;
  onSave: () => void;
}): JSX.Element {
  const update = (index: number, fields: Partial<ScriptCharacter>) =>
    onChange(value.map((item, itemIndex) => itemIndex === index ? { ...item, ...fields } : item));
  return (
    <section className="script-stage-panel" aria-labelledby="script-characters-heading">
      <header className="script-stage-heading"><div><span>第三阶段</span><h2 id="script-characters-heading">角色设定</h2></div><button type="button" className="nwa-button nwa-button--ghost" onClick={() => onChange([...value, emptyCharacter(projectId, value.length + 1)])}>添加角色</button></header>
      {value.length === 0 ? <p className="script-muted">尚无角色。可手动添加，或让 Agent 根据策划和总纲生成角色圣经。</p> : <div className="script-character-list">{value.map((character, index) => (
        <article key={character.id} className="script-character-card">
          <header><strong>{character.name || `角色 ${index + 1}`}</strong><button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}>删除</button></header>
          <div className="script-form-grid">
            <label className="script-field">姓名<input aria-label={`角色姓名 ${index + 1}`} value={character.name} onChange={(e) => update(index, { name: e.target.value })} /></label>
            <label className="script-field">定位<select value={character.role} onChange={(e) => update(index, { role: e.target.value as ScriptCharacter['role'] })}><option value="lead">主角</option><option value="supporting">配角</option><option value="antagonist">反派</option><option value="minor">次要角色</option></select></label>
            <label className="script-field">年龄<input type="number" min={0} max={120} value={character.age ?? ''} onChange={(e) => update(index, { age: e.target.value ? Number(e.target.value) : undefined })} /></label>
            <label className="script-field">职业<input value={character.occupation ?? ''} onChange={(e) => update(index, { occupation: e.target.value })} /></label>
            <label className="script-field script-field--wide">身份与经历<textarea value={character.biography} onChange={(e) => update(index, { biography: e.target.value })} /></label>
            <label className="script-field">目标<textarea value={character.goal} onChange={(e) => update(index, { goal: e.target.value })} /></label>
            <label className="script-field">弱点<textarea value={character.weakness} onChange={(e) => update(index, { weakness: e.target.value })} /></label>
            <label className="script-field script-field--wide">默认服装<textarea aria-label={`角色服装 ${index + 1}`} value={character.defaultOutfit} onChange={(e) => update(index, { defaultOutfit: e.target.value })} /></label>
            <label className="script-field">外貌<textarea value={character.appearance} onChange={(e) => update(index, { appearance: e.target.value })} /></label>
            <label className="script-field">发型与体格<textarea value={[character.hairstyle, character.physique].filter(Boolean).join('；')} onChange={(e) => update(index, { hairstyle: e.target.value })} /></label>
            <label className="script-field script-field--wide">语言风格与口头禅<textarea value={[character.speechStyle, ...character.catchphrases].filter(Boolean).join('\n')} onChange={(e) => update(index, { speechStyle: e.target.value })} /></label>
          </div>
        </article>
      ))}</div>}
      <footer className="script-stage-actions"><button type="button" className="nwa-button" disabled={busy} onClick={onSave}>{busy ? '保存中…' : '保存角色设定'}</button></footer>
    </section>
  );
}

function WorldEditor({
  value,
  busy,
  onChange,
  onSave,
}: {
  value: ScriptWorldBible;
  busy: boolean;
  onChange: (value: ScriptWorldBible) => void;
  onSave: () => void;
}): JSX.Element {
  const patch = <K extends keyof ScriptWorldBible>(key: K, next: ScriptWorldBible[K]) =>
    onChange({ ...value, [key]: next });
  const lines = (text: string) => text.split('\n').map((item) => item.trim()).filter(Boolean);
  return (
    <section className="script-stage-panel" aria-labelledby="script-world-heading">
      <header className="script-stage-heading"><div><span>第四阶段</span><h2 id="script-world-heading">世界设定</h2></div><span className="script-status-chip">版本 {value.revision}</span></header>
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

const CHECKPOINT_LABEL: Record<NonNullable<ScriptAgentJobSnapshot['checkpoint']>['node'], string> = {
  episode_outline: '详细大纲',
  scene_plan: '场景计划',
  draft: '正文初稿',
  review: '连续性审查',
  completed: '本集完成',
  batch_report: '批次报告',
};

function nextBatchStart(episodes: ScriptEpisodeSummary[], totalEpisodes: number): number {
  const completed = new Set(
    episodes.filter((item) => item.status === 'completed').map((item) => item.episodeNumber),
  );
  for (let episode = 1; episode <= totalEpisodes; episode += 1) {
    if (!completed.has(episode)) return episode;
  }
  return totalEpisodes + 1;
}

function EpisodeBatchPanel({
  data,
  busy,
  episode,
  episodeLoading,
  onStart,
  onResume,
  onCancel,
  onOpenEpisode,
  onEpisodeChange,
  onSaveEpisode,
  onExport,
}: {
  data: ScriptWorkspaceData;
  busy: boolean;
  episode?: ScriptEpisode;
  episodeLoading: boolean;
  onStart: (startEpisode: number, episodeCount: number) => void;
  onResume: (jobId: string) => void;
  onCancel: (jobId: string) => void;
  onOpenEpisode: (episodeNumber: number) => void;
  onEpisodeChange: (episode: ScriptEpisode) => void;
  onSaveEpisode: () => void;
  onExport: (format: 'txt' | 'md') => void;
}): JSX.Element {
  const start = nextBatchStart(data.episodes, data.plan.totalEpisodes);
  const count = Math.min(5, Math.max(0, data.plan.totalEpisodes - start + 1));
  const end = start + count - 1;
  return (
    <section className="script-stage-panel script-episodes-panel" aria-labelledby="script-episodes-heading">
      <header className="script-stage-heading">
        <div><span>第五阶段</span><h2 id="script-episodes-heading">分批正文</h2></div>
        <div className="script-stage-heading__actions">
          <button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={() => onExport('txt')}>导出 TXT</button>
          <button type="button" className="nwa-button nwa-button--ghost" disabled={busy} onClick={() => onExport('md')}>导出 MD</button>
          {count > 0 ? <button type="button" className="nwa-button" disabled={busy} onClick={() => onStart(start, count)}>生成第 {start}–{end} 集</button> : <span className="script-status-chip">全剧已完成</span>}
        </div>
      </header>
      <div className="script-production-grid">
        <div>
          <h3>分集进度</h3>
          {data.episodes.length === 0 ? <p className="script-muted">尚未生成正文。每批最多 5 集，完成一集立即保存。</p> : (
            <ol className="script-episode-list">
              {data.episodes.map((item) => <li key={item.episodeNumber}><button type="button" className="script-episode-open" aria-label={`打开第 ${item.episodeNumber} 集`} onClick={() => onOpenEpisode(item.episodeNumber)}>打开第 {item.episodeNumber} 集<span>{item.title}</span></button><span>{JOB_STATUS_LABEL[item.status === 'generating' || item.status === 'reviewing' ? 'running' : item.status === 'planned' ? 'queued' : item.status]} · {item.visibleChars} 字</span></li>)}
            </ol>
          )}
        </div>
        <aside className="script-job-panel" aria-label="生成任务">
          <h3>任务与检查点</h3>
          {data.jobs.length === 0 ? <p className="script-muted">暂无后台任务。</p> : data.jobs.map((job) => (
            <article className="script-job-card" key={job.id}>
              <div className="script-job-card__status"><strong>{JOB_STATUS_LABEL[job.status]}</strong><span>{job.task === 'script_episode_batch' ? '分批正文' : '资料生成'}</span></div>
              {job.checkpoint ? <p>第 {job.checkpoint.episodeNumber} 集 · {CHECKPOINT_LABEL[job.checkpoint.node]}</p> : <p>等待首个检查点</p>}
              {job.error ? <p className="script-job-error">{job.error.message}</p> : null}
              {job.status === 'failed' && job.continuable ? <button type="button" className="nwa-button nwa-button--sm" disabled={busy} onClick={() => onResume(job.id)}>从检查点继续</button> : null}
              {job.status === 'queued' || job.status === 'running' || job.status === 'retrying' ? <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy} onClick={() => onCancel(job.id)}>取消任务</button> : null}
            </article>
          ))}
        </aside>
      </div>
      {episodeLoading ? <div className="script-loading script-loading--compact" role="status">正在加载单集正文…</div> : null}
      {episode ? (
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

export function ScriptWorkspace({ projectId, projectName, onError, client = apiClient }: ScriptWorkspaceProps): JSX.Element {
  const [stage, setStage] = useState<ScriptStage>('plan');
  const [data, setData] = useState<ScriptWorkspaceData | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [selectedEpisode, setSelectedEpisode] = useState<ScriptEpisode>();
  const [episodeLoading, setEpisodeLoading] = useState(false);
  const episodeRequest = useRef<AbortController>();

  useEffect(() => {
    const controller = new AbortController();
    setStage('plan');
    setData(null);
    setNotice('');
    setSelectedEpisode(undefined);
    setEpisodeLoading(false);
    episodeRequest.current?.abort();
    void Promise.all([
      optional(client.script.plan.get(projectId, controller.signal)),
      client.script.characters.list(projectId, controller.signal),
      optional(client.script.world.get(projectId, controller.signal)),
      optional(client.script.outline.get(projectId, controller.signal)),
      client.script.episodes.list(projectId, controller.signal),
      client.script.jobs.list(projectId, controller.signal),
    ]).then(([plan, characters, world, outline, episodes, jobs]) => {
      if (controller.signal.aborted) return;
      setData({ plan: plan ?? emptyPlan(projectId, projectName), characters, world, outline, episodes, jobs });
    }).catch((error) => {
      if (!controller.signal.aborted) onError?.(error);
    });
    return () => {
      controller.abort();
      episodeRequest.current?.abort();
    };
  }, [client, onError, projectId, projectName]);

  const savePlan = useCallback(async () => {
    if (!data) return;
    setBusy(true);
    setNotice('');
    try {
      const saved = await client.script.plan.save(projectId, data.plan, data.plan.revision);
      setData((current) => current ? { ...current, plan: saved } : current);
      setNotice('策划已保存');
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, data, onError, projectId]);

  const saveOutline = useCallback(async () => {
    if (!data) return;
    const outline = data.outline ?? emptyOutline(projectId);
    setBusy(true);
    setNotice('');
    try {
      const saved = await client.script.outline.save(projectId, outline, outline.revision);
      setData((current) => current ? { ...current, outline: saved } : current);
      setNotice('大纲已保存');
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, data, onError, projectId]);

  const saveCharacters = useCallback(async () => {
    if (!data) return;
    setBusy(true);
    setNotice('');
    try {
      const revision = data.characters.reduce((max, item) => Math.max(max, item.revision), 0);
      const saved = await client.script.characters.save(projectId, data.characters, revision);
      setData((current) => current ? { ...current, characters: saved } : current);
      setNotice('角色设定已保存');
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, data, onError, projectId]);

  const saveWorld = useCallback(async () => {
    if (!data) return;
    const world = data.world ?? emptyWorld(projectId);
    setBusy(true);
    setNotice('');
    try {
      const saved = await client.script.world.save(projectId, world, world.revision);
      setData((current) => current ? { ...current, world: saved } : current);
      setNotice('世界设定已保存');
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, data, onError, projectId]);

  const startEpisodeBatch = useCallback(async (startEpisode: number, episodeCount: number) => {
    if (!data) return;
    setBusy(true);
    setNotice('');
    try {
      const job = await client.script.jobs.create({
        projectId,
        task: 'script_episode_batch',
        scriptBatchOptions: {
          startEpisode,
          episodeCount,
          expectedPlanRevision: data.plan.revision,
        },
      });
      setData((current) => current ? { ...current, jobs: [job, ...current.jobs.filter((item) => item.id !== job.id)] } : current);
      setNotice(`已提交第 ${startEpisode}–${startEpisode + episodeCount - 1} 集生成任务`);
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, data, onError, projectId]);

  const resumeJob = useCallback(async (jobId: string) => {
    setBusy(true);
    setNotice('');
    try {
      const job = await client.script.jobs.resume(jobId);
      setData((current) => current ? { ...current, jobs: current.jobs.map((item) => item.id === job.id ? job : item) } : current);
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

  const openEpisode = useCallback(async (episodeNumber: number) => {
    episodeRequest.current?.abort();
    const controller = new AbortController();
    episodeRequest.current = controller;
    setEpisodeLoading(true);
    setNotice('');
    try {
      const episode = await client.script.episodes.get(projectId, episodeNumber, controller.signal);
      if (!controller.signal.aborted) setSelectedEpisode(episode);
    } catch (error) {
      if (!controller.signal.aborted) onError?.(error);
    } finally {
      if (!controller.signal.aborted) setEpisodeLoading(false);
    }
  }, [client, onError, projectId]);

  const saveEpisode = useCallback(async () => {
    if (!selectedEpisode) return;
    setBusy(true);
    setNotice('');
    try {
      const saved = await client.script.episodes.save(projectId, selectedEpisode.episodeNumber, selectedEpisode, selectedEpisode.revision);
      const visibleChars = saved.scenes.reduce((total, scene) => total + scene.blocks.reduce((sceneTotal, block) => sceneTotal + block.text.length, 0), 0);
      const summary: ScriptEpisodeSummary = {
        id: saved.id,
        episodeNumber: saved.episodeNumber,
        title: saved.title,
        status: saved.status,
        targetChars: saved.targetChars,
        visibleChars,
        sceneCount: saved.scenes.length,
        revision: saved.revision,
        updatedAt: saved.updatedAt,
      };
      setSelectedEpisode(saved);
      setData((current) => current ? {
        ...current,
        episodes: current.episodes.some((item) => item.episodeNumber === saved.episodeNumber)
          ? current.episodes.map((item) => item.episodeNumber === saved.episodeNumber ? summary : item)
          : [...current.episodes, summary].sort((left, right) => left.episodeNumber - right.episodeNumber),
      } : current);
      setNotice(`第 ${saved.episodeNumber} 集已保存`);
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, onError, projectId, selectedEpisode]);

  const exportScript = useCallback(async (format: 'txt' | 'md') => {
    setBusy(true);
    setNotice('');
    try {
      const content = await client.script.export(projectId, format);
      if (typeof URL.createObjectURL === 'function') {
        const url = URL.createObjectURL(new Blob([content], { type: format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${(projectName ?? data?.plan.title ?? '短剧').replace(/[\\/:*?\"<>|]/g, '_')}.${format}`;
        anchor.click();
        URL.revokeObjectURL(url);
      }
      setNotice(`已导出 ${format.toUpperCase()}`);
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }, [client, data?.plan.title, onError, projectId, projectName]);

  return (
    <div className="script-workspace" data-project-id={projectId}>
      <header className="script-workspace-header"><div><span className="script-workspace-kicker">短剧制作台</span><h1>{projectName ?? data?.plan.title ?? '未命名短剧'}</h1></div><div className="script-workspace-summary"><span>{data?.plan.totalEpisodes ?? 0} 集</span><span>{data?.episodes.filter((item) => item.status === 'completed').length ?? 0} 已完成</span></div></header>
      <nav className="script-stage-tabs" role="tablist" aria-label="短剧制作阶段">
        {STAGES.map((item) => <button key={item.id} type="button" role="tab" aria-selected={stage === item.id} className={stage === item.id ? 'is-active' : ''} onClick={() => { setStage(item.id); setNotice(''); }}>{item.label}</button>)}
      </nav>
      {notice ? <div className="script-notice" role="status">{notice}</div> : null}
      {!data ? <div className="script-loading" role="status">正在加载短剧资料…</div> : null}
      {data && stage === 'plan' ? <PlanEditor value={data.plan} busy={busy} onChange={(plan) => setData({ ...data, plan })} onSave={() => void savePlan()} /> : null}
      {data && stage === 'outline' ? <OutlineEditor value={data.outline ?? emptyOutline(projectId)} busy={busy} onChange={(outline) => setData({ ...data, outline })} onSave={() => void saveOutline()} /> : null}
      {data && stage === 'characters' ? <CharacterEditor projectId={projectId} value={data.characters} busy={busy} onChange={(characters) => setData({ ...data, characters })} onSave={() => void saveCharacters()} /> : null}
      {data && stage === 'episodes' ? <EpisodeBatchPanel data={data} busy={busy} episode={selectedEpisode} episodeLoading={episodeLoading} onStart={(start, count) => void startEpisodeBatch(start, count)} onResume={(jobId) => void resumeJob(jobId)} onCancel={(jobId) => void cancelJob(jobId)} onOpenEpisode={(episodeNumber) => void openEpisode(episodeNumber)} onEpisodeChange={setSelectedEpisode} onSaveEpisode={() => void saveEpisode()} onExport={(format) => void exportScript(format)} /> : null}
      {data && stage === 'world' ? <WorldEditor value={data.world ?? emptyWorld(projectId)} busy={busy} onChange={(world) => setData({ ...data, world })} onSave={() => void saveWorld()} /> : null}
    </div>
  );
}

export default ScriptWorkspace;
