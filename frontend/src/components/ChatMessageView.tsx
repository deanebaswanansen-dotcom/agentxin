/**
 * 对话流单条消息渲染。
 *
 * 支持：text / agent-progress / agent-result / chapter-preview / plan-turn
 */
import { useMemo, useState } from 'react';
import type {
  AgentArtifact,
  AgentRunMetrics,
  AgentTask,
  NovelPlanAnswer,
  NovelPlanQuestion,
  NovelPlanSummary,
  ReferenceTransferDimension,
} from '../types/index.js';
import { REFERENCE_TRANSFER_DIMENSIONS } from '../types/index.js';
import agentThinkingAnimation from '../assets/lottie/agent-thinking.json';
import taskCompleteAnimation from '../assets/lottie/task-complete.json';
import type {
  ChatMessage,
  PlanTurnMessage,
  ReferenceImportMessage,
  ReferenceResultMessage,
} from './chat/types.js';
import type { ReferenceAnalysisDepth } from '../types/index.js';
import { Icon } from './Icon.js';
import { LottieMotion } from './LottieMotion.js';
import './components.css';

const REFERENCE_DIMENSION_LABELS: Record<ReferenceTransferDimension, string> = {
  pacing: '剧情节奏',
  chapter_structure: '章节结构',
  characterization: '人物塑造',
  suspense: '悬念设计',
  dialogue_density: '对话密度',
  description_density: '描写密度',
  emotion_curve: '情绪曲线',
  payoff_frequency: '爽点频率',
  worldbuilding_delivery: '世界观展示',
  style: '文风参数',
};

const ARTIFACT_LABELS: Record<AgentArtifact['kind'], string> = {
  project: '项目',
  world: '世界观',
  character: '人物',
  outline: '大纲',
  chapter: '章节',
};

function formatNumber(value: number | undefined): string {
  return (value ?? 0).toLocaleString();
}

function renderMetrics(metrics: AgentRunMetrics): JSX.Element {
  return (
    <div className="nwa-cache-stats" aria-label="运行指标">
      {metrics.plannedWords !== undefined ? (
        <div><span>{formatNumber(metrics.plannedWords)}</span><small>计划字数</small></div>
      ) : null}
      {metrics.completedChapters !== undefined ? (
        <div><span>{formatNumber(metrics.completedChapters)}</span><small>完成章节</small></div>
      ) : null}
      <div><span>{formatNumber(metrics.modelCalls)}</span><small>模型调用</small></div>
      <div><span>{formatNumber(metrics.promptTokens)}</span><small>输入 token</small></div>
      <div><span>{formatNumber(metrics.completionTokens)}</span><small>输出 token</small></div>
      <div><span>{formatNumber(metrics.cacheHitTokens)}</span><small>命中 token</small></div>
      <div><span>{metrics.cacheHitRatePct}%</span><small>命中率</small></div>
      <div><span>{formatNumber(metrics.localCacheHits)}</span><small>本地命中</small></div>
      {metrics.estimatedCostUsd !== undefined ? (
        <div><span>${metrics.estimatedCostUsd.toFixed(6)}</span><small>估算成本</small></div>
      ) : null}
    </div>
  );
}

export interface ChatMessageViewProps {
  message: ChatMessage;
  /** 当前是否处于流式生成（用于禁用按钮）。 */
  streaming: boolean;
  /** 采用章节预览消息。 */
  onAdoptPreview?: (messageId: string) => void;
  /** 点击 Agent artifact（跳转到资料/章节）。 */
  onJumpToArtifact?: (artifact: AgentArtifact) => void;
  /** 点击结果中的"打开章节"（加载到抽屉）。 */
  onOpenChapter?: (chapterId: string) => void;
  /** 计划模式：提交本轮结构化回答。 */
  onPlanSubmit?: (messageId: string, answers: NovelPlanAnswer[], forceReady: boolean) => void;
  /** 计划模式：用 brief 启动生成（携带规模参数 + 完整 planSummary 以便后端采纳）。 */
  onPlanGenerate?: (
    messageId: string,
    brief: string,
    scale?: { chapters?: number; targetWords?: number; totalWords?: number },
    planSummary?: NovelPlanSummary,
    taskOverride?: AgentTask,
  ) => void;
  /** 参考分析：将选中维度迁移到当前项目。 */
  onReferenceTransfer?: (
    messageId: string,
    referenceId: string,
    dimensions: ReferenceTransferDimension[],
  ) => void;
  /** 参考导入：对勾选章节启动分析。 */
  onReferenceAnalyze?: (
    messageId: string,
    referenceId: string,
    chapterIds: string[],
    depth: ReferenceAnalysisDepth,
  ) => void;
}

