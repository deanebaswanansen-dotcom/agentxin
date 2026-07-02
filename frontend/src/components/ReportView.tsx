/**
 * 字数报告与节奏报告展示（任务 12.4，需求 14.4）。
 *
 * 展示后端返回的两类报告（需求 14.4）：
 *  - 字数报告（{@link WordCountReport}）：每个场景的 targetWords / actualWords /
 *    delta / needsExpansion / suggestedExpansion，以及整章合计（目标 / 实际 /
 *    差值）。
 *  - 节奏报告（{@link PacingReport}）：剧情点完成状态（plotPoints 的 point /
 *    status）、被违反的禁止事项（violatedForbiddenPoints）、按场景的问题与建议
 *    （sceneIssues 的 sceneId / issue / suggestion / priority）。
 *
 * 并提供「字数检查」「节奏检查」按钮，分别调用 `client.blueprint.wordCount.run`
 * 与 `client.blueprint.pacing.run` 触发后端检查并展示结果。报告对象可由父组件
 * 通过 props 传入（受控展示），检查完成后经 `onWordCountReport`/`onPacingReport`
 * 回调上抛刷新。后端错误统一经 `onError` 上抛（需求 14.6）。
 */
import { useCallback, useState } from 'react';
import apiClient from '../api/apiClient.js';
import type {
  Id,
  PacingPriority,
  PacingReport,
  PlotPointStatus,
  WordCountReport,
} from '../types/index.js';
import './components.css';

/** 本组件所依赖的最小客户端接口（便于测试时注入桩）。 */
export type ReportClient = Pick<typeof apiClient, 'blueprint'>;

export interface ReportViewProps {
  /** 目标章节标识符。 */
  chapterId: Id;
  /** 已持久化的字数报告（受控展示，可缺省）。 */
  wordCountReport?: WordCountReport;
  /** 已持久化的节奏报告（受控展示，可缺省）。 */
  pacingReport?: PacingReport;
  /** 字数检查完成后回调，携带最新报告（父组件据此刷新）。 */
  onWordCountReport?: (report: WordCountReport) => void;
  /** 节奏检查完成后回调，携带最新报告（父组件据此刷新）。 */
  onPacingReport?: (report: PacingReport) => void;
  /** 将后端/运行时错误上抛至全局错误提示（需求 14.6）。 */
  onError?: (error: unknown) => void;
  /** 可注入的客户端（默认使用共享 {@link apiClient}）。 */
  client?: ReportClient;
  /** Optional scene list from blueprint to show human-readable names instead of sceneId (NEW-08). */
  scenes?: Array<{ sceneId: string; name: string }>;
}

const PLOT_STATUS_LABELS: Record<PlotPointStatus, string> = {
  completed: '已完成',
  partial: '部分完成',
  missing: '未完成',
};

const PRIORITY_LABELS: Record<PacingPriority, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function WordCountChart({ report, scenes }: { report: WordCountReport; scenes?: Array<{ sceneId: string; name: string }> }): JSX.Element {
  const nameMap = new Map((scenes ?? []).map((s) => [s.sceneId, s.name]));
  const maxWords = Math.max(
    1,
    ...report.scenes.flatMap((scene) => [scene.targetWords, scene.actualWords]),
  );
  return (
    <div className="nwa-report-chart" aria-label="字数目标实际图表" role="img">
      {report.scenes.map((scene) => {
        const targetPct = clamp((scene.targetWords / maxWords) * 100, 4, 100);
        const actualPct = clamp((scene.actualWords / maxWords) * 100, 4, 100);
        return (
          <div key={scene.sceneId} className="nwa-report-chart__row">
            <span>{nameMap.get(scene.sceneId) || scene.sceneId}</span>
            <div className="nwa-report-chart__bars">
              <i className="nwa-report-chart__bar nwa-report-chart__bar--target" style={{ width: `${targetPct}%` }} />
              <i className="nwa-report-chart__bar nwa-report-chart__bar--actual" style={{ width: `${actualPct}%` }} />
            </div>
            <small>{scene.actualWords}/{scene.targetWords}</small>
          </div>
        );
      })}
      <div className="nwa-report-chart__legend">
        <span><i className="nwa-report-chart__dot nwa-report-chart__dot--target" />目标</span>
        <span><i className="nwa-report-chart__dot nwa-report-chart__dot--actual" />实际</span>
      </div>
    </div>
  );
}

