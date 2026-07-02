import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../api/apiClient.js';
import agentThinkingAnimation from '../assets/lottie/agent-thinking.json';
import taskCompleteAnimation from '../assets/lottie/task-complete.json';
import type { AgentProgressEvent, AgentRunMode, AgentRunResult, AgentTask, Chapter, Id } from '../types/index.js';
import { Icon, type IconName } from './Icon.js';
import { LottieMotion } from './LottieMotion.js';
import './components.css';

export type AgentClient = Pick<typeof apiClient, 'agent'> & Partial<Pick<typeof apiClient, 'chapters'>>;

export interface AgentCommandCenterProps {
  selectedProjectId?: Id | null;
  selectedChapterId?: Id | null;
  onCompleted: (result: AgentRunResult) => void;
  onError?: (error: unknown) => void;
  client?: AgentClient;

  /** Called when user clicks an artifact chip in the result (NEW-07: allow jumping to left workspace tab). */
  onJumpToArtifact?: (artifact: { kind: string; id: Id; title: string }) => void;

  /** 流式状态变化回调：将 Agent 执行进度推送到中央面板实时显示。 */
  onStreamingChange?: (state: { streaming: boolean; content: string; thinking: string }) => void;
}

const TASKS: Array<{
  key: AgentTask;
  icon: IconName;
  title: string;
  desc: string;
  mode: AgentRunMode;
  lockedMode?: boolean;
  placeholder: string;
  button: string;
}> = [
  {
    key: 'novel',
    icon: 'sparkles',
    title: '一键创建新书',
    desc: '输入题材或爽点，自动建项目、补设定、写首章。',
    mode: 'draft',
    placeholder: '例：赛博修仙学院，主角靠写代码御剑...',
    button: '开始生成',
  },
  {
    key: 'full_novel',
    icon: 'bookOpen',
    title: '一键生成整本',
    desc: '建项目→设定→逐章自动写作，每章带长期记忆与反思自我进化（默认 3 章）。',
    mode: 'draft',
    lockedMode: true,
    placeholder: '例：废土机械师重建文明，节奏明快、多反转...',
    button: '生成整本',
  },
  {
    key: 'auto_next',
    icon: 'refresh',
    title: '一键写下一章',
    desc: '后端编排：建章 → 蓝图 → 分场景写作 → 合并正文（需先选项目）。',
    mode: 'draft',
    lockedMode: true,
    placeholder: '可选：指定本章剧情走向；留空则自动顺接上一章。',
    button: '写下一章',
  },
  {
    key: 'title',
    icon: 'tag',
    title: '按标题生成',
    desc: '给一个书名或章节名，自动扩展题材、卖点和开篇方向。',
    mode: 'draft',
    placeholder: '例：我在废土开灵田',
    button: '按标题写',
  },
  {
    key: 'outline',
    icon: 'map',
    title: '大纲和设定',
    desc: '只生成世界观、人物护栏与卷一大纲，不写正文。',
    mode: 'reference',
    lockedMode: true,
    placeholder: '例：都市异能，主角能看见城市地下灵脉，节奏要快。',
    button: '生成方案',
  },
  {
    key: 'polish',
    icon: 'penLine',
    title: '润写小说',
    desc: '参考模式出建议；成文模式直接润写（有选中章节时会写回）。',
    mode: 'reference',
    placeholder: '粘贴片段或说明：更热血 / 更悬疑 / 去掉废话。',
    button: '润写',
  },
  {
    key: 'diagnostic',
    icon: 'search',
    title: '综合测试',
    desc: '检查项目缺口、连贯性与下一步（需先选项目）。',
    mode: 'reference',
    lockedMode: true,
    placeholder: '例：能否继续写第三章？列出缺口和建议。',
    button: '运行检查',
  },
  {
    key: 'material_research',
    icon: 'fileText',
    title: '素材研究',
    desc: '搜索公开资料，提炼桥段结构、俗套风险和原创改写方向。',
    mode: 'reference',
    lockedMode: true,
    placeholder: '例：我想写一个退婚反杀桥段，但不要太老套。',
    button: '开始研究',
  },
  {
    key: 'trope_breakdown',
    icon: 'puzzle',
    title: '拆梗',
    desc: '把桥段拆成冲突、动机、爽点、误会、反转和原创变体。',
    mode: 'reference',
    lockedMode: true,
    placeholder: '例：女主假退婚保护男主，男主误以为被羞辱。',
    button: '开始拆梗',
  },
  {
    key: 'cliche_guard',
    icon: 'search',
    title: '避俗检查',
    desc: '检查老套风险、动机漏洞和假爽点，并给替代方案。',
    mode: 'reference',
    lockedMode: true,
    placeholder: '例：废柴主角获得传承后在宗门大比打脸众人。',
    button: '开始检查',
  },
  {
    key: 'chapter_diagnosis',
    icon: 'fileText',
    title: '章节诊断',
    desc: '读取当前章节，检查冲突、节奏、爽点兑现和人物动机。',
    mode: 'reference',
    lockedMode: true,
    placeholder: '可留空：直接诊断当前章节；也可指定关注点。',
    button: '诊断章节',
  },
  {
    key: 'workspace_review',
    icon: 'brain',
    title: '主动审阅',
    desc: '不等指令，自动阅读当前项目并生成缺口与下一步建议。',
    mode: 'reference',
    lockedMode: true,
    placeholder: '可留空：Agent 会主动审阅当前项目。',
    button: '审阅当前项目',
  },
];

