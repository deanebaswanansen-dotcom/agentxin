/**
 * 章节蓝图面板（任务 12.2，需求 14.1、14.2、14.7）。
 *
 * 章节工作区的蓝图容器组件，编排蓝图全生命周期：
 *  - 默认展示空状态与 {@link BlueprintForm}，避免把尚未创建蓝图的章节当作异常请求。
 *  - 用户可手动调用 `client.blueprint.get(chapterId)` 读取该章节最新蓝图。
 *  - 有蓝图时展示章节级字段摘要 + 场景列表（{@link SceneList}），并组合
 *    {@link ReportView}（字数/节奏报告）与 {@link MergedChapterView}（整章合并与
 *    采用）（需求 14.1）。
 *  - 用户在表单提交后调用 `client.blueprint.generate`，成功后刷新展示。
 *
 * 客户端通过 `client` prop 注入（默认共享 {@link apiClient}），便于测试。后端错误
 * 统一经 `onError` 上抛至全局错误提示（需求 14.6）；把整章合并正文写回章节编辑器
 * 的回调为 `onAdoptChapterContent`（需求 14.5）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient, { isApiClientError } from '../api/apiClient.js';
import type {
  ChapterBlueprint,
  GenerateBlueprintBody,
  Id,
  PacingReport,
  WordCountReport,
} from '../types/index.js';
import BlueprintForm from './BlueprintForm.js';
import { EmptyIllustration } from './EmptyIllustration.js';
import SceneList from './SceneList.js';
import ReportView from './ReportView.js';
import MergedChapterView from './MergedChapterView.js';
import './components.css';

/** 本面板所依赖的最小客户端接口（便于测试时注入桩）。 */
export type BlueprintPanelClient = Pick<typeof apiClient, 'blueprint'>;

export interface ChapterBlueprintPanelProps {
  /** 当前章节标识符。 */
  chapterId: Id;
  /** 把整章合并正文写回章节编辑器的回调（需求 14.5）。 */
  onAdoptChapterContent?: (content: string) => void;
  /** 将后端/运行时错误上抛至全局错误提示（需求 14.6）。 */
  onError?: (error: unknown) => void;
  /** 可注入的客户端（默认使用共享 {@link apiClient}）。 */
  client?: BlueprintPanelClient;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** 判断错误是否为「资源不存在」（章节尚无蓝图，需求 14.7）。 */
function isNotFound(error: unknown): boolean {
  return isApiClientError(error) && error.code === 'NOT_FOUND';
}

/** 章节级字段摘要展示。 */
function BlueprintSummary({ blueprint }: { blueprint: ChapterBlueprint }): JSX.Element {
  return (
    <div className="nwa-panel" aria-label="章节蓝图摘要">
      <h3 className="nwa-panel__title">{blueprint.title || '章节蓝图'}</h3>
      <dl className="nwa-muted" style={{ margin: 0 }}>
        <div>
          <strong>目标字数：</strong>
          {blueprint.target_words} 字
        </div>
        {blueprint.main_goal ? (
          <div>
            <strong>主目标：</strong>
            {blueprint.main_goal}
          </div>
        ) : null}
        {blueprint.tone ? (
          <div>
            <strong>基调：</strong>
            {blueprint.tone}
          </div>
        ) : null}
        {blueprint.pacing ? (
          <div>
            <strong>节奏：</strong>
            {blueprint.pacing}
          </div>
        ) : null}
        {blueprint.emotional_curve ? (
          <div>
            <strong>情绪曲线：</strong>
            {blueprint.emotional_curve}
          </div>
        ) : null}
        {blueprint.required_plot_points.length > 0 ? (
          <div>
            <strong>必含剧情点：</strong>
            {blueprint.required_plot_points.join('、')}
          </div>
        ) : null}
        {blueprint.forbidden_points.length > 0 ? (
          <div>
            <strong>禁止事项：</strong>
            {blueprint.forbidden_points.join('、')}
          </div>
        ) : null}
        {blueprint.ending_hook ? (
          <div>
            <strong>章末钩子：</strong>
            {blueprint.ending_hook}
          </div>
        ) : null}
      </dl>
    </div>
  );
}

/**
 * 章节蓝图面板容器。读取蓝图、空状态生成、展示蓝图与场景列表、字数/节奏报告与
 * 整章合并采用（需求 14.1、14.2、14.5、14.7）。
 */
export function ChapterBlueprintPanel({
  chapterId,
  onAdoptChapterContent,
  onError,
  client = apiClient,
}: ChapterBlueprintPanelProps): JSX.Element {
  const [blueprint, setBlueprint] = useState<ChapterBlueprint | null>(null);
  const [loading, setLoading] = useState(false);
  // 区分「确实无蓝图（NOT_FOUND）」与「加载/其他错误」状态。
  const [notFound, setNotFound] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [wordCountReport, setWordCountReport] = useState<WordCountReport | undefined>(undefined);
  const [pacingReport, setPacingReport] = useState<PacingReport | undefined>(undefined);

  const requestIdRef = useRef(0);

  const handleError = useCallback(
    (error: unknown) => {
      if (isAbort(error)) return;
      onError?.(error);
    },
    [onError],
  );

  const load = useCallback(
    async () => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setLoading(true);
      setNotFound(false);
      try {
        const result = await client.blueprint.get(chapterId, undefined);
        if (requestIdRef.current !== requestId) return;
        setBlueprint(result);
      } catch (error) {
        if (isAbort(error)) return;
        if (requestIdRef.current !== requestId) return;
        if (isNotFound(error)) {
          // 章节尚无蓝图：展示空状态 + 生成表单（需求 14.7）。
          setBlueprint(null);
          setNotFound(true);
        } else {
          setBlueprint(null);
          handleError(error);
        }
      } finally {
        if (requestIdRef.current === requestId) setLoading(false);
      }
    },
    [client, chapterId, handleError],
  );

