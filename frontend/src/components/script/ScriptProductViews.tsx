import { useEffect, useState } from 'react';
import type {
  ScriptAgentJobSnapshot,
  ScriptCharacter,
  ScriptEpisode,
  ScriptEpisodeSummary,
  ScriptPlan,
  ScriptSeriesOutline,
  ScriptWorldBible,
} from '../../types/index.js';

export type ScriptPrimaryStage = 'plan' | 'outline' | 'characters' | 'world' | 'episodes';

export type ScriptBatchState = 'blocked' | 'ready' | 'generating' | 'proofreading' | 'completed' | 'failed';

export interface ScriptBatchNavItem {
  startEpisode: number;
  endEpisode: number;
  status: ScriptBatchState;
  completedEpisodes: number;
  visibleChars: number;
}

const BATCH_STATE_LABEL: Record<ScriptBatchState, string> = {
  blocked: '未准备',
  ready: '待生成',
  generating: '生成中',
  proofreading: '待校稿',
  completed: '已完成',
  failed: '失败',
};

const EPISODE_STATUS_LABEL: Record<ScriptEpisodeSummary['status'], string> = {
  planned: '待生成',
  generating: '生成中',
  reviewing: '待校稿',
  completed: '已完成',
  failed: '失败',
};

export function buildScriptBatchNavigation(
  totalEpisodes: number,
  episodes: ScriptEpisodeSummary[],
  jobs: ScriptAgentJobSnapshot[],
  prerequisitesReady: boolean,
): ScriptBatchNavItem[] {
  const result: ScriptBatchNavItem[] = [];
  const safeTotal = Math.max(1, totalEpisodes);
  for (let startEpisode = 1; startEpisode <= safeTotal; startEpisode += 5) {
    const endEpisode = Math.min(startEpisode + 4, safeTotal);
    const summaries = episodes.filter((episode) => (
      episode.episodeNumber >= startEpisode && episode.episodeNumber <= endEpisode
    ));
    const completedEpisodes = summaries.filter((episode) => episode.status === 'completed').length;
    const expectedCount = endEpisode - startEpisode + 1;
    const matchingJobs = jobs.filter((job) => {
      if (job.task !== 'script_episode_batch') return false;
      const jobStart = job.scriptBatchOptions?.startEpisode ?? job.checkpoint?.episodeNumber;
      return typeof jobStart === 'number' && jobStart >= startEpisode && jobStart <= endEpisode;
    });
    const activeJob = matchingJobs.some((job) => ['queued', 'running', 'retrying'].includes(job.status));
    const failedJob = matchingJobs.some((job) => job.status === 'failed');
    const hasFailedEpisode = summaries.some((episode) => episode.status === 'failed');
    const needsProofreading = summaries.some((episode) => episode.status === 'reviewing');
    let status: ScriptBatchState = prerequisitesReady ? 'ready' : 'blocked';
    if (completedEpisodes === expectedCount) status = 'completed';
    else if (activeJob) status = 'generating';
    else if (needsProofreading) status = 'proofreading';
    else if (failedJob || hasFailedEpisode) status = 'failed';
    result.push({
      startEpisode,
      endEpisode,
      status,
      completedEpisodes,
      visibleChars: summaries.reduce((sum, episode) => sum + episode.visibleChars, 0),
    });
  }
  return result;
}