const TASK_PLANS: Record<AgentTask, string[]> = {
  novel: ['创建或复用项目', '世界观子 Agent', '人物子 Agent', '大纲子 Agent', '正文子 Agent 写首章'],
  full_novel: ['建项目 + 设定包', '写入初始故事记忆', '逐章生成（回灌记忆）', '每章反思自我进化', '累积连贯整本草稿'],
  title: ['按标题建项', '扩展题材与卖点', '分步写入设定', '生成开篇正文'],
  outline: ['创建或复用项目', '世界观 / 人物 / 大纲分步生成', '保存到项目资料'],
  polish: ['解析润写需求', '载入章节（如有）', '润写子 Agent 输出', '保存建议或写回章节'],
  diagnostic: ['汇总章节与设定', '诊断子 Agent 分析', '保存诊断报告'],
  material_research: ['生成公开检索关键词', '检索 Wikisource / HN / RSS', '清洗资料片段', '提炼套路与原创建议', '保存 Markdown 报告'],
  trope_breakdown: ['识别桥段承诺', '拆冲突与人物动机', '拆爽点 / 误会 / 反转', '给原创变体', '保存拆梗报告'],
  cliche_guard: ['检查老套风险', '定位动机漏洞', '替换假爽点', '生成原创替代方案', '保存避俗报告'],
  chapter_diagnosis: ['读取当前章节', '汇总项目上下文', '诊断冲突 / 节奏 / 爽点', '给修改建议', '保存章节诊断报告'],
  workspace_review: ['读取全局项目快照', '主动评估缺口与风险', '写入下一步建议报告'],
  auto_next: ['推断章节序号', '回灌长期记忆', '生成蓝图', '分场景写作', '合并整章正文', '反思更新记忆'],
  plan_blueprint: ['解析章节需求', '读取 bible + outline + 记忆', '生成结构化蓝图 JSON (scenes + 字数+节奏)', '保存到 blueprints/'],
  write_scene: ['载入蓝图指定 scene', '按 must_include / purpose / 目标字数写正文', '保存 scenes/chapter_XX/scene_YY.md', '可选衔接检查'],
  write_chapter_from_blueprint: ['plan 或载入蓝图', '逐 scene write', 'merge 成整章', 'word_count + pacing report', '可选 expand/rewrite 循环'],
};

const ARTIFACT_LABELS: Record<AgentRunResult['artifacts'][number]['kind'], string> = {
  project: '项目',
  world: '世界观',
  character: '人物',
  outline: '大纲',
  chapter: '章节',
};

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** 将 Agent 进度事件格式化为中央面板显示的文本。 */
function liveProgressToText(event: AgentProgressEvent): string {
  const prefix = event.current !== undefined && event.total !== undefined
    ? `[${event.current}/${event.total}] `
    : '';
  return `${prefix}${event.message}`;
}

function formatNumber(value: number | undefined): string {
  return (value ?? 0).toLocaleString();
}