function PlanTurnCard({
  message,
  streaming,
  onPlanSubmit,
  onPlanGenerate,
}: {
  message: PlanTurnMessage;
  streaming: boolean;
  onPlanSubmit?: (messageId: string, answers: NovelPlanAnswer[], forceReady: boolean) => void;
  onPlanGenerate?: (
    messageId: string,
    brief: string,
    scale?: { chapters?: number; targetWords?: number; totalWords?: number },
    planSummary?: NovelPlanSummary,
    taskOverride?: AgentTask,
  ) => void;
}): JSX.Element {
  const questions = message.questions ?? [];
  const [selected, setSelected] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    for (const q of questions) init[q.id] = [];
    return init;
  });
  const [custom, setCustom] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const q of questions) init[q.id] = '';
    return init;
  });

  const canSubmit = useMemo(() => {
    if (message.resolved || message.status !== 'asking' || streaming) return false;
    return questions.length > 0 && questions.every((q) => (
      (selected[q.id]?.length ?? 0) > 0 || (custom[q.id]?.trim().length ?? 0) > 0
    ));
  }, [custom, message.resolved, message.status, questions, selected, streaming]);

  const toggle = (q: NovelPlanQuestion, optionId: string) => {
    if (message.resolved || streaming) return;
    setSelected((prev) => {
      const cur = new Set(prev[q.id] ?? []);
      if (q.multiSelect) {
        if (cur.has(optionId)) cur.delete(optionId);
        else cur.add(optionId);
      } else {
        cur.clear();
        cur.add(optionId);
      }
      return { ...prev, [q.id]: Array.from(cur) };
    });
  };

  const buildAnswers = (): NovelPlanAnswer[] =>
    questions.map((q) => ({
      questionId: q.id,
      selectedOptionIds: selected[q.id] ?? [],
      selectedOptionLabels: (selected[q.id] ?? [])
        .map((optionId) => q.options.find((option) => option.id === optionId)?.label)
        .filter((label): label is string => Boolean(label)),
      customText: custom[q.id]?.trim() || undefined,
    }));

  return (
    <div className="nwa-chat__msg nwa-chat__msg--assistant nwa-chat__msg--plan" aria-label="计划模式追问">
      <span className="nwa-chat__role">
        <Icon name="brain" /> Agent 策划
        {message.round > 0 ? ` · 第 ${message.round} 次决策` : ''}
      </span>
      <div className="nwa-chat__content nwa-plan-chat__message">{message.message}</div>
      {message.planningChecklist ? (
        <details className="nwa-plan-chat__brief-details nwa-plan-chat__checklist">
          <summary>Agent 自检清单</summary>
          <dl className="nwa-plan-chat__summary">
            <dt>已确认</dt>
            <dd>{message.planningChecklist.confirmedFacts.join('；') || '暂无'}</dd>
            <dt>待决策</dt>
            <dd>{message.planningChecklist.unresolvedDecisions.join('；') || '暂无'}</dd>
            <dt>可自行决定</dt>
            <dd>{message.planningChecklist.safeDefaults.join('；') || '暂无'}</dd>
            <dt>硬约束</dt>
            <dd>{message.planningChecklist.hardConstraints.join('；') || '暂无'}</dd>
          </dl>
        </details>
      ) : null}

      {message.status === 'asking' && questions.length > 0 ? (
        <div className="nwa-plan-chat__questions">
          {questions.map((question) => (
            <fieldset key={question.id} className="nwa-plan-chat__question" disabled={message.resolved || streaming}>
              <legend>
                {question.question}
                {question.multiSelect ? <em>可多选</em> : null}
              </legend>
              <div className="nwa-plan-chat__options" role="group">
                {question.options.map((option) => {
                  const isOn = (selected[question.id] ?? []).includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={`nwa-plan-chat__option${isOn ? ' nwa-plan-chat__option--selected' : ''}`}
                      aria-pressed={isOn}
                      disabled={message.resolved || streaming}
                      onClick={() => toggle(question, option.id)}
                    >
                      <strong>{option.label}</strong>
                      {option.description ? <small>{option.description}</small> : null}
                    </button>
                  );
                })}
              </div>
              <label className="nwa-plan-chat__custom">
                <span>其他 / 补充</span>
                <input
                  type="text"
                  value={custom[question.id] ?? ''}
                  disabled={message.resolved || streaming}
                  placeholder="不选上面的也可以直接写"
                  onChange={(e) => setCustom((prev) => ({ ...prev, [question.id]: e.target.value }))}
                />
              </label>
            </fieldset>
          ))}
          <div className="nwa-plan-chat__actions">
            <button
              type="button"
              className="nwa-button"
              disabled={!canSubmit}
              onClick={() => onPlanSubmit?.(message.id, buildAnswers(), false)}
            >
              回答全部问题，继续策划
            </button>
            <button
              type="button"
              className="nwa-button nwa-button--ghost"
              disabled={message.resolved || streaming}
              onClick={() => onPlanSubmit?.(message.id, buildAnswers(), true)}
            >
              跳过未答项，直接出方案
            </button>
          </div>
        </div>
      ) : null}

      {message.status === 'ready' ? (
        <div className="nwa-plan-chat__ready">
          {message.planSummary ? (
            <dl className="nwa-plan-chat__summary">
              {message.planSummary.title ? (
                <>
                  <dt>书名向</dt>
                  <dd>{message.planSummary.title}</dd>
                </>
              ) : null}
              {message.planSummary.genre ? (
                <>
                  <dt>赛道</dt>
                  <dd>{message.planSummary.genre}</dd>
                </>
              ) : null}
              {message.planSummary.protagonist ? (
                <>
                  <dt>主角</dt>
                  <dd>{message.planSummary.protagonist}</dd>
                </>
              ) : null}
              {message.planSummary.hook ? (
                <>
                  <dt>钩子</dt>
                  <dd>{message.planSummary.hook}</dd>
                </>
              ) : null}
              {message.planSummary.tone ? (
                <>
                  <dt>基调</dt>
                  <dd>{message.planSummary.tone}</dd>
                </>
              ) : null}
              {message.planSummary.totalWords ||
              message.planSummary.wordsPerChapter ||
              message.planSummary.chapterCount ||
              message.planSummary.volumeCount ? (
                <>
                  <dt>规模</dt>
                  <dd>
                    {message.planSummary.chapterCount
                      ? `${message.planSummary.chapterCount} 章`
                      : '—'}
                    {message.planSummary.volumeCount
                      ? ` · ${message.planSummary.volumeCount} 卷`
                      : ''}
                    {' · '}
                    每章约{' '}
                    {(message.planSummary.wordsPerChapter ?? 0).toLocaleString() || '—'} 字
                    {' · '}
                    全书约 {(message.planSummary.totalWords ?? 0).toLocaleString() || '—'} 字
                  </dd>
                </>
              ) : null}
              {message.planSummary.constraints && message.planSummary.constraints.length > 0 ? (
                <>
                  <dt>禁忌</dt>
                  <dd>{message.planSummary.constraints.join('；')}</dd>
                </>
              ) : null}
              {message.planSummary.genres?.length ? (
                <>
                  <dt>类型组合</dt>
                  <dd>{message.planSummary.genres.join(' + ')}</dd>
                </>
              ) : null}
              {message.planSummary.endingDirection || message.planSummary.writingRequirements ? (
                <>
                  {message.planSummary.endingDirection ? (
                    <><dt>结局方向</dt><dd>{message.planSummary.endingDirection}</dd></>
                  ) : null}
                  {message.planSummary.writingRequirements ? (
                    <><dt>额外要求</dt><dd>{message.planSummary.writingRequirements}</dd></>
                  ) : null}
                </>
              ) : null}
            </dl>
          ) : null}
          {message.planSummary?.storyPlan ? (
            <details className="nwa-plan-chat__brief-details" open>
              <summary>结构化 Story Plan</summary>
              <dl className="nwa-plan-chat__summary">
                <dt>一句话前提</dt>
                <dd>{message.planSummary.storyPlan.premise.oneSentence}</dd>
                <dt>核心冲突</dt>
                <dd>{message.planSummary.storyPlan.premise.coreConflict}</dd>
                <dt>主角弧光</dt>
                <dd>
                  {message.planSummary.storyPlan.protagonist.identity}；目标：
                  {message.planSummary.storyPlan.protagonist.goal}；成长：
                  {message.planSummary.storyPlan.protagonist.growthArc}
                </dd>
                <dt>世界</dt>
                <dd>{message.planSummary.storyPlan.world.overview}</dd>
                <dt>主线四段</dt>
                <dd>
                  开端：{message.planSummary.storyPlan.mainPlot.beginning}；发展：
                  {message.planSummary.storyPlan.mainPlot.development}；高潮：
                  {message.planSummary.storyPlan.mainPlot.climax}；结局：
                  {message.planSummary.storyPlan.mainPlot.ending}
                </dd>
                {message.planSummary.storyPlan.powerSystem.rules.length > 0 ? (
                  <>
                    <dt>力量规则</dt>
                    <dd>{message.planSummary.storyPlan.powerSystem.rules.join('；')}</dd>
                  </>
                ) : null}
                {message.planSummary.storyPlan.foreshadowing.length > 0 ? (
                  <>
                    <dt>伏笔</dt>
                    <dd>{message.planSummary.storyPlan.foreshadowing.join('；')}</dd>
                  </>
                ) : null}
                {message.planSummary.storyPlan.volumes.length > 0 ? (
                  <>
                    <dt>分卷与阶段</dt>
                    <dd>
                      {message.planSummary.storyPlan.volumes.map((volume) => (
                        <div key={volume.number}>
                          第{volume.number}卷《{volume.title}》：第{volume.chapterStart}-{volume.chapterEnd}章；{volume.goal}
                          {volume.stages?.length ? (
                            <ul>
                              {volume.stages.map((stage) => (
                                <li key={`${volume.number}-${stage.title}`}>{stage.title}（{stage.chapterStart}-{stage.chapterEnd}章）：{stage.goal}</li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      ))}
                    </dd>
                  </>
                ) : null}
              </dl>
            </details>
          ) : null}
          {message.planSummary?.chapterOutlines && message.planSummary.chapterOutlines.length > 0 ? (
            <div className="nwa-plan-chat__chapters" aria-label="分章大纲">
              <strong className="nwa-plan-chat__chapters-title">分章大纲（Agent 生成）</strong>
              {message.planSummary.chapterCount && message.planSummary.plannedThroughChapter &&
              message.planSummary.plannedThroughChapter < message.planSummary.chapterCount ? (
                <p className="nwa-muted">
                  当前展开第 1-{message.planSummary.plannedThroughChapter} 章 / 全文 {message.planSummary.chapterCount} 章，后续按阶段滚动规划。
                </p>
              ) : null}
              <ol className="nwa-plan-chat__chapter-list">
                {message.planSummary.chapterOutlines.map((ch) => (
                  <li key={ch.number}>
                    <strong>
                      第{ch.number}章 {ch.title}
                    </strong>
                    {ch.estimatedWords ? (
                      <span className="nwa-plan-chat__chapter-words">
                        约 {ch.estimatedWords.toLocaleString()} 字
                      </span>
                    ) : null}
                    <p>{ch.goal}</p>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {message.brief ? (
            <details className="nwa-plan-chat__brief-details">
              <summary>完整 brief（生成时会带上）</summary>
              <pre className="nwa-plan-chat__brief" aria-label="生成用 brief">
                {message.brief}
              </pre>
            </details>
          ) : null}
          <div className="nwa-plan-chat__actions">
            {message.generated ? (
              <span className="nwa-muted"><Icon name="check" /> 已用该方案启动生成</span>
            ) : (
              (() => {
                const scale = {
                  chapters: message.planSummary?.chapterCount,
                  targetWords: message.planSummary?.wordsPerChapter,
                  totalWords: message.planSummary?.totalWords,
                };
                const multiChapter = (message.planSummary?.chapterCount ?? 0) > 1;
                if (!multiChapter) {
                  return (
                    <button
                      type="button"
                      className="nwa-button"
                      disabled={streaming || !message.brief?.trim()}
                      onClick={() =>
                        onPlanGenerate?.(
                          message.id,
                          message.brief ?? '',
                          scale,
                          message.planSummary,
                        )
                      }
                    >
                      用方案按章生成
                    </button>
                  );
                }
                return (
                  <>
                    <button
                      type="button"
                      className="nwa-button"
                      disabled={streaming || !message.brief?.trim()}
                      onClick={() =>
                        onPlanGenerate?.(
                          message.id,
                          message.brief ?? '',
                          scale,
                          message.planSummary,
                          'long_novel',
                        )
                      }
                    >
                      长篇模式生成
                    </button>
                    <button
                      type="button"
                      className="nwa-button nwa-button--ghost"
                      disabled={streaming || !message.brief?.trim()}
                      onClick={() =>
                        onPlanGenerate?.(
                          message.id,
                          message.brief ?? '',
                          scale,
                          message.planSummary,
                          'full_novel',
                        )
                      }
                    >
                      快速整本
                    </button>
                  </>
                );
              })()
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const MAX_SELECT = 80;

function ReferenceImportCard({
  message,
  streaming,
  onReferenceAnalyze,
}: {
  message: ReferenceImportMessage;
  streaming: boolean;
  onReferenceAnalyze?: (
    messageId: string,
    referenceId: string,
    chapterIds: string[],
    depth: ReferenceAnalysisDepth,
  ) => void;
}): JSX.Element {
  const chapters = message.chapters;
  const [depth, setDepth] = useState<ReferenceAnalysisDepth>(message.depth ?? 'standard');
  // 默认：全选（不超过上限）
  const [selected, setSelected] = useState<string[]>(() =>
    chapters.slice(0, MAX_SELECT).map((c) => c.id),
  );

  const toggle = (id: string): void => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_SELECT) return prev;
      return [...prev, id];
    });
  };

  const selectAll = (): void => {
    setSelected(chapters.slice(0, MAX_SELECT).map((c) => c.id));
  };
  const selectNone = (): void => setSelected([]);
  const selectFirst = (n: number): void => {
    setSelected(chapters.slice(0, Math.min(n, MAX_SELECT)).map((c) => c.id));
  };
  const selectRange = (from: number, to: number): void => {
    setSelected(
      chapters
        .filter((c) => c.number >= from && c.number <= to)
        .slice(0, MAX_SELECT)
        .map((c) => c.id),
    );
  };

  const disabled = streaming || message.resolved === true;
  const selectedWords = chapters
    .filter((c) => selected.includes(c.id))
    .reduce((s, c) => s + c.wordCount, 0);

  return (
    <div className="nwa-chat__msg nwa-chat__msg--assistant nwa-plan-chat nwa-ref-import">
      <span className="nwa-chat__role">
        <Icon name="bookOpen" /> 参考书已导入 · 选择分析范围
      </span>
      <div className="nwa-chat__content">
        <p>{message.message}</p>
        <p className="nwa-muted">
          《{message.reference.title}》共 {chapters.length} 章 · 已选{' '}
          <strong>{selected.length}</strong> 章 · 约 {selectedWords.toLocaleString()} 字
          （最多 {MAX_SELECT} 章）
        </p>

        <div className="nwa-ref-import__toolbar">
          <label className="nwa-ref-import__depth">
            深度
            <select
              className="nwa-select"
              value={depth}
              disabled={disabled}
              onChange={(e) => setDepth(e.target.value as ReferenceAnalysisDepth)}
            >
              <option value="quick">快速（模型约 12 章）</option>
              <option value="standard">标准（模型约 30 章）</option>
              <option value="deep">深度（模型约 60 章）</option>
            </select>
          </label>
          <div className="nwa-ref-import__presets">
            <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={disabled} onClick={selectAll}>
              全书
            </button>
            <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={disabled} onClick={() => selectFirst(10)}>
              前 10 章
            </button>
            <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={disabled} onClick={() => selectFirst(30)}>
              前 30 章
            </button>
            <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={disabled} onClick={() => selectFirst(60)}>
              前 60 章
            </button>
            <button
              type="button"
              className="nwa-button nwa-button--ghost nwa-button--sm"
              disabled={disabled || chapters.length < 11}
              onClick={() => selectRange(Math.max(1, chapters.length - 9), chapters.length)}
            >
              末 10 章
            </button>
            <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={disabled} onClick={selectNone}>
              清空
            </button>
          </div>
        </div>

        <div className="nwa-ref-import__list" role="group" aria-label="章节列表">
          {chapters.map((ch) => {
            const checked = selected.includes(ch.id);
            return (
              <label
                key={ch.id}
                className={`nwa-ref-import__row${checked ? ' nwa-ref-import__row--on' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled || (!checked && selected.length >= MAX_SELECT)}
                  onChange={() => toggle(ch.id)}
                />
                <span className="nwa-ref-import__num">第{ch.number}章</span>
                <span className="nwa-ref-import__title">{ch.title}</span>
                <span className="nwa-ref-import__words">{ch.wordCount.toLocaleString()} 字</span>
              </label>
            );
          })}
        </div>

        <div className="nwa-plan-chat__actions">
          {message.resolved ? (
            <span className="nwa-muted"><Icon name="check" /> 已提交分析</span>
          ) : (
            <button
              type="button"
              className="nwa-button"
              disabled={disabled || selected.length === 0}
              onClick={() =>
                onReferenceAnalyze?.(message.id, message.reference.id, selected, depth)
              }
            >
              分析选中的 {selected.length} 章
            </button>
          )}
        </div>
        <p className="nwa-muted" style={{ marginTop: '0.45rem' }}>
          本地会统计你勾选的全部章节；模型综合按深度抽样（最多约 60 章），不把原文写入原创项目。
        </p>
      </div>
    </div>
  );
}

function ReferenceResultCard({
  message,
  streaming,
  onReferenceTransfer,
}: {
  message: ReferenceResultMessage;
  streaming: boolean;
  onReferenceTransfer?: (
    messageId: string,
    referenceId: string,
    dimensions: ReferenceTransferDimension[],
  ) => void;
}): JSX.Element {
  const available = new Set(
    message.profile.transferableMethods.map((m) => m.dimension),
  );
  const defaults = REFERENCE_TRANSFER_DIMENSIONS.filter((d) => available.has(d)).slice(0, 5);
  const [selected, setSelected] = useState<ReferenceTransferDimension[]>(defaults);
  const characters = message.profile.characters ?? [];
  const relationships = message.profile.relationships ?? [];
  const conflicts = message.profile.conflicts ?? [];
  const payoffs = message.profile.payoffs ?? [];
  const outline = message.profile.plotOutline ?? [];
  const foreshadowing = message.profile.foreshadowing ?? [];
  const reversals = message.profile.reversals ?? [];
  const themes = message.profile.themes ?? [];
  const chapterOutfits = message.profile.chapterCharacterOutfits ?? [];
  const world = message.profile.worldbuilding;

  const toggle = (d: ReferenceTransferDimension): void => {
    setSelected((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  };

  return (
    <div className="nwa-chat__msg nwa-chat__msg--assistant nwa-plan-chat">
      <span className="nwa-chat__role"><Icon name="bookOpen" /> 小说内容拆解</span>
      <div className="nwa-chat__content">
        <p>{message.message}</p>
        <dl className="nwa-plan-chat__summary">
          <dt>作品</dt>
          <dd>{message.reference.title}</dd>
          <dt>一句话</dt>
          <dd>{message.profile.oneLineSummary}</dd>
          <dt>类型</dt>
          <dd>{message.profile.genreGuess}</dd>
          <dt>核心冲突</dt>
          <dd>{message.profile.coreConflict}</dd>
          <dt>节奏</dt>
          <dd>
            {message.profile.pacing.notes[0] ?? message.profile.style.rhythmLabel}
            （对话比 {message.profile.style.dialogueRatio}）
          </dd>
        </dl>
        <div className="nwa-reference-breakdown">
          <section>
            <h4>人物</h4>
            {characters.length > 0 ? (
              <div className="nwa-reference-breakdown__grid">
                {characters.map((character, index) => (
                  <article key={`${character.name}-${index}`}>
                    <strong>{character.name}</strong>
                    <span>{character.role}</span>
                    <p>{character.identity || '身份未确认'}</p>
                    <ul>
                      <li>目标：{character.goal || '未确认'}</li>
                      <li>动机：{character.motivation || '未确认'}</li>
                      <li>性格：{character.traits.join('、') || '未确认'}</li>
                      <li>弧光：{character.arc || '未确认'}</li>
                    </ul>
                  </article>
                ))}
              </div>
            ) : <p className="nwa-muted">未提取到可靠人物信息。</p>}
            {relationships.length > 0 ? (
              <>
                <h5>人物关系</h5>
                <ul>
                  {relationships.map((item, index) => (
                    <li key={`${item.from}-${item.to}-${index}`}>
                      <strong>{item.from} ↔ {item.to}</strong>：{item.relation || '关系未确认'}
                      {item.evolution ? `；演变：${item.evolution}` : ''}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>

          <section>
            <h4>分章人物服装</h4>
            {chapterOutfits.length > 0 ? (
              <details className="nwa-reference-outfits">
                <summary>
                  已整理 {chapterOutfits.length} 章，展开查看人物穿着
                </summary>
                <div className="nwa-reference-outfits__chapters">
                  {chapterOutfits.map((chapter, chapterIndex) => (
                    <article key={`${chapter.chapter}-${chapterIndex}`}>
                      <strong>{chapter.chapter}</strong>
                      {chapter.characters.length > 0 ? (
                        <ul>
                          {chapter.characters.map((item, characterIndex) => (
                            <li key={`${item.name}-${characterIndex}`}>
                              <strong>{item.name}</strong>：{item.outfit || '正文未描写'}
                              <span>
                                {item.certainty === 'explicit'
                                  ? '正文明确描写'
                                  : item.certainty === 'inferred'
                                    ? '上下文推断'
                                    : '正文未描写'}
                                {item.evidence ? `｜依据：${item.evidence}` : ''}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : <p className="nwa-muted">本章未提取到具名人物。</p>}
                    </article>
                  ))}
                </div>
              </details>
            ) : <p className="nwa-muted">暂未提取到分章服装信息。</p>}
          </section>

          <section>
            <h4>冲突</h4>
            {conflicts.length > 0 ? (
              <ol>
                {conflicts.map((conflict, index) => (
                  <li key={`${conflict.type}-${index}`}>
                    <strong>{conflict.parties.join(' vs ') || conflict.type}</strong>：{conflict.description}
                    {conflict.stakes ? `｜代价：${conflict.stakes}` : ''}
                    {conflict.progression ? `｜推进：${conflict.progression}` : ''}
                  </li>
                ))}
              </ol>
            ) : <p className="nwa-muted">未提取到可靠冲突链。</p>}
          </section>

          <section>
            <h4>爽点与兑现</h4>
            {payoffs.length > 0 ? (
              <ol>
                {payoffs.map((payoff, index) => (
                  <li key={`${payoff.title}-${index}`}>
                    <strong>{payoff.chapter ? `${payoff.chapter}｜` : ''}{payoff.title}</strong>
                    <span>铺垫：{payoff.setup || '未确认'}</span>
                    <span>触发：{payoff.trigger || '未确认'}</span>
                    <span>兑现：{payoff.payoff}</span>
                    <span>影响：{payoff.impact || '未确认'}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="nwa-muted">未提取到可靠爽点/兑现节点。</p>}
          </section>

          <section>
            <h4>世界观</h4>
            {world ? (
              <>
                <p><strong>核心前提：</strong>{world.premise || '未确认'}</p>
                {([
                  ['规则', world.rules],
                  ['势力/组织', world.factions],
                  ['地点', world.locations],
                  ['体系', world.systems],
                  ['历史', world.history],
                  ['专有名词', world.terminology],
                ] as const).map(([label, items]) => (
                  items.length > 0 ? (
                    <div key={label} className="nwa-reference-breakdown__world-row">
                      <strong>{label}</strong>
                      <span>{items.join('；')}</span>
                    </div>
                  ) : null
                ))}
              </>
            ) : <p className="nwa-muted">未提取到可靠世界观信息。</p>}
          </section>

          <section>
            <h4>剧情大纲</h4>
            {outline.length > 0 ? (
              <ol className="nwa-reference-breakdown__outline">
                {outline.map((beat, index) => (
                  <li key={`${beat.stage}-${index}`}>
                    <strong>{beat.chapters ? `${beat.chapters}｜` : ''}{beat.stage}</strong>
                    <p>{beat.summary}</p>
                    {beat.turningPoint ? <span>关键转折：{beat.turningPoint}</span> : null}
                  </li>
                ))}
              </ol>
            ) : <p className="nwa-muted">{message.profile.mainPlotAbstract}</p>}
          </section>

          {(foreshadowing.length > 0 || reversals.length > 0 || themes.length > 0) ? (
            <section>
              <h4>伏笔、反转与主题</h4>
              {foreshadowing.length > 0 ? (
                <>
                  <h5>伏笔</h5>
                  <ul>
                    {foreshadowing.map((item, index) => (
                      <li key={`foreshadow-${index}`}>
                        {item.setup} → {item.payoff || '尚未兑现/未确认'}（{item.status}）
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {reversals.length > 0 ? (
                <>
                  <h5>反转</h5>
                  <ul>
                    {reversals.map((item, index) => (
                      <li key={`reversal-${index}`}>
                        {item.chapter ? `${item.chapter}｜` : ''}{item.setup || '铺垫未确认'} → {item.reversal}
                        {item.effect ? `｜影响：${item.effect}` : ''}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {themes.length > 0 ? <p><strong>主题：</strong>{themes.join('；')}</p> : null}
            </section>
          ) : null}
        </div>
        <details className="nwa-plan-chat__brief-details">
          <summary>完整拆解报告 Markdown</summary>
          <pre className="nwa-plan-chat__brief">{message.profile.markdownReport}</pre>
        </details>
        <details className="nwa-plan-chat__brief-details">
          <summary>可选：只提炼写作方法到原创项目</summary>
          <div className="nwa-plan-chat__questions" style={{ marginTop: '0.75rem' }}>
            <p className="nwa-muted">这一项与上面的原作内容拆解分开；只有主动勾选后才会写入项目。</p>
            <div className="nwa-plan-chat__options">
              {REFERENCE_TRANSFER_DIMENSIONS.map((d) => (
                <label key={d} className="nwa-plan-chat__option">
                  <input
                    type="checkbox"
                    checked={selected.includes(d)}
                    disabled={streaming || message.transferred}
                    onChange={() => toggle(d)}
                  />
                  <span>{REFERENCE_DIMENSION_LABELS[d]}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="nwa-plan-chat__actions">
            {message.transferred ? (
              <span className="nwa-muted"><Icon name="check" /> 已迁移到项目</span>
            ) : (
              <button
                type="button"
                className="nwa-button"
                disabled={streaming || selected.length === 0}
                onClick={() =>
                  onReferenceTransfer?.(message.id, message.reference.id, selected)
                }
              >
                应用选中方法
              </button>
            )}
          </div>
          <p className="nwa-muted" style={{ marginTop: '0.5rem', fontSize: '0.85em' }}>
            迁移时不会把原作人物、地名、组织、能力或剧情写入原创项目。
          </p>
        </details>
      </div>
    </div>
  );
}

export function ChatMessageView({
  message,
  streaming,
  onAdoptPreview,
  onJumpToArtifact,
  onOpenChapter,
  onPlanSubmit,
  onPlanGenerate,
  onReferenceTransfer,
  onReferenceAnalyze,
}: ChatMessageViewProps): JSX.Element | null {
  // —— 文本消息 ——
  if (message.kind === 'text') {
    const isUser = message.role === 'user';
    return (
      <div className={`nwa-chat__msg${isUser ? ' nwa-chat__msg--user' : ''}`}>
        <span className="nwa-chat__role">{isUser ? '你' : 'AI'}</span>
        <div className="nwa-chat__content">{message.content}</div>
        {!isUser && message.thinking ? (
          <details className="nwa-thinking-details">
            <summary className="nwa-thinking-summary"><Icon name="brain" /> 思考过程</summary>
            <div className="nwa-thinking-content">{message.thinking}</div>
          </details>
        ) : null}
      </div>
    );
  }

  // —— 计划模式 ——
  if (message.kind === 'plan-turn') {
    return (
      <PlanTurnCard
        message={message}
        streaming={streaming}
        onPlanSubmit={onPlanSubmit}
        onPlanGenerate={onPlanGenerate}
      />
    );
  }

  // —— 参考书导入：勾选章节 ——
  if (message.kind === 'reference-import') {
    return (
      <ReferenceImportCard
        message={message}
        streaming={streaming}
        onReferenceAnalyze={onReferenceAnalyze}
      />
    );
  }

  // —— 参考小说分析结果 ——
  if (message.kind === 'reference-result') {
    return (
      <ReferenceResultCard
        message={message}
        streaming={streaming}
        onReferenceTransfer={onReferenceTransfer}
      />
    );
  }

  // —— Agent 实时进度 ——
  if (message.kind === 'agent-progress') {
    const events = message.events;
    const last = events[events.length - 1];
    const current = last?.current;
    const total = last?.total;
    const progressPct =
      current !== undefined && total !== undefined && total > 0
        ? (current / total) * 100
        : events.length > 0
          ? Math.min(95, events.length * 8)
          : 8;
    return (
      <div className="nwa-chat__msg nwa-chat__msg--assistant nwa-chat__msg--progress">
        <span className="nwa-chat__role">
          <LottieMotion
            animationData={agentThinkingAnimation}
            label="Agent 思考动画"
            fallbackIcon="brain"
            className="nwa-lottie--inline"
          />
          {message.taskTitle}
        </span>
        <div className="nwa-chat__progress">
          <div className="nwa-chat__progress-bar" aria-hidden="true">
            <span style={{ width: `${progressPct}%` }} />
          </div>
          <div className="nwa-chat__progress-status">
            {current !== undefined && total !== undefined ? `第 ${current}/${total} 章 · ` : ''}
            {last?.message ?? '准备中…'}
          </div>
        </div>
        <div className="nwa-chat__live-panel" aria-label="实时进度流">
          {events.length === 0 ? (
            <div className="nwa-stream nwa-stream--typing">正在连接 Agent…</div>
          ) : (
            <ol className="nwa-chat__progress-events nwa-stream nwa-stream--typing">
              {events.slice(-24).map((ev, i) => (
                <li key={i} className={`nwa-chat__progress-event nwa-chat__progress-event--${ev.phase}`}>
                  {ev.current !== undefined && ev.total !== undefined
                    ? `[${ev.current}/${ev.total}] `
                    : ''}
                  {ev.message}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    );
  }

  // —— Agent 任务结果 ——
  if (message.kind === 'agent-result') {
    return (
      <div className="nwa-chat__msg nwa-chat__msg--assistant nwa-chat__msg--result">
        <span className="nwa-chat__role">
          <LottieMotion
            animationData={taskCompleteAnimation}
            label="任务完成动画"
            loop={false}
            fallbackIcon="check"
            className="nwa-lottie--inline"
          />
          任务完成
        </span>
        <div className="nwa-chat__content">
          <strong>{message.summary}</strong>
        </div>
        {message.steps.length > 0 ? (
          <ol className="nwa-chat__steps">
            {message.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        ) : null}
        {message.metrics ? renderMetrics(message.metrics) : null}
        {message.artifacts.length > 0 ? (
          <div className="nwa-chat__artifacts">
            {message.artifacts.map((artifact) => (
              <button
                key={`${artifact.kind}-${artifact.id}`}
                type="button"
                className="nwa-chip nwa-chip--clickable"
                onClick={() => onJumpToArtifact?.(artifact)}
                title={`查看${ARTIFACT_LABELS[artifact.kind]}：${artifact.title}`}
              >
                {ARTIFACT_LABELS[artifact.kind]}：{artifact.title}
              </button>
            ))}
          </div>
        ) : null}
        {message.chapterPreview ? (
          <div className="nwa-chat__chapter-card">
            <div className="nwa-chat__chapter-head">
              <strong>{message.chapterPreview.title}</strong>
              <button
                type="button"
                className="nwa-button nwa-button--ghost"
                disabled={streaming}
                onClick={() => onOpenChapter?.(message.chapterPreview!.id)}
              >
                在编辑器中打开
              </button>
            </div>
            <div className="nwa-chat__chapter-pre nwa-rich-text">{message.chapterPreview.content}</div>
          </div>
        ) : null}
      </div>
    );
  }

  // —— 章节正文预览（写作模式生成） ——
  if (message.kind === 'chapter-preview') {
    return (
      <div className="nwa-chat__msg nwa-chat__msg--assistant nwa-chat__msg--chapter-preview">
        <span className="nwa-chat__role"><Icon name="penLine" /> 写作结果</span>
        <div className="nwa-chat__chapter-pre nwa-rich-text">{message.content}</div>
        <div className="nwa-chat__chapter-actions">
          {message.adopted ? (
            <span className="nwa-muted"><Icon name="check" /> 已采用到正文</span>
          ) : (
            <button
              type="button"
              className="nwa-button"
              disabled={streaming}
              onClick={() => onAdoptPreview?.(message.id)}
            >
              采用到正文
            </button>
          )}
        </div>
      </div>
    );
  }

  return null;
}

export default ChatMessageView;
