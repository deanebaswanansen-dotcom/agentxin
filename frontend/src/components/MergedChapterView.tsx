/**
 * 整章合并预览与采用视图（任务 12.4，需求 14.5）。
 *
 * 提供「合并整章」按钮：调用 `client.blueprint.merge(chapterId)` 按场景顺序拼接
 * 各场景正文为完整章节正文，得到 `{ content }`，并在本视图中预览合并后的整章
 * 正文。随后提供「采用到章节」按钮：点击时调用 `onAdoptChapterContent(content)`
 * 把合并正文写回章节编辑器（需求 14.5）。
 *
 * 注意：后端 `merge` 已将合并正文写入数据存储中对应章节的正文字段（需求 8.3），
 * 因此「采用到章节」用于把同一份正文同步到前端编辑器，使界面与持久化状态一致。
 *
 * 后端错误统一经 `onError` 上抛（由 13.2 接到 ErrorToast，需求 14.6）。
 */
import { useCallback, useState } from 'react';
import apiClient from '../api/apiClient.js';
import type { Id } from '../types/index.js';
import './components.css';

/** 本组件所依赖的最小客户端接口（便于测试时注入桩）。 */
export type MergedChapterClient = Pick<typeof apiClient, 'blueprint'>;

export interface MergedChapterViewProps {
  /** 目标章节标识符。 */
  chapterId: Id;
  /** 采用合并正文时回调，由父组件写回章节编辑器（需求 14.5）。 */
  onAdoptChapterContent?: (content: string) => void;
  /** 将后端/运行时错误上抛至全局错误提示（需求 14.6）。 */
  onError?: (error: unknown) => void;
  /** 可注入的客户端（默认使用共享 {@link apiClient}）。 */
  client?: MergedChapterClient;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * 整章合并预览：触发合并、预览整章正文、采用写回编辑器（需求 14.5）。
 */
export function MergedChapterView({
  chapterId,
  onAdoptChapterContent,
  onError,
  client = apiClient,
}: MergedChapterViewProps): JSX.Element {
  const [merging, setMerging] = useState(false);
  const [mergedContent, setMergedContent] = useState<string | null>(null);
  const [adopted, setAdopted] = useState(false);

  const handleError = useCallback(
    (error: unknown) => {
      if (isAbort(error)) return;
      onError?.(error);
    },
    [onError],
  );

  const handleMerge = useCallback(async () => {
    if (merging) return;
    setMerging(true);
    setAdopted(false);
    try {
      const result = await client.blueprint.merge(chapterId);
      setMergedContent(result.content);
    } catch (error) {
      handleError(error);
    } finally {
      setMerging(false);
    }
  }, [merging, client, chapterId, handleError]);

  const handleAdopt = useCallback(() => {
    if (mergedContent === null) return;
    onAdoptChapterContent?.(mergedContent);
    setAdopted(true);
  }, [mergedContent, onAdoptChapterContent]);

  return (
    <div className="nwa-panel" aria-label="整章合并">
      <div className="nwa-row">
        <h3 className="nwa-panel__title nwa-grow">整章合并</h3>
        <button
          type="button"
          className="nwa-button"
          disabled={merging}
          onClick={() => void handleMerge()}
        >
          {merging ? '合并中…' : '合并整章'}
        </button>
      </div>

      {/* 合并正文预览 */}
      <div className="nwa-stream" aria-label="合并正文预览">
        {mergedContent !== null ? (
          mergedContent
        ) : (
          <span className="nwa-empty">点击「合并整章」预览合并后的整章正文。</span>
        )}
      </div>

      <div className="nwa-row" style={{ justifyContent: 'flex-end', marginTop: '1rem' }}>
        {adopted && (
          <span className="nwa-muted" role="status">
            已采用
          </span>
        )}
        <button
          type="button"
          className="nwa-button"
          disabled={mergedContent === null}
          onClick={handleAdopt}
        >
          采用到章节
        </button>
      </div>
    </div>
  );
}

export default MergedChapterView;
