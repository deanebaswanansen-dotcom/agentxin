import { useEffect, useState } from 'react';
import { isApiClientError } from '../api/apiClient.js';
import type { WriteBriefItem, WriteBriefView } from '../types/writeBrief.js';
import './components.css';

interface WritingBriefPanelProps {
  targetKey: string;
  refreshKey?: string | number;
  load?: (signal: AbortSignal) => Promise<WriteBriefView>;
  locallyChanged?: boolean;
}

/** Read-only provenance. An unavailable endpoint must never create a verified-looking fallback. */
export function WritingBriefPanel({ targetKey, refreshKey = '', load, locallyChanged = false }: WritingBriefPanelProps): JSX.Element | null {
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; view?: WriteBriefView; failed?: boolean; missing?: boolean }>();
  const key = `${targetKey}:${refreshKey}:${retry}`;

  useEffect(() => {
    if (!load || locallyChanged) return;
    const controller = new AbortController();
    void load(controller.signal).then((view) => {
      if (!controller.signal.aborted) setResult({ key, view });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const missing = isApiClientError(error) && error.status === 404;
      setResult({ key, missing, failed: !missing });
    });
    return () => controller.abort();
  }, [key, load, locallyChanged]);

  if (!load) return null;
  const current = result?.key === key ? result : undefined;
  if (current?.missing) return null;
  const view = current?.view;
  const brief = view?.brief;
  const status = locallyChanged ? '已过期' : view?.status === 'current' ? '当前' : view?.status === 'stale' ? '已过期' : view?.status === 'unavailable' ? '暂不可用' : current?.failed ? '加载失败' : '加载中';
  const title = view?.origin === 'generation' ? '本次写前依据' : '下次写前依据';
  const groups: Array<[string, WriteBriefItem[] | undefined]> = [
    ['本次目标', brief?.objective], ['必须承接', brief?.required], ['禁项', brief?.forbidden], ['作者约束', brief?.authorConstraints],
  ];

  return (
    <details className="nwa-writing-brief" aria-label="写前依据">
      <summary>{title}<span className="nwa-writing-brief__status">{status}</span></summary>
      {locallyChanged ? <p className="nwa-muted">本地内容有修改，保存后重新读取写前依据。</p> : null}
      {!locallyChanged && view?.reason ? <p className="nwa-muted">{view.reason}</p> : null}
      {!locallyChanged && view?.origin === 'preview' && brief ? <p className="nwa-muted">根据当前已保存资料预览，生成时会固定本次依据。</p> : null}
      {!locallyChanged && current?.failed ? <p role="status">写前依据读取失败，请重试。</p> : null}
      {brief ? <>
        <dl>
          {groups.map(([label, items]) => <div key={label}><dt>{label}</dt><dd>{items?.length ? <ul>{items.map((item, index) => {
            const labels = item.sourceKeys.map((sourceKey) => brief.sources.find((source) => source.key === sourceKey)?.label).filter(Boolean);
            return <li key={index}>{item.text}{labels.length ? <small className="nwa-muted nwa-writing-brief__source">依据：{labels.join('、')}</small> : null}</li>;
          })}</ul> : '暂无'}</dd></div>)}
        </dl>
        <h4>来源章集 / 资料</h4>
        {brief.sources.length ? <ul>{brief.sources.map((source) => <li key={source.key}>{source.excerpt ? <details><summary>{source.label}{source.revision !== undefined ? ` · 修订 ${source.revision}` : ''}</summary><p className="nwa-muted">{source.excerpt.slice(0, 240)}{source.excerpt.length > 240 ? '…' : ''}</p></details> : <>{source.label}{source.revision !== undefined ? ` · 修订 ${source.revision}` : ''}</>}</li>)}</ul> : <p className="nwa-muted">尚无可定位来源。</p>}
      </> : null}
      <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={locallyChanged} onClick={() => setRetry((value) => value + 1)}>重新读取依据</button>
    </details>
  );
}
