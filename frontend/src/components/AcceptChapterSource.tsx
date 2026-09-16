import { useEffect, useRef, useState } from 'react';
import apiClient, { isApiClientError } from '../api/apiClient.js';
import type { Chapter } from '../types/index.js';
import type { ChapterSourcePreview } from '../types/storyMemory.js';
import './story-memory.css';

interface Props {
  chapter: Chapter;
  editorContent: string;
  editorVersion: number;
  beforePreview: () => Promise<void>;
  onAccepted: (chapter: Chapter) => void;
  client?: Pick<typeof apiClient, 'chapters'>;
}

export function AcceptChapterSource({ chapter, editorContent, editorVersion, beforePreview, onAccepted, client = apiClient }: Props): JSX.Element {
  const identity = JSON.stringify([chapter.projectId, chapter.id, editorVersion, editorContent]);
  const latest = useRef(identity);
  latest.current = identity;
  const request = useRef<AbortController>();
  const [preview, setPreview] = useState<{ value: ChapterSourcePreview; identity: string }>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { latest.current = identity; return () => { request.current?.abort(); latest.current = ''; }; }, []);
  const stale = preview !== undefined && preview.identity !== identity;

  async function prepare() {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const started = identity;
    setBusy(true); setMessage(''); setConfirmed(false);
    try {
      await beforePreview();
      if (controller.signal.aborted || latest.current !== started) return;
      const value = await client.chapters.sourcePreview(chapter.id, controller.signal);
      if (controller.signal.aborted || latest.current !== started) return;
      if (value.chapterId !== chapter.id || value.content !== editorContent) {
        setMessage('已保存正文与当前编辑器不同，请重新载入章节后确认。'); return;
      }
      setPreview({ value, identity: started });
    } catch (error) {
      if (!controller.signal.aborted && latest.current === started) setMessage(isApiClientError(error) && error.status === 404 ? '此服务器暂不支持接受正文来源，请升级后重试。' : '无法准备正文来源，请检查保存状态后重试。');
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  async function accept() {
    if (!preview || stale || !confirmed || busy) return;
    const snapshot = preview;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setMessage('');
    try {
      const saved = await client.chapters.acceptSource(chapter.id, {
        expectedRevision: snapshot.value.revision, expectedContentHash: snapshot.value.contentHash,
      }, controller.signal);
      if (controller.signal.aborted || latest.current !== snapshot.identity) return;
      if (saved.id !== chapter.id || saved.projectId !== chapter.projectId || saved.content !== snapshot.value.content) throw new Error('Source acceptance response does not match the confirmed chapter');
      onAccepted(saved); setPreview(undefined); setConfirmed(false); setMessage('所确认的已保存正文已接受为来源，记忆同步独立进行。');
    } catch (error) {
      if (!controller.signal.aborted && latest.current === snapshot.identity) setMessage(isApiClientError(error) && error.status === 409
        ? '正文版本已变化，本次未接受。预览和手工稿已保留，请重新读取后确认。'
        : '接受来源失败，正文和预览已保留，请重试。');
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  return <section className="nwa-source-accept" aria-label="接受正文来源">
    <p className="nwa-muted">普通保存保留手工稿；接受后，这一版正文可供后续章节记忆检索。后续改写会撤回过期来源。</p>
    <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy || !editorContent.trim()} onClick={() => void prepare()}>{preview ? '重新读取保存版本' : '查看并接受正文来源'}</button>
    {message ? <p role="status">{message}</p> : null}
    {preview ? <div>
      <h4>{preview.value.title} · 保存版本 {preview.value.revision}</h4>
      <pre className="nwa-memory-evidence">{preview.value.content}</pre>
      {stale ? <p role="status">编辑内容已变化，此预览已过期，请重新读取保存版本。</p> : null}
      <label><input type="checkbox" checked={confirmed} disabled={busy || stale} onChange={(event) => setConfirmed(event.target.checked)} />我已检查以上完整正文，确认接受此版本作为来源</label>
      <div className="nwa-memory-actions"><button type="button" className="nwa-button nwa-button--sm" disabled={busy || stale || !confirmed} onClick={() => void accept()}>确认接受为来源</button><button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy} onClick={() => { setPreview(undefined); setConfirmed(false); }}>取消</button></div>
    </div> : null}
  </section>;
}