  // Reset local blueprint state when the drawer switches to another chapter.
  useEffect(() => {
    requestIdRef.current += 1;
    setBlueprint(null);
    setNotFound(true);
    setLoading(false);
    setWordCountReport(undefined);
    setPacingReport(undefined);
  }, [chapterId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleGenerate = useCallback(
    async (body: GenerateBlueprintBody) => {
      if (generating) return;
      setGenerating(true);
      try {
        const result = await client.blueprint.generate(chapterId, body);
        setBlueprint(result);
        setNotFound(false);
      } catch (error) {
        handleError(error);
      } finally {
        setGenerating(false);
      }
    },
    [generating, client, chapterId, handleError],
  );

  return (
    <section className="nwa-panel" aria-label="章节蓝图">
      <h2 className="nwa-panel__title">章节蓝图</h2>

      {loading ? <p className="nwa-muted">加载中…</p> : null}

      {/* 空状态：尚无蓝图，提示先生成（需求 14.7） */}
      {!loading && blueprint === null && notFound ? (
        <>
          <div className="nwa-empty-visual">
            <EmptyIllustration variant="blueprint" />
            <p className="nwa-empty">该章节尚无蓝图，请先生成章节蓝图。</p>
          </div>
          <button
            type="button"
            className="nwa-button nwa-button--ghost"
            disabled={generating || loading}
            onClick={() => void load()}
          >
            加载已有蓝图
          </button>
          <BlueprintForm onGenerate={(body) => void handleGenerate(body)} disabled={generating} />
        </>
      ) : null}

      {/* 有蓝图：展示章节级字段 + 场景列表 + 报告 + 整章合并（需求 14.1、14.4、14.5） */}
      {!loading && blueprint !== null ? (
        <>
          <BlueprintSummary blueprint={blueprint} />

          {/* 重新生成蓝图（替换既有蓝图，需求 5.3） */}
          <details>
            <summary className="nwa-muted">重新生成蓝图</summary>
            <BlueprintForm
              onGenerate={(body) => void handleGenerate(body)}
              disabled={generating}
              initialTargetWords={blueprint.target_words}
            />
          </details>

          <SceneList
            blueprint={blueprint}
            chapterId={chapterId}
            onError={onError}
            client={client}
          />

          {/* NEW: 支持章节蓝图 + 分场景工作流增强：展示后可直接点场景“写作/扩写/重写”流式生成；
              完整章使用 Merged 合并 + 采用；或用右侧 Slash /下一章 自动 plan_chapter + scenes 写全章 */}
          <div className="nwa-blueprint-workflow" style={{ fontSize: '0.8rem' }}>
            <span className="nwa-muted">分场景流程已就绪：</span>
            <button
              type="button"
              className="nwa-button nwa-button--ghost"
              style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
              onClick={() => {
                // 提示用户使用右侧 Agent 或直接场景操作；如需可在此触发更多（未来 plan_chapter 专用）
                alert('请在右侧 AI 对话用 /下一章 或直接点击上方场景卡的“写作”按钮分场景生成。生成后用“合并整章”采用。');
              }}
            >
              触发分场景写完整章指引
            </button>
          </div>

          <ReportView
            chapterId={chapterId}
            wordCountReport={wordCountReport}
            pacingReport={pacingReport}
            onWordCountReport={setWordCountReport}
            onPacingReport={setPacingReport}
            onError={onError}
            client={client}
            scenes={blueprint?.scenes?.map((s) => ({ sceneId: s.scene_id, name: s.name }))}
          />

          <MergedChapterView
            chapterId={chapterId}
            onAdoptChapterContent={onAdoptChapterContent}
            onError={onError}
            client={client}
          />
        </>
      ) : null}
    </section>
  );
}

export default ChapterBlueprintPanel;
