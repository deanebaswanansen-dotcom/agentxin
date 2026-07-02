/**
 * 单场景流式写作/扩写/重写视图（任务 12.3，需求 14.3）。
 *
 * 复用 {@link ChatPanel} 的流式渲染范式：用 `apiClient.blueprint` 的流式方法
 * （`writeScene` / `expandScene` / `rewriteScene`）发起 SSE 请求，借助 `onDelta`
 * 把模型代理逐段返回的文本增量累加到本地 `liveText` 并实时渲染，直至流式响应
 * 结束（需求 14.3）。流式过程中可中止（AbortController），组件卸载时也会中止
 * 仍在进行的请求，避免对已卸载组件 setState。
 *
 * 三种操作的额外输入：
 *  - 写作（write）：无额外输入。
 *  - 扩写（expand）：需输入新增字数 `addWords`（{@link ExpandSceneBody}）。
 *  - 重写（rewrite）：需输入修改要求 `instruction`（{@link RewriteSceneBody}）。
 *
 * 后端错误统一经 `onError` 上抛（由 13.2 接到 ErrorToast，需求 14.6）。生成完成
 * 后可通过 `onComplete` 通知父组件（用于刷新场景正文展示）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../api/apiClient.js';
import type { Id } from '../types/index.js';
import './components.css';

/** 场景级流式操作类型。 */
export type SceneOperation = 'write' | 'expand' | 'rewrite';

/** 本视图所依赖的最小客户端接口（便于测试时注入桩）。 */
export type SceneStreamClient = Pick<typeof apiClient, 'blueprint'>;

export interface SceneStreamViewProps {
  /** 目标章节标识符。 */
  chapterId: Id;
  /** 目标场景 scene_id。 */
  sceneId: string;
  /** 操作类型：写作 / 扩写 / 重写。 */
  operation: SceneOperation;
  /** 将后端/运行时错误上抛至全局错误提示（需求 14.6）。 */
  onError?: (error: unknown) => void;
  /** 流式正常结束后回调，携带完整生成正文（父组件据此刷新展示）。 */
  onComplete?: (fullText: string) => void;
  /** 可注入的客户端（默认使用共享 {@link apiClient}）。 */
  client?: SceneStreamClient;
}

const OPERATION_LABELS: Record<SceneOperation, string> = {
  write: '写作',
  expand: '扩写',
  rewrite: '重写',
};

/** 扩写新增字数的允许区间（需求 11.2）。 */
const MIN_ADD_WORDS = 1;
const MAX_ADD_WORDS = 100000;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * 复用 ChatPanel 流式范式的单场景写作/扩写/重写视图。随 SSE 增量实时渲染正文，
 * 直至结束（需求 14.3），并支持中止。
 */
export function SceneStreamView({
  chapterId,
  sceneId,
  operation,
  onError,
  onComplete,
  client = apiClient,
}: SceneStreamViewProps): JSX.Element {
  const [liveText, setLiveText] = useState('');
  const [fullText, setFullText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [done, setDone] = useState(false);

  // 扩写 / 重写的额外输入。
  const [addWordsInput, setAddWordsInput] = useState('500');
  const [instruction, setInstruction] = useState('');

  const abortRef = useRef<AbortController | null>(null);

  // 卸载时中止仍在进行的流，避免对已卸载组件 setState。
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const parsedAddWords = Number(addWordsInput);
  const addWordsValid =
    addWordsInput.trim().length > 0 &&
    Number.isInteger(parsedAddWords) &&
    parsedAddWords >= MIN_ADD_WORDS &&
    parsedAddWords <= MAX_ADD_WORDS;
  const instructionValid = instruction.trim().length > 0;

  const canStart =
    !streaming &&
    (operation === 'write' ||
      (operation === 'expand' && addWordsValid) ||
      (operation === 'rewrite' && instructionValid));

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleStart = useCallback(async () => {
    if (streaming) return;
    if (operation === 'expand' && !addWordsValid) return;
    if (operation === 'rewrite' && !instructionValid) return;

    setLiveText('');
    setFullText('');
    setDone(false);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // 用本地变量累积全部增量，确保中止时也能保留已生成内容。
    let accumulated = '';
    const options = {
      signal: controller.signal,
      onDelta: (delta: string) => {
        accumulated += delta;
        setLiveText(accumulated);
      },
    };

    try {
      let full: string;
      if (operation === 'expand') {
        full = await client.blueprint.expandScene(
          chapterId,
          sceneId,
          { addWords: parsedAddWords },
          options,
        );
      } else if (operation === 'rewrite') {
        full = await client.blueprint.rewriteScene(
          chapterId,
          sceneId,
          { instruction: instruction.trim() },
          options,
        );
      } else {
        full = await client.blueprint.writeScene(chapterId, sceneId, options);
      }
      setFullText(full);
      setDone(true);
      onComplete?.(full);
    } catch (error) {
      if (isAbort(error)) {
        // 用户中止：保留已生成的部分文本以供查看。
        if (accumulated.length > 0) {
          setFullText(accumulated);
          setDone(true);
        }
      } else {
        onError?.(error);
      }
    } finally {
      setLiveText('');
      setStreaming(false);
      abortRef.current = null;
    }
  }, [
    streaming,
    operation,
    addWordsValid,
    instructionValid,
    parsedAddWords,
    instruction,
    client,
    chapterId,
    sceneId,
    onComplete,
    onError,
  ]);

  const label = OPERATION_LABELS[operation];

  return (
    <div className="nwa-panel" aria-label={`场景${label}`}>
      <div className="nwa-row">
        <h4 className="nwa-panel__title nwa-grow">场景{label}</h4>
        {streaming ? (
          <button type="button" className="nwa-button nwa-button--danger" onClick={handleStop}>
            停止
          </button>
        ) : (
          <button
            type="button"
            className="nwa-button"
            disabled={!canStart}
            onClick={() => void handleStart()}
          >
            开始{label}
          </button>
        )}
      </div>

      {/* 扩写：新增字数输入（需求 11.2） */}
      {operation === 'expand' ? (
        <label className="nwa-field">
          <span className="nwa-field__label">新增字数</span>
          <input
            className="nwa-input"
            type="number"
            inputMode="numeric"
            min={MIN_ADD_WORDS}
            max={MAX_ADD_WORDS}
            step={100}
            aria-label="新增字数"
            value={addWordsInput}
            disabled={streaming}
            onChange={(e) => setAddWordsInput(e.target.value)}
          />
          {!addWordsValid && addWordsInput.trim().length > 0 ? (
            <span className="nwa-field__hint nwa-muted">
              新增字数需为 {MIN_ADD_WORDS}–{MAX_ADD_WORDS} 之间的整数。
            </span>
          ) : null}
        </label>
      ) : null}

      {/* 重写：修改要求输入（需求 12.5） */}
      {operation === 'rewrite' ? (
        <label className="nwa-field">
          <span className="nwa-field__label">修改要求</span>
          <textarea
            className="nwa-textarea"
            aria-label="修改要求"
            rows={3}
            placeholder="描述希望如何重写该场景…"
            value={instruction}
            disabled={streaming}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </label>
      ) : null}

      {/* 流式正文渲染区（需求 14.3） */}
      <div className="nwa-stream" aria-label={`${label}结果`} aria-live="polite">
        {streaming ? liveText : done ? fullText : <span className="nwa-empty">点击「开始{label}」生成场景正文。</span>}
      </div>
      {streaming ? <p className="nwa-muted" role="status">生成中…</p> : null}
    </div>
  );
}

export default SceneStreamView;
