/**
 * 场景列表（任务 12.3，需求 14.3）。
 *
 * 渲染章节蓝图 {@link ChapterBlueprint.scenes} 的每个场景字段摘要（name、
 * target_words、purpose、emotion、pacing、must_include 等），并为每个场景提供
 * 「写作」「扩写」「重写」三个操作入口。点击某操作入口时，在该场景卡片下方展开
 * 对应的 {@link SceneStreamView}，由其复用 ChatPanel 流式范式调用后端并实时渲染
 * 生成的场景正文（需求 14.3）。
 *
 * 本组件不直接发起后端调用（流式调用下放给 SceneStreamView），仅负责场景展示与
 * 操作入口编排。后端错误经 `onError` 上抛（需求 14.6）。
 */
import { useCallback, useState } from 'react';
import apiClient from '../api/apiClient.js';
import type { ChapterBlueprint, Id, Scene } from '../types/index.js';
import SceneStreamView, { type SceneOperation } from './SceneStreamView.js';
import './components.css';

/** 本组件所依赖的最小客户端接口（透传给 {@link SceneStreamView}，便于测试注入）。 */
export type SceneListClient = Pick<typeof apiClient, 'blueprint'>;

export interface SceneListProps {
  /** 要展示的章节蓝图。 */
  blueprint: ChapterBlueprint;
  /** 目标章节标识符（透传给流式视图）。 */
  chapterId: Id;
  /** 将后端/运行时错误上抛至全局错误提示（需求 14.6）。 */
  onError?: (error: unknown) => void;
  /** 某场景流式生成完成后回调（携带 scene_id 与完整正文）。 */
  onSceneComplete?: (sceneId: string, fullText: string) => void;
  /** 可注入的客户端（默认使用共享 {@link apiClient}）。 */
  client?: SceneListClient;
}

const OPERATION_LABELS: Record<SceneOperation, string> = {
  write: '写作',
  expand: '扩写',
  rewrite: '重写',
};

const OPERATIONS: SceneOperation[] = ['write', 'expand', 'rewrite'];

/** 单个场景的字段摘要 + 操作入口 + 展开的流式视图。 */
function SceneCard({
  scene,
  chapterId,
  onError,
  onSceneComplete,
  client,
}: {
  scene: Scene;
  chapterId: Id;
  onError?: (error: unknown) => void;
  onSceneComplete?: (sceneId: string, fullText: string) => void;
  client?: SceneListClient;
}): JSX.Element {
  // 当前展开的操作（null 表示未展开任何流式视图）。
  const [activeOp, setActiveOp] = useState<SceneOperation | null>(null);

  const handleToggle = useCallback((op: SceneOperation) => {
    setActiveOp((prev) => (prev === op ? null : op));
  }, []);

  const handleComplete = useCallback(
    (fullText: string) => {
      onSceneComplete?.(scene.scene_id, fullText);
    },
    [onSceneComplete, scene.scene_id],
  );

  return (
    <li className="nwa-list__item" style={{ display: 'block' }}>
      <div className="nwa-row">
        <span className="nwa-grow">
          <strong>{scene.name}</strong>
          <span className="nwa-muted">　目标 {scene.target_words} 字</span>
        </span>
      </div>

      {/* 场景字段摘要 */}
      <dl className="nwa-muted" style={{ margin: '0.25rem 0' }}>
        {scene.purpose ? (
          <div>
            <strong>目的：</strong>
            {scene.purpose}
          </div>
        ) : null}
        {scene.location ? (
          <div>
            <strong>地点：</strong>
            {scene.location}
          </div>
        ) : null}
        {scene.characters.length > 0 ? (
          <div>
            <strong>出场角色：</strong>
            {scene.characters.join('、')}
          </div>
        ) : null}
        {scene.emotion ? (
          <div>
            <strong>情绪：</strong>
            {scene.emotion}
          </div>
        ) : null}
        {scene.pacing ? (
          <div>
            <strong>节奏：</strong>
            {scene.pacing}
          </div>
        ) : null}
        {scene.must_include.length > 0 ? (
          <div>
            <strong>必含要点：</strong>
            {scene.must_include.join('、')}
          </div>
        ) : null}
        {scene.ending_state ? (
          <div>
            <strong>结束状态：</strong>
            {scene.ending_state}
          </div>
        ) : null}
      </dl>

      {/* 操作入口：写作 / 扩写 / 重写 */}
      <div className="nwa-tabs" role="group" aria-label={`场景操作：${scene.name}`}>
        {OPERATIONS.map((op) => {
          const active = op === activeOp;
          return (
            <button
              key={op}
              type="button"
              className={`nwa-tab${active ? ' nwa-tab--active' : ''}`}
              aria-pressed={active}
              onClick={() => handleToggle(op)}
            >
              {OPERATION_LABELS[op]}
            </button>
          );
        })}
      </div>

      {/* 展开的流式视图（需求 14.3） */}
      {activeOp !== null ? (
        <SceneStreamView
          key={activeOp}
          chapterId={chapterId}
          sceneId={scene.scene_id}
          operation={activeOp}
          onError={onError}
          onComplete={handleComplete}
          client={client}
        />
      ) : null}
    </li>
  );
}

/**
 * 场景列表：渲染蓝图各场景摘要与写作/扩写/重写操作入口（需求 14.3）。
 */
export function SceneList({
  blueprint,
  chapterId,
  onError,
  onSceneComplete,
  client = apiClient,
}: SceneListProps): JSX.Element {
  return (
    <div className="nwa-panel" aria-label="场景列表">
      <h3 className="nwa-panel__title">场景（{blueprint.scenes.length}）</h3>
      {blueprint.scenes.length === 0 ? (
        <p className="nwa-empty">该蓝图暂无场景。</p>
      ) : (
        <ul className="nwa-list">
          {blueprint.scenes.map((scene) => (
            <SceneCard
              key={scene.scene_id}
              scene={scene}
              chapterId={chapterId}
              onError={onError}
              onSceneComplete={onSceneComplete}
              client={client}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export default SceneList;
