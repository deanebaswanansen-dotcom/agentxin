/**
 * 对话流单条消息渲染。
 *
 * 支持四种消息类型：
 *  - text: 普通文本（用户/AI），AI 带可选思考过程折叠
 *  - agent-progress: Agent 流式期间的进度占位（显示进度条 + 事件列表）
 *  - agent-result: Agent 任务完成结果（summary + steps + artifacts + 章节预览）
 *  - chapter-preview: 写作模式生成的章节正文预览（可"采用"写回抽屉编辑器）
 */
import type { AgentArtifact, AgentRunMetrics } from '../types/index.js';
import agentThinkingAnimation from '../assets/lottie/agent-thinking.json';
import taskCompleteAnimation from '../assets/lottie/task-complete.json';
import type { ChatMessage } from './chat/types.js';
import { Icon } from './Icon.js';
import { LottieMotion } from './LottieMotion.js';
import './components.css';

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
}

export function ChatMessageView({
  message,
  streaming,
  onAdoptPreview,
  onJumpToArtifact,
  onOpenChapter,
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
          <span className="nwa-muted">
            {current !== undefined && total !== undefined ? `第 ${current}/${total} 章 · ` : ''}
            {last?.message ?? '准备中…'}
          </span>
        </div>
        {events.length > 1 ? (
          <ul className="nwa-chat__progress-events">
            {events.slice(-6).map((ev, i) => (
              <li key={i} className={`nwa-chat__progress-event nwa-chat__progress-event--${ev.phase}`}>
                {ev.message}
              </li>
            ))}
          </ul>
        ) : null}
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