export function AgentCommandCenter({
  selectedProjectId,
  selectedChapterId,
  onCompleted,
  onError,
  client = apiClient,
  onJumpToArtifact,
  onStreamingChange,
}: AgentCommandCenterProps): JSX.Element {
  const [task, setTask] = useState<AgentTask>('novel');
  const [mode, setMode] = useState<AgentRunMode>('draft');
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [liveStepIndex, setLiveStepIndex] = useState(0);
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const [chapterPreview, setChapterPreview] = useState<Chapter | null>(null);

  // One-click Mock helper for new users (addresses NEW-01)
  const [quickMockBusy, setQuickMockBusy] = useState(false);
  const [quickMockSuccess, setQuickMockSuccess] = useState(false);

  // full_novel 参数（章节数 / 每章目标字数），仅在该任务下展示。
  const [fullNovelChapters, setFullNovelChapters] = useState(3);
  const [fullNovelWords, setFullNovelWords] = useState(1500);

  // 整本生成的实时进度（SSE 推送）。
  const [liveProgress, setLiveProgress] = useState<AgentProgressEvent[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const activeTask = TASKS.find((item) => item.key === task) ?? TASKS[0];
  const planSteps = TASK_PLANS[task];
  const modeLocked = activeTask.lockedMode === true;

  useEffect(() => {
    if (!running) {
      setElapsedSeconds(0);
      setLiveStepIndex(0);
      return undefined;
    }
    const started = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const run = useCallback(async () => {
    const text = prompt.trim();
    if (task !== 'auto_next' && task !== 'workspace_review' && task !== 'chapter_diagnosis' && text.length === 0) return;
    if (running) return;
    setRunning(true);
    setResult(null);
    setChapterPreview(null);
    setLiveStepIndex(0);
    setLiveProgress([]);
    const controller = new AbortController();
    abortRef.current = controller;
    onStreamingChange?.({
      streaming: true,
      content: `正在启动「${activeTask.title}」…`,
      thinking: `任务：${activeTask.title}\n模式：${mode === 'draft' ? '直接成文' : '只要方案'}`,
    });
    try {
      const body = {
        task,
        mode: modeLocked ? activeTask.mode : mode,
        prompt: text,
        projectId: selectedProjectId ?? undefined,
        chapterId: selectedChapterId ?? undefined,
        options:
          task === 'auto_next'
            ? { targetWords: 2000 }
            : task === 'full_novel'
            ? { chapters: fullNovelChapters, targetWords: fullNovelWords, totalChapters: fullNovelChapters }
            : undefined,
      } as const;

      // 所有任务统一走 SSE 流式接口，实时显示进度到中央面板。
      // 若 client 不支持 runStream（旧测试 mock），回退到 run()。
      let accumulatedProgress = '';
      const next =
        client.agent.runStream !== undefined
          ? await client.agent.runStream(body, {
              signal: controller.signal,
              onProgress: (event) => {
                setLiveProgress((prev) => [...prev, event]);
                setLiveStepIndex((index) => Math.min(planSteps.length - 1, index + 1));
                const line = liveProgressToText(event);
                accumulatedProgress += (accumulatedProgress ? '\n' : '') + line;
                onStreamingChange?.({
                  streaming: true,
                  content: accumulatedProgress,
                  thinking: `任务：${activeTask.title}\n模式：${mode === 'draft' ? '直接成文' : '只要方案'}`,
                });
              },
            })
          : await client.agent.run(body);
      setResult(next);
      if (next.chapterId !== undefined && client.chapters !== undefined) {
        const chapters = await client.chapters.list(next.projectId);
        setChapterPreview(chapters.find((chapter) => chapter.id === next.chapterId) ?? null);
      }
      onCompleted(next);
    } catch (error) {
      if (isAbort(error)) {
        setLiveProgress((prev) => [
          ...prev,
          { phase: 'info', message: '任务已停止。' },
        ]);
      } else {
        onError?.(error);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      onStreamingChange?.({ streaming: false, content: '', thinking: '' });
    }
  }, [
    activeTask.mode,
    activeTask.title,
    client,
    fullNovelChapters,
    fullNovelWords,
    mode,
    modeLocked,
    onCompleted,
    onError,
    onStreamingChange,
    planSteps.length,
    prompt,
    running,
    selectedChapterId,
    selectedProjectId,
    task,
  ]);

  const needsProject =
    task === 'auto_next' || task === 'diagnostic' || task === 'chapter_diagnosis' || task === 'workspace_review';
  const canRun =
    !running &&
    (task === 'auto_next' || task === 'workspace_review' || task === 'chapter_diagnosis' || prompt.trim().length > 0) &&
    (!needsProject || Boolean(selectedProjectId)) &&
    (task !== 'chapter_diagnosis' || Boolean(selectedChapterId));

  const selectTask = useCallback((next: (typeof TASKS)[number]) => {
    setTask(next.key);
    setMode(next.mode);
    setResult(null);
  }, []);

  // One-click switch to Mock demo preset (NEW-01: lower barrier for first-time users without keys)
  const handleEnableMock = useCallback(async () => {
    if (quickMockBusy) return;
    setQuickMockBusy(true);
    setQuickMockSuccess(false);
    try {
      await apiClient.modelConfig.save({
        baseUrl: 'mock',
        apiKey: 'mock-key-for-demo',
        modelName: 'mock-model',
      });
      setQuickMockSuccess(true);
    } catch (error) {
      onError?.(error);
    } finally {
      setQuickMockBusy(false);
    }
  }, [quickMockBusy, onError]);

  const progressLabel = running
    ? planSteps[liveStepIndex] ?? planSteps[0]
    : null;

  return (
    <section className="nwa-agent" aria-label="创作中心">
      <div className="nwa-agent__head">
        <div>
          <h2 className="nwa-agent__title">创作中心</h2>
          <p className="nwa-agent__subtitle">
            选一个任务并输入需求；后端 LangGraph 式编排会按任务调用不同子 Agent。
          </p>
        </div>
        {!modeLocked ? (
          <div className="nwa-agent__mode">
            <span className="nwa-muted">输出：</span>
            <div className="nwa-segment" role="tablist" aria-label="Agent 模式">
              {(['draft', 'reference'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={mode === item}
                  className={`nwa-segment__item${mode === item ? ' nwa-segment__item--active' : ''}`}
                  disabled={running}
                  onClick={() => setMode(item)}
                >
                  {item === 'draft' ? '直接成文' : '只要方案'}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="nwa-agent__tasks" aria-label="创作任务">
        {TASKS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`nwa-task-card nwa-task-card--${item.key}${task === item.key ? ' nwa-task-card--active' : ''}`}
            disabled={running}
            onClick={() => selectTask(item)}
          >
            <div className="nwa-task-card__header">
              <span className="nwa-task-card__icon"><Icon name={item.icon} /></span>
              <span className="nwa-task-card__title">{item.title}</span>
            </div>
            <span className="nwa-task-card__desc">{item.desc}</span>
          </button>
        ))}
      </div>

      <div className="nwa-agent__box">
        <div className="nwa-agent__current">
          <strong>当前：<Icon name={activeTask.icon} /> {activeTask.title}</strong>
        </div>

        {needsProject && !selectedProjectId ? (
          <p className="nwa-agent__warn" role="status">
            请先在左侧「项目」列表中选中一个项目。
          </p>
        ) : null}

        {/* Prominent one-click Mock for first-time / no-key users (NEW-01) */}
        <div className="nwa-agent__quickstart">
          <span className="nwa-muted">没有 API Key？</span>
          <button
            type="button"
            className="nwa-button nwa-button--ghost"
            disabled={quickMockBusy}
            onClick={() => void handleEnableMock()}
            style={{ padding: '0.35rem 0.7rem', fontSize: '0.82rem' }}
          >
            {quickMockBusy
              ? '切换中…'
              : quickMockSuccess
              ? <><Icon name="check" /> 已切换到 Mock</>
              : '一键启用 Mock 演示（无需 Key）'}
          </button>
          {quickMockSuccess && (
            <span className="nwa-muted" style={{ fontSize: '0.8rem' }}>
              可直接执行任务
            </span>
          )}
        </div>

        <textarea
          className="nwa-agent__input"
          aria-label="一句话写作需求"
          rows={5}
          placeholder={activeTask.placeholder}
          value={prompt}
          disabled={running}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              void run();
            }
          }}
        />

        {task === 'full_novel' ? (
          <div className="nwa-agent__params" aria-label="整本生成参数">
            <label className="nwa-agent__param">
              <span>章节数</span>
              <input
                type="number"
                min={1}
                max={500}
                value={fullNovelChapters}
                disabled={running}
                onChange={(event) => {
                  const n = Number(event.target.value);
                  setFullNovelChapters(Number.isFinite(n) ? Math.min(500, Math.max(1, Math.round(n))) : 3);
                }}
              />
            </label>
            <label className="nwa-agent__param">
              <span>每章字数</span>
              <input
                type="number"
                min={300}
                max={8000}
                step={100}
                value={fullNovelWords}
                disabled={running}
                onChange={(event) => {
                  const n = Number(event.target.value);
                  setFullNovelWords(Number.isFinite(n) ? Math.min(8000, Math.max(300, Math.round(n))) : 1500);
                }}
              />
            </label>
            <span className="nwa-muted nwa-agent__param-hint">
              共约 {(fullNovelChapters * fullNovelWords).toLocaleString()} 字（章节越多耗时越长）
            </span>
          </div>
        ) : null}

        <details className="nwa-agent-plan" open aria-label="本任务编排步骤">
          <summary className="nwa-agent-plan__head">
            <strong>编排步骤</strong>
            <span>{modeLocked ? '模式已锁定' : mode === 'draft' ? '会写正文' : '只出参考'}</span>
          </summary>
          <ol>
            {planSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </details>

        <div className="nwa-agent__actions">
          <span className="nwa-agent__hint">
            {needsProject
              ? selectedProjectId
                ? '将写入当前项目。'
                : '需要先选项目。'
              : selectedProjectId
                ? '将写入当前项目。'
                : '未选项目时会自动新建。'}
          </span>
          {running ? (
            <button type="button" className="nwa-button nwa-button--danger" onClick={stop}>
              停止
            </button>
          ) : (
            <button type="button" className="nwa-button" disabled={!canRun} onClick={() => void run()}>
              {activeTask.button}
            </button>
          )}
        </div>

        {running && progressLabel ? (
          <div className="nwa-agent-progress" aria-label="Agent 执行进度">
            <div className="nwa-agent-progress__row">
              <LottieMotion
                animationData={agentThinkingAnimation}
                label="Agent 思考动画"
                fallbackIcon="brain"
                className="nwa-lottie--agent"
              />
              <div className="nwa-agent-progress__body">
                <div className="nwa-agent-progress__bar" aria-hidden="true">
                  <span
                    style={{
                      width: `${((liveStepIndex + 1) / planSteps.length) * 100}%`,
                    }}
                  />
                </div>
                <div className="nwa-agent-progress__meta">
                  <strong>
                    步骤 {liveStepIndex + 1}/{planSteps.length}：{progressLabel}
                  </strong>
                  <span>已运行 {elapsedSeconds} 秒</span>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {liveProgress.length > 0 ? (
          <div className="nwa-agent-live" aria-label="整本生成实时进度">
            <div className="nwa-agent-live__head">
              <strong>实时进度</strong>
              {(() => {
                const last = liveProgress[liveProgress.length - 1];
                return last?.total !== undefined && last.current !== undefined ? (
                  <span>
                    第 {last.current}/{last.total} 章
                  </span>
                ) : null;
              })()}
            </div>
            <ol className="nwa-agent-live__list">
              {liveProgress.slice(-12).map((event, index) => (
                <li key={`${index}-${event.message}`} className={`nwa-agent-live__item nwa-agent-live__item--${event.phase}`}>
                  {event.message}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>

      {result ? (
        <div className="nwa-agent__result" aria-label="Agent 执行结果" role="status" aria-live="polite">
          <div className="nwa-agent__success-head">
            <LottieMotion
              animationData={taskCompleteAnimation}
              label="任务完成动画"
              loop={false}
              fallbackIcon="check"
              className="nwa-lottie--success"
            />
            <strong>{result.summary}</strong>
          </div>
          <ol className="nwa-agent__steps">
            {result.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {result.metrics ? (
            <div className="nwa-cache-stats" aria-label="运行指标">
              {result.metrics.plannedWords !== undefined ? (
                <div><span>{formatNumber(result.metrics.plannedWords)}</span><small>计划字数</small></div>
              ) : null}
              {result.metrics.completedChapters !== undefined ? (
                <div><span>{formatNumber(result.metrics.completedChapters)}</span><small>完成章节</small></div>
              ) : null}
              <div><span>{formatNumber(result.metrics.modelCalls)}</span><small>模型调用</small></div>
              <div><span>{formatNumber(result.metrics.promptTokens)}</span><small>输入 token</small></div>
              <div><span>{formatNumber(result.metrics.completionTokens)}</span><small>输出 token</small></div>
              <div><span>{formatNumber(result.metrics.cacheHitTokens)}</span><small>命中 token</small></div>
              <div><span>{result.metrics.cacheHitRatePct}%</span><small>命中率</small></div>
              <div><span>{formatNumber(result.metrics.localCacheHits)}</span><small>本地命中</small></div>
              {result.metrics.estimatedCostUsd !== undefined ? (
                <div><span>${result.metrics.estimatedCostUsd.toFixed(6)}</span><small>估算成本</small></div>
              ) : null}
            </div>
          ) : null}
          <div className="nwa-agent__artifacts">
            {result.artifacts.map((artifact) => (
              <button
                key={`${artifact.kind}-${artifact.id}`}
                type="button"
                className="nwa-chip nwa-chip--clickable"
                onClick={() => onJumpToArtifact?.(artifact)}
                title={`跳转到${ARTIFACT_LABELS[artifact.kind]}：${artifact.title}`}
              >
                {ARTIFACT_LABELS[artifact.kind]}：{artifact.title}
              </button>
            ))}
          </div>
          {chapterPreview ? (
            <article className="nwa-agent__chapter-preview" aria-label="生成章节预览">
              <div className="nwa-agent__chapter-head">
                <strong>{chapterPreview.title}</strong>
                <span>已保存到当前项目</span>
              </div>
              <div className="nwa-rich-text">{chapterPreview.content}</div>
            </article>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default AgentCommandCenter;