export function ScriptProductionSidebar({
  title,
  activeStage,
  activeBatchStart,
  totalEpisodes,
  completedEpisodes,
  totalVisibleChars,
  batches,
  onStageChange,
  onBatchChange,
}: {
  title: string;
  activeStage: ScriptPrimaryStage;
  activeBatchStart: number;
  totalEpisodes: number;
  completedEpisodes: number;
  totalVisibleChars: number;
  batches: ScriptBatchNavItem[];
  onStageChange: (stage: ScriptPrimaryStage) => void;
  onBatchChange: (startEpisode: number) => void;
}): JSX.Element {
  const stages: Array<{ id: Exclude<ScriptPrimaryStage, 'episodes'>; label: string; icon: string }> = [
    { id: 'plan', label: '剧本策划', icon: '✦' },
    { id: 'outline', label: '剧本大纲', icon: '☷' },
    { id: 'characters', label: '角色设定', icon: '♙' },
    { id: 'world', label: '世界设定', icon: '◎' },
  ];
  return (
    <aside className="script-product-sidebar" aria-label="短剧生产目录">
      <div className="script-product-sidebar__summary">
        <span>已完成：{completedEpisodes}集/{totalEpisodes}集</span>
        <strong>{totalVisibleChars.toLocaleString('zh-CN')} 字</strong>
      </div>
      <div className="script-product-sidebar__title">
        <span>剧本信息</span>
        <strong title={title}>{title}</strong>
      </div>
      <nav className="script-product-nav" role="tablist" aria-label="短剧制作阶段" aria-orientation="vertical">
        {stages.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={activeStage === item.id}
            className={activeStage === item.id ? 'is-active' : ''}
            onClick={() => onStageChange(item.id)}
          >
            <span aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
        <div className="script-product-nav__section">
          <span>正文生产</span>
          <button
            type="button"
            role="tab"
            aria-label="分批正文"
            aria-selected={activeStage === 'episodes'}
            className="script-product-nav__overview"
            onClick={() => onStageChange('episodes')}
          >
            <span aria-hidden="true">▤</span>
            <span>分批正文总览</span>
          </button>
        </div>
        <div className="script-product-batches">
          {batches.map((batch) => (
            <button
              key={batch.startEpisode}
              type="button"
              role="tab"
              aria-selected={activeStage === 'episodes' && activeBatchStart === batch.startEpisode}
              className={activeStage === 'episodes' && activeBatchStart === batch.startEpisode ? 'is-active' : ''}
              onClick={() => onBatchChange(batch.startEpisode)}
            >
              <span className="script-product-batch__label">{batch.startEpisode}–{batch.endEpisode}集剧本正文</span>
              <span className={`script-product-batch__state is-${batch.status}`}>{BATCH_STATE_LABEL[batch.status]}</span>
            </button>
          ))}
        </div>
      </nav>
    </aside>
  );
}

function EmptyText({ children = '等待补充' }: { children?: string }): JSX.Element {
  return <span className="script-read-empty">{children}</span>;
}

function TextValue({ value }: { value?: string }): JSX.Element {
  return value?.trim() ? <>{value}</> : <EmptyText />;
}

function TagList({ items }: { items: string[] }): JSX.Element {
  return items.length ? (
    <div className="script-read-tags">{items.map((item) => <span key={item}>{item}</span>)}</div>
  ) : <EmptyText />;
}

export function ScriptPlanReadView({ value }: { value: ScriptPlan }): JSX.Element {
  const market = value.market === 'domestic' ? '国内' : '海外';
  const channel = value.channel === 'female' ? '女频' : value.channel === 'male' ? '男频' : '通用';
  return (
    <div className="script-read-document script-plan-read-view">
      <section className="script-read-lead">
        <span className="script-read-eyebrow">AI 选题</span>
        <h3>{value.title || '未命名短剧'}</h3>
        <ol>
          <li><strong>频道：</strong>{channel}</li>
          <li><strong>题材：</strong>{value.genres.join('、') || '待确定'}</li>
          <li><strong>一句话：</strong><TextValue value={value.logline} /></li>
          <li><strong>受众：</strong><TextValue value={value.audience} /></li>
          <li><strong>内核：</strong><TextValue value={value.coreConflict} /></li>
          <li><strong>亮点：</strong>{value.highlights.join('；') || '待补充'}</li>
        </ol>
      </section>
      <section>
        <span className="script-read-eyebrow">剧本策划</span>
        <div className="script-read-facts">
          <article><span>主题</span><p><TextValue value={value.theme} /></p></article>
          <article><span>市场 / 频道</span><p>{market} · {channel}</p></article>
          <article><span>规模</span><p>{value.totalEpisodes} 集 · {value.episodeDurationSeconds.min}–{value.episodeDurationSeconds.max} 秒/集</p></article>
          <article><span>创作规格</span><p>{value.targetCharsPerEpisode} 字/集 · 最多 {value.maxScenesPerEpisode} 场 · 对白 {value.dialogueDensityPercent}%</p></article>
          <article className="is-wide"><span>核心要求</span><p><TextValue value={value.coreRequirements} /></p></article>
          <article className="is-wide"><span>结局方向</span><p><TextValue value={value.endingDirection} /></p></article>
        </div>
        <div className="script-read-tag-row"><strong>题材标签</strong><TagList items={value.genres} /></div>
      </section>
      <section className="script-cover-brief">
        <div className="script-cover-brief__preview" aria-label="9比16竖版封面占位">
          <span>9:16 竖版</span>
          <strong>{value.title || '短剧封面'}</strong>
        </div>
        <div>
          <span className="script-read-eyebrow">剧本封面</span>
          <h4>视觉生成提示词</h4>
          <p><TextValue value={value.coverPrompt} /></p>
          <small>这里保存的是可复用的封面创作要求，不会用假图片冒充生成结果。</small>
        </div>
      </section>
    </div>
  );
}

export function ScriptOutlineReadView({ value }: { value: ScriptSeriesOutline }): JSX.Element {
  return (
    <div className="script-read-document">
      <section className="script-outline-prose">
        <span className="script-read-eyebrow">全剧故事</span>
        <h3>剧本大纲</h3>
        <p><TextValue value={value.synopsis} /></p>
      </section>
      <section className="script-outline-milestones" aria-label="故事里程碑">
        {[
          ['开局状态', value.openingState],
          ['中点转折', value.midpointTurn],
          ['高潮', value.climax],
          ['结局状态', value.endingState],
        ].map(([label, content]) => <article key={label}><span>{label}</span><p><TextValue value={content} /></p></article>)}
      </section>
      <section className="script-outline-arcs">
        <div><h4>主线节拍</h4>{value.mainArc.length ? <ol>{value.mainArc.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ol> : <EmptyText />}</div>
        <div><h4>支线</h4>{value.subplotArcs.length ? <ul>{value.subplotArcs.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <EmptyText />}</div>
      </section>
      <section className="script-outline-read-cards">
        <h4>分集卡 <span>{value.episodeCards.length} 集</span></h4>
        {value.episodeCards.length ? value.episodeCards.map((card) => (
          <article key={card.episodeNumber}>
            <span>第 {card.episodeNumber} 集</span>
            <div><strong>{card.title || '未命名'}</strong><p>{card.logline}</p></div>
            <div className="script-outline-card__beats"><span>主要事件：{card.mainEvent || '待补充'}</span><span>结尾卡点：{card.endingHook || '待补充'}</span></div>
          </article>
        )) : <EmptyText>Agent 生成大纲后，将在这里显示连续分集卡</EmptyText>}
      </section>
    </div>
  );
}

const CHARACTER_ROLE_LABEL: Record<ScriptCharacter['role'], string> = {
  lead: '主角', supporting: '配角', antagonist: '反派', minor: '次要角色',
};

export function ScriptCharactersReadView({ value }: { value: ScriptCharacter[] }): JSX.Element {
  const [selectedId, setSelectedId] = useState(value[0]?.id ?? '');
  useEffect(() => {
    if (!value.some((item) => item.id === selectedId)) setSelectedId(value[0]?.id ?? '');
  }, [selectedId, value]);
  const character = value.find((item) => item.id === selectedId) ?? value[0];
  if (!character) return <div className="script-read-document"><EmptyText>尚无角色，可让 Agent 补全人物与世界圣经</EmptyText></div>;
  const initials = character.name.trim().slice(0, 2) || '角色';
  return (
    <div className="script-character-read">
      <div className="script-character-tabs" role="tablist" aria-label="角色列表">
        {value.map((item) => <button key={item.id} type="button" role="tab" aria-selected={item.id === character.id} className={item.id === character.id ? 'is-active' : ''} onClick={() => setSelectedId(item.id)}>{item.name || '未命名角色'}</button>)}
      </div>
      <article className="script-character-profile">
        <div className="script-character-portrait" aria-label={`${character.name}人物肖像占位`}><span>{initials}</span><small>人物肖像</small></div>
        <div className="script-character-profile__body">
          <header><div><span>{CHARACTER_ROLE_LABEL[character.role]}</span><h3>{character.name}</h3></div><p>{[character.age ? `${character.age}岁` : '', character.occupation].filter(Boolean).join(' · ') || '身份待补充'}</p></header>
          <section><h4>剧本人设</h4><p><TextValue value={character.biography || character.identity} /></p></section>
          <div className="script-character-traits">
            {[
              ['相貌', character.appearance], ['发型', character.hairstyle], ['体格', character.physique],
              ['服装', character.defaultOutfit], ['目标', character.goal], ['动机', character.motivation],
              ['弱点', character.weakness], ['人物弧光', character.arc], ['口吻', character.speechStyle],
            ].map(([label, content]) => <section key={label}><h4>{label}</h4><p><TextValue value={content} /></p></section>)}
          </div>
          <div className="script-read-tag-row"><strong>性格</strong><TagList items={character.personality} /></div>
          <div className="script-read-tag-row"><strong>特技</strong><TagList items={character.skills} /></div>
        </div>
      </article>
    </div>
  );
}

export function ScriptWorldReadView({ value }: { value: ScriptWorldBible }): JSX.Element {
  const sections: Array<{ icon: string; label: string; content?: string; items?: string[] }> = [
    { icon: '◷', label: '时间', content: value.era },
    { icon: '●', label: '地点', items: value.primaryLocations },
    { icon: '▥', label: '世界状态', content: value.worldState },
    { icon: '★', label: '世界法则', items: value.rules },
    { icon: '◆', label: '交通手段', items: value.transport },
    { icon: '◈', label: '通信手段', items: value.communication },
    { icon: '♜', label: '组织势力', items: value.organizations },
    { icon: '◇', label: '重复道具', items: value.recurringProps },
    { icon: '!', label: '禁止的时代错位', items: value.forbiddenAnachronisms },
  ];
  return (
    <div className="script-read-document script-world-read">
      <span className="script-read-eyebrow">拍摄世界圣经</span>
      <h3>世界设定</h3>
      {sections.map((section) => (
        <section key={section.label}>
          <h4><span aria-hidden="true">{section.icon}</span>{section.label}</h4>
          {section.content ? <p>{section.content}</p> : section.items?.length ? <p>{section.items.join('；')}</p> : <EmptyText />}
        </section>
      ))}
    </div>
  );
}

const TIME_LABEL: Record<ScriptEpisode['scenes'][number]['timeOfDay'], string> = {
  day: '日', night: '夜', dawn: '晨', dusk: '黄昏',
};

const PLACE_LABEL: Record<ScriptEpisode['scenes'][number]['interiorExterior'], string> = {
  interior: '内', exterior: '外',
};

function sceneCharacterNames(
  scene: ScriptEpisode['scenes'][number],
  charactersById: Map<string, ScriptCharacter>,
  introducedCharacterIds: Set<string>,
): string[] {
  const explicitCharacterNames = new Set(
    scene.characterIds.map((id) => charactersById.get(id)?.name).filter((name): name is string => Boolean(name)),
  );
  const explicit = scene.characterIds.map((id) => {
    const character = charactersById.get(id);
    if (!character) return undefined;
    if (introducedCharacterIds.has(id)) return character.name;
    introducedCharacterIds.add(id);
    const identity = character.identity?.trim() ?? '';
    return identity ? `${character.name}（${identity}）` : character.name;
  }).filter((name): name is string => Boolean(name));
  const speakers = scene.blocks
    .filter((block): block is Extract<typeof block, { type: 'dialogue' }> => block.type === 'dialogue')
    .map((block) => block.speaker)
    .filter((name) => Boolean(name) && !explicitCharacterNames.has(name));
  return [...new Set([...explicit, ...speakers])];
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function renderActionText(text: string, characterNames: readonly string[]): Array<string | JSX.Element> {
  const characterNameSet = new Set(characterNames);
  const tokens = [
    '【[^】]+】',
    ...characterNames.filter(Boolean).sort((left, right) => right.length - left.length).map(escapedRegExp),
  ];
  const matcher = new RegExp(`(${tokens.join('|')})`, 'gu');
  return text.split(matcher).filter(Boolean).map((part, index) => (
    /^【[^】]+】$/u.test(part) || characterNameSet.has(part)
      ? <strong key={`${index}-${part}`}>{part}</strong>
      : part
  ));
}

export function ScriptEpisodeReader({
  episodes,
  summaries,
  characters,
  batchStart,
  batchEnd,
  loading,
  onEditEpisode,
}: {
  episodes: ScriptEpisode[];
  summaries: ScriptEpisodeSummary[];
  characters: ScriptCharacter[];
  batchStart: number;
  batchEnd: number;
  loading: boolean;
  onEditEpisode: (episodeNumber: number) => void;
}): JSX.Element {
  const charactersById = new Map(characters.map((character) => [character.id, character]));
  const characterNames = characters.map((character) => character.name);
  const introducedCharacterIds = new Set<string>();
  const ordered = [...episodes].sort((left, right) => left.episodeNumber - right.episodeNumber);
  const visibleChars = summaries
    .filter((item) => item.episodeNumber >= batchStart && item.episodeNumber <= batchEnd)
    .reduce((sum, item) => sum + item.visibleChars, 0);
  return (
    <section className="script-reader" aria-label={`第 ${batchStart} 至 ${batchEnd} 集剧本正文`}>
      <header className="script-reader__heading">
        <div><span>短剧成品阅读</span><h3>{batchStart}–{batchEnd}集剧本正文</h3></div>
        <p>{ordered.length}/{batchEnd - batchStart + 1} 集 · {visibleChars.toLocaleString('zh-CN')} 字</p>
      </header>
      <div className="script-proofread-notice">AI 也可能会走神，请注意校稿。</div>
      {loading ? <div className="script-loading script-loading--compact" role="status">正在装订本批剧本…</div> : null}
      {!loading && ordered.length === 0 ? <div className="script-reader-empty"><strong>本批正文尚未生成</strong><span>完成策划、大纲和人物世界设定后，即可开始五集一批的剧本生产。</span></div> : null}
      {ordered.map((episode) => (
        <article className="script-reader-episode" key={episode.id} id={`script-episode-${episode.episodeNumber}`}>
          <header><div><span>第 {episode.episodeNumber} 集</span><h4>{episode.title}</h4></div><button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" onClick={() => onEditEpisode(episode.episodeNumber)}>编辑本集</button></header>
          {[...episode.scenes].sort((left, right) => left.ordinal - right.ordinal).map((scene) => {
            const names = sceneCharacterNames(scene, charactersById, introducedCharacterIds);
            return (
              <section className="script-reader-scene" key={scene.id}>
                <h5>{episode.episodeNumber}-{scene.ordinal} {TIME_LABEL[scene.timeOfDay]} {PLACE_LABEL[scene.interiorExterior]} {scene.location}</h5>
                {names.length ? <p className="script-reader-characters"><strong>人物：</strong>{names.join(' ')}</p> : null}
                <div className="script-reader-blocks">
                  {scene.blocks.map((block) => {
                    if (block.type === 'caption') {
                      const caption = block.text
                        .replace(/^【|】$/g, '')
                        .replace(/^字幕\s*[：:]\s*/, '');
                      return <p className="is-caption" key={block.id}>{/^(?:闪回|闪回结束|闪出)$/u.test(caption) ? `【${caption}】` : `【字幕：${caption}】`}</p>;
                    }
                    if (block.type === 'action') {
                      const action = block.text.replace(/^△/, '');
                      return <p className="is-action" key={block.id}>△{renderActionText(action, characterNames)}</p>;
                    }
                    const mode = block.mode === 'os' || block.mode === 'vo' ? block.mode.toUpperCase() : '';
                    const delivery = block.delivery?.trim();
                    return <p className="is-dialogue" key={block.id}><strong>{block.speaker}{mode || (delivery ? `（${delivery}）` : '')}：</strong>{block.text}</p>;
                  })}
                </div>
              </section>
            );
          })}
          <footer><span className={`script-reader-status is-${episode.status}`}>{EPISODE_STATUS_LABEL[episode.status]}</span><span>版本 {episode.revision}</span></footer>
        </article>
      ))}
    </section>
  );
}