function PacingStatusChart({ report }: { report: PacingReport }): JSX.Element {
  const counts: Record<PlotPointStatus, number> = {
    completed: 0,
    partial: 0,
    missing: 0,
  };
  for (const point of report.plotPoints) {
    counts[point.status] += 1;
  }
  const total = Math.max(1, report.plotPoints.length);
  return (
    <div className="nwa-report-status" aria-label="剧情点完成分布图" role="img">
      {(['completed', 'partial', 'missing'] as const).map((status) => (
        <div key={status} className="nwa-report-status__row">
          <span>{PLOT_STATUS_LABELS[status]}</span>
          <i
            className={`nwa-report-status__bar nwa-report-status__bar--${status}`}
            style={{ width: `${clamp((counts[status] / total) * 100, counts[status] > 0 ? 6 : 0, 100)}%` }}
          />
          <small>{counts[status]}</small>
        </div>
      ))}
    </div>
  );
}

/** 字数报告展示子区。 */
function WordCountReportSection({ report, scenes }: { report: WordCountReport; scenes?: Array<{ sceneId: string; name: string }> }): JSX.Element {
  const nameMap = new Map((scenes ?? []).map((s) => [s.sceneId, s.name]));
  return (
    <div aria-label="字数报告内容">
      <p className="nwa-muted">
        整章：目标 {report.chapterTargetWords} 字 / 实际 {report.chapterActualWords} 字 / 差值{' '}
        {report.chapterDelta >= 0 ? `+${report.chapterDelta}` : report.chapterDelta} 字
      </p>
      <WordCountChart report={report} scenes={scenes} />
      {report.scenes.length === 0 ? (
        <p className="nwa-empty">暂无场景字数数据。</p>
      ) : (
        <ul className="nwa-list">
          {report.scenes.map((s) => {
            const displayName = nameMap.get(s.sceneId) || s.sceneId;
            return (
              <li key={s.sceneId} className="nwa-list__item" style={{ display: 'block' }}>
                <div>
                  <strong>{displayName}</strong>
                  <span className="nwa-muted">
                    　目标 {s.targetWords} / 实际 {s.actualWords} / 差值{' '}
                    {s.delta >= 0 ? `+${s.delta}` : s.delta}
                  </span>
                </div>
                {s.needsExpansion ? (
                  <div className="nwa-muted">建议扩写约 {s.suggestedExpansion} 字。</div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** 节奏报告展示子区。 */
function PacingReportSection({ report, scenes }: { report: PacingReport; scenes?: Array<{ sceneId: string; name: string }> }): JSX.Element {
  const nameMap = new Map((scenes ?? []).map((s) => [s.sceneId, s.name]));
  return (
    <div aria-label="节奏报告内容">
      {/* 剧情点完成状态（需求 10.2） */}
      <h4 className="nwa-panel__title">剧情点完成状态</h4>
      <PacingStatusChart report={report} />
      {report.plotPoints.length === 0 ? (
        <p className="nwa-empty">无必含剧情点。</p>
      ) : (
        <ul className="nwa-list">
          {report.plotPoints.map((p, i) => (
            <li key={`${p.point}-${i}`} className="nwa-list__item">
              <span className="nwa-grow">{p.point}</span>
              <span className="nwa-muted">{PLOT_STATUS_LABELS[p.status]}</span>
            </li>
          ))}
        </ul>
      )}

      {/* 被违反的禁止事项（需求 10.3） */}
      <h4 className="nwa-panel__title">被违反的禁止事项</h4>
      {report.violatedForbiddenPoints.length === 0 ? (
        <p className="nwa-empty">未发现违反禁止事项。</p>
      ) : (
        <ul className="nwa-list">
          {report.violatedForbiddenPoints.map((v, i) => (
            <li key={`${v}-${i}`} className="nwa-list__item">
              <span className="nwa-grow">{v}</span>
            </li>
          ))}
        </ul>
      )}

      {/* 按场景的问题与建议（需求 10.4） */}
      <h4 className="nwa-panel__title">场景节奏问题</h4>
      {report.sceneIssues.length === 0 ? (
        <p className="nwa-empty">未发现场景节奏问题。</p>
      ) : (
        <ul className="nwa-list">
          {report.sceneIssues.map((issue, i) => {
            const displayName = nameMap.get(issue.sceneId) || issue.sceneId;
            return (
              <li key={`${issue.sceneId}-${i}`} className="nwa-list__item" style={{ display: 'block' }}>
                <div>
                  <strong>{displayName}</strong>
                  <span className="nwa-muted">　优先级：{PRIORITY_LABELS[issue.priority]}</span>
                </div>
                <div>
                  <strong>问题：</strong>
                  {issue.issue}
                </div>
                <div>
                  <strong>建议：</strong>
                  {issue.suggestion}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * 报告视图：展示字数报告与节奏报告，并提供触发检查的按钮（需求 14.4）。
 */
export function ReportView({
  chapterId,
  wordCountReport,
  pacingReport,
  onWordCountReport,
  onPacingReport,
  onError,
  client = apiClient,
  scenes,
}: ReportViewProps): JSX.Element {
  const [wordCountBusy, setWordCountBusy] = useState(false);
  const [pacingBusy, setPacingBusy] = useState(false);

  const handleError = useCallback(
    (error: unknown) => {
      if (isAbort(error)) return;
      onError?.(error);
    },
    [onError],
  );

  const handleRunWordCount = useCallback(async () => {
    if (wordCountBusy) return;
    setWordCountBusy(true);
    try {
      const report = await client.blueprint.wordCount.run(chapterId);
      onWordCountReport?.(report);
    } catch (error) {
      handleError(error);
    } finally {
      setWordCountBusy(false);
    }
  }, [wordCountBusy, client, chapterId, onWordCountReport, handleError]);

  const handleRunPacing = useCallback(async () => {
    if (pacingBusy) return;
    setPacingBusy(true);
    try {
      const report = await client.blueprint.pacing.run(chapterId);
      onPacingReport?.(report);
    } catch (error) {
      handleError(error);
    } finally {
      setPacingBusy(false);
    }
  }, [pacingBusy, client, chapterId, onPacingReport, handleError]);

  return (
    <div className="nwa-panel" aria-label="检查报告">
      {/* 字数报告 */}
      <div className="nwa-panel" aria-label="字数报告">
        <div className="nwa-row">
          <h3 className="nwa-panel__title nwa-grow">字数报告</h3>
          <button
            type="button"
            className="nwa-button"
            disabled={wordCountBusy}
            onClick={() => void handleRunWordCount()}
          >
            {wordCountBusy ? '检查中…' : '字数检查'}
          </button>
        </div>
        {wordCountReport !== undefined ? (
          <WordCountReportSection report={wordCountReport} scenes={scenes} />
        ) : (
          <p className="nwa-empty">尚无字数报告，点击「字数检查」生成。</p>
        )}
      </div>

      {/* 节奏报告 */}
      <div className="nwa-panel" aria-label="节奏报告">
        <div className="nwa-row">
          <h3 className="nwa-panel__title nwa-grow">节奏报告</h3>
          <button
            type="button"
            className="nwa-button"
            disabled={pacingBusy}
            onClick={() => void handleRunPacing()}
          >
            {pacingBusy ? '检查中…' : '节奏检查'}
          </button>
        </div>
        {pacingReport !== undefined ? (
          <PacingReportSection report={pacingReport} scenes={scenes} />
        ) : (
          <p className="nwa-empty">尚无节奏报告，点击「节奏检查」生成。</p>
        )}
      </div>
    </div>
  );
}

export default ReportView;
