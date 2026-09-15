import { useEffect, useRef, useState } from 'react';
import apiClient, { isApiClientError } from '../api/apiClient.js';
import type { MemorySourceNavigation, MemorySourceRef, SourceMemoryEntry, SourceMemoryMode, StoryControl, StoryControlInput, StoryMemoryQuery, StoryMemoryWorkspaceView, StoryThreadView } from '../types/storyMemory.js';
import './story-memory.css';

export interface StoryMemoryPanelProps {
  projectId: string;
  mode: SourceMemoryMode;
  refreshKey?: string | number;
  bodyState?: 'saved' | 'unsaved' | 'none';
  onNavigate?: (target: MemorySourceNavigation) => void | Promise<void>;
  onControlsChanged?: () => void;
  client?: Pick<typeof apiClient, 'storyMemory'>;
}
type Tab = 'facts' | 'controls' | 'threads' | 'search';
interface ControlDraft { control: StoryControlInput; expectedRevision: number }
const SYNC_LABELS = { pending: '等待同步', running: '同步中', succeeded: '同步完成', failed: '同步失败', stale: '来源已过期', legacy_untracked: '尚无已接受来源' };
const KIND_LABELS = { preference: '表达偏好', fact_correction: '事实纠错', thread: '作者伏笔' };
const THREAD_LABELS = { planted: '已埋设', echoed: '已呼应', resolved: '已回收', dropped: '已作废' };
const reasonLabels: Record<string, string> = { missing_evidence: '未提供可定位正文证据', citation_mismatch: '证据与冻结正文不匹配', missing_state_identity: '状态对象尚不明确', missing_state_value: '状态值尚不明确', missing_thread_action: '伏笔状态尚不明确', conflicting_state_claims: '同一来源中存在冲突的状态' };
const sourceKey = (source: MemorySourceRef) => source.acceptanceId;
const optionalNumber = (value: string) => value === '' ? undefined : Number(value);

/** Remount project-owned draft state even if a caller forgets to provide a React key. */
export function StoryMemoryPanel(props: StoryMemoryPanelProps): JSX.Element {
  return <StoryMemoryContent key={`${props.mode}:${props.projectId}`} {...props} />;
}

function StoryMemoryContent({ projectId, mode, refreshKey = '', bodyState = 'none', onNavigate, onControlsChanged, client = apiClient }: StoryMemoryPanelProps): JSX.Element {
  const unit = mode === 'novel' ? '章' : '集';
  const [view, setView] = useState<StoryMemoryWorkspaceView>();
  const [tab, setTab] = useState<Tab>('facts');
  const [query, setQuery] = useState<StoryMemoryQuery>({});
  const [boundary, setBoundary] = useState('');
  const [search, setSearch] = useState('');
  const [topK, setTopK] = useState('5');
  const [budget, setBudget] = useState('6000');
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState<ControlDraft>();
  const [conflict, setConflict] = useState(false);
  const [remove, setRemove] = useState<{ control: StoryControl; expectedRevision: number }>();
  const [busy, setBusy] = useState(false);
  const readRequest = useRef<AbortController>();
  const mutation = useRef<AbortController>();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; readRequest.current?.abort(); mutation.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController(); readRequest.current?.abort(); readRequest.current = controller;
    setLoading(true); setMissing(false);
    void client.storyMemory.workspace(projectId, query, controller.signal).then((next) => {
      if (controller.signal.aborted || !alive.current) return;
      if (next.projectId !== projectId || next.mode !== mode) { setReadFailed(true); setMessage('返回的记忆与当前项目不一致，请重试。'); return; }
      setReadFailed(false); setView(next);
      if (query.beforeUnit === undefined) setBoundary(String(next.beforeUnit));
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !alive.current) return;
      setReadFailed(true);
      if (isApiClientError(error) && error.status === 404) { setMissing(true); setView(undefined); }
      else setMessage('故事记忆暂时读取失败，请重试。');
    }).finally(() => { if (!controller.signal.aborted && alive.current) setLoading(false); });
    return () => controller.abort();
  }, [client, projectId, mode, query, reload, refreshKey]);
  useEffect(() => {
    if (!view || !['pending', 'running'].includes(view.memorySync.status)) return;
    const timer = window.setTimeout(() => setReload((value) => value + 1), 2500);
    return () => window.clearTimeout(timer);
  }, [view, reload]);

  async function retrySync() {
    const controller = new AbortController(); mutation.current = controller; setBusy(true); setMessage('');
    try {
      const status = await client.storyMemory.retry(projectId, controller.signal);
      if (controller.signal.aborted || !alive.current) return;
      setView((current) => current ? { ...current, memorySync: status } : current);
      setReload((value) => value + 1);
    } catch { if (!controller.signal.aborted && alive.current) setMessage('记忆同步未完成，正文保存不受影响，请稍后重试。'); }
    finally { if (!controller.signal.aborted && alive.current) setBusy(false); }
  }

  function newControl(kind: StoryControl['kind']) {
    if (!view) return;
    setDraft({ expectedRevision: view.controls.revision, control: {
      kind, text: '', enabled: true, importance: 'advisory', fromUnit: view.beforeUnit,
      ...(kind === 'thread' ? { thread: { threadId: crypto.randomUUID(), title: '', status: 'planted', urgency: 'medium' } as const } : {}),
    } });
    setRemove(undefined); setConflict(false); setMessage(''); setTab('controls');
  }
  function editControl(control: StoryControl) {
    if (!view) return;
    const { revision: _revision, createdAt: _created, updatedAt: _updated, ...input } = control;
    setDraft({ expectedRevision: view.controls.revision, control: structuredClone(input) });
    setRemove(undefined); setConflict(false); setMessage(''); setTab('controls');
  }
  function editThread(thread: StoryThreadView) {
    const existing = view?.controls.items.find((control) => control.id === thread.controlId);
    if (existing) { editControl(existing); return; }
    if (!view) return;
    setDraft({ expectedRevision: view.controls.revision, control: {
      kind: 'thread', text: thread.text, enabled: true, importance: thread.importance, fromUnit: view.beforeUnit,
      ...(thread.source ? { source: thread.source } : {}),
      thread: { threadId: thread.threadId, title: thread.title, status: thread.status, urgency: thread.urgency,
        deadlineUnit: thread.deadlineUnit, requiredAtUnit: thread.requiredAtUnit },
    } });
    setRemove(undefined); setConflict(false); setMessage(''); setTab('controls');
  }
  function updateControl(patch: Partial<StoryControlInput>) {
    setDraft((current) => current ? { ...current, control: { ...current.control, ...patch } } : current);
  }
  function updateThread(patch: Partial<NonNullable<StoryControlInput['thread']>>) {
    if (draft?.control.thread) updateControl({ thread: { ...draft.control.thread, ...patch } });
  }
  async function saveControl() {
    if (!draft || busy || !draft.control.text.trim()) return;
    const control = draft.control;
    if (control.kind === 'fact_correction' && (!control.source || !control.resolutionConfirmed)) { setMessage('请选择已接受来源，并确认撤回影响。'); return; }
    if (!Number.isSafeInteger(control.fromUnit) || control.fromUnit < 1 || (control.throughUnit !== undefined && (!Number.isSafeInteger(control.throughUnit) || control.throughUnit < control.fromUnit))) { setMessage('请填写有效的生效章集范围。'); return; }
    const controller = new AbortController(); mutation.current = controller; setBusy(true); setMessage('');
    try {
      const controls = await client.storyMemory.saveControl(projectId, control, draft.expectedRevision, controller.signal);
      if (controller.signal.aborted || !alive.current) return;
      setView((current) => current ? { ...current, controls } : current); setDraft(undefined); setConflict(false);
      setMessage('作者记录已保存。'); setReload((value) => value + 1); onControlsChanged?.();
    } catch (error) {
      if (controller.signal.aborted || !alive.current) return;
      const collided = isApiClientError(error) && error.status === 409;
      setConflict(collided); setMessage(collided ? '作者记录已被更新，当前表单已保留。请读取最新版本作对照。' : '作者记录保存失败，当前表单已保留，请检查填写内容后重试。');
    } finally { if (!controller.signal.aborted && alive.current) setBusy(false); }
  }
  async function deleteControl() {
    if (!remove || !view || busy) return;
    const controller = new AbortController(); mutation.current = controller; setBusy(true); setMessage('');
    try {
      const controls = await client.storyMemory.removeControl(projectId, remove.control.id, remove.expectedRevision, controller.signal);
      if (controller.signal.aborted || !alive.current) return;
      setView((current) => current ? { ...current, controls } : current); setRemove(undefined); setReload((value) => value + 1); onControlsChanged?.();
      setMessage('作者记录已删除。');
    } catch (error) { if (!controller.signal.aborted && alive.current) { if (isApiClientError(error) && error.status === 409) setRemove(undefined); setMessage(isApiClientError(error) && error.status === 409 ? '删除前记录已被更新，请刷新核对后重新选择。' : '删除失败，记录仍保留，请重试。'); } }
    finally { if (!controller.signal.aborted && alive.current) setBusy(false); }
  }

  function sourceLabel(source: MemorySourceRef) {
    const title = view?.acceptedSources.find((item) => sourceKey(item.source) === sourceKey(source))?.title;
    return `第 ${source.unitNumber} ${unit}${title ? ` · ${title}` : ''} · 保存版本 ${source.revision}`;
  }
  function sourceDetails(source: MemorySourceRef, evidence: SourceMemoryEntry['evidence'] = []) {
    return <details className="nwa-memory-source"><summary>{sourceLabel(source)}</summary>
      {evidence.length ? evidence.map((item, index) => <div key={`${item.blockId}:${index}`}><blockquote>{item.quote}</blockquote>
        {onNavigate ? <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" onClick={() => void onNavigate({ source, evidence: item })}>定位正文证据</button> : null}</div>) : <p className="nwa-muted">此条暂无可定位的正文引文。</p>}
      {onNavigate ? <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" onClick={() => void onNavigate({ source })}>打开来源{unit}</button> : null}
    </details>;
  }
  function entryCard(entry: SourceMemoryEntry) {
    return <li key={`${entry.source.acceptanceId}:${entry.id}`} className="nwa-memory-card"><p>{entry.text}</p>
      {entry.evidenceStatus === 'unverified' ? <small className="nwa-muted">{reasonLabels[entry.evidenceReason ?? ''] ?? '尚未匹配正文证据，仅供参考'}</small> : <small className="nwa-muted">正文引文已匹配；请结合上下文判断含义</small>}
      {sourceDetails(entry.source, entry.evidence)}</li>;
  }
  function threadCard(thread: StoryThreadView) {
    return <li key={thread.id} className="nwa-memory-card"><strong>{thread.title}</strong><p>{thread.text}</p>
      <p className="nwa-memory-tags"><span>{THREAD_LABELS[thread.status]}</span><span>{thread.origin === 'author' ? '作者记录' : '正文来源'}</span>
        <span>{({ low: '低紧迫度', medium: '中紧迫度', high: '高紧迫度' })[thread.urgency]}</span>
        {thread.priority === 'overdue' ? <span>已超过回应期限</span> : thread.priority === 'due_soon' ? <span>即将到期</span> : null}
        {thread.requiredNow ? <span>本次必须回应</span> : null}</p>
      {thread.deadlineUnit ? <small>回应期限：第 {thread.deadlineUnit} {unit}　</small> : null}
      {thread.requiredAtUnit ? <small>指定第 {thread.requiredAtUnit} {unit} 必须回应</small> : null}
      {thread.source ? sourceDetails(thread.source) : <p className="nwa-muted">由作者添加，尚无正文来源。</p>}
      <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy} onClick={() => editThread(thread)}>编辑回应要求</button></li>;
  }

  const pendingThreads = view?.threads.filter((thread) => thread.status !== 'resolved' && thread.status !== 'dropped') ?? [];
  const closedThreads = view?.threads.filter((thread) => thread.status === 'resolved' || thread.status === 'dropped') ?? [];
  const currentRemote = draft?.control.id ? view?.controls.items.find((control) => control.id === draft.control.id) : undefined;
  return <section className="nwa-story-memory" aria-label="故事记忆工作台">
    <div className="nwa-memory-status"><span>正文：{bodyState === 'unsaved' ? '有未保存修改' : bodyState === 'saved' ? '已保存' : '未选中正文'}</span>
      <span role="status">记忆：{loading ? '读取中' : readFailed && view ? '读取失败 · 上次快照' : view ? SYNC_LABELS[view.memorySync.status] : '暂不可用'}</span>
      <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={loading} onClick={() => setReload((value) => value + 1)}>刷新记忆</button>
      {view && ['failed', 'pending', 'stale'].includes(view.memorySync.status) ? <button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy} onClick={() => void retrySync()}>单独重试记忆同步</button> : null}</div>
    <p className="nwa-muted">正文保存与记忆同步分别进行。这里只使用已接受的正文来源；作者记录单独保存。</p>
    {bodyState === 'unsaved' ? <p className="nwa-muted">当前本地修改尚未成为来源，以下记忆对应已经接受的保存版本。</p> : null}
    {readFailed && view ? <p className="nwa-muted">以下为上次读取的快照，尚未确认最新状态，请刷新后核对。</p> : null}
    {missing ? <p role="status">当前项目不可用，或服务器尚未提供故事记忆工作台，请确认项目并升级服务器。</p> : null}
    {message ? <p className="nwa-memory-notice" role="status">{message}</p> : null}
    {view ? <>
      <form className="nwa-memory-actions" onSubmit={(event) => { event.preventDefault(); const value = Number(boundary); if (!Number.isSafeInteger(value) || value < 1) { setMessage('章集序号必须是正整数。'); return; } setQuery((current) => ({ ...current, beforeUnit: value })); }}>
        <label>历史边界：写第 <input aria-label="历史章集边界" type="number" min="1" value={boundary} onChange={(event) => setBoundary(event.target.value)} /> {unit}之前</label>
        <button className="nwa-button nwa-button--ghost nwa-button--sm">查询历史</button><button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" onClick={() => setQuery((current) => ({ ...current, beforeUnit: undefined }))}>最新已接受来源</button>
      </form>
      <p className="nwa-muted">当前查看第 {view.beforeUnit} {unit}之前；共 {view.acceptedSources.length} 个当前有效来源。{view.origin === 'accepted_sources' && view.memorySync.status !== 'legacy_untracked' ? '缓存同步尚未完成，已直接读取当前冻结来源。' : ''}</p>
      <div className="nwa-memory-tabs" role="tablist" aria-label="故事记忆分类">{([['facts', '来源事实'], ['controls', '作者纠错与偏好'], ['threads', '伏笔账本'], ['search', '关键词检索']] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={tab === value} className={`nwa-button nwa-button--ghost nwa-button--sm${tab === value ? ' is-active' : ''}`} onClick={() => setTab(value)}>{label}</button>)}</div>
      {tab === 'facts' ? <div role="tabpanel"><h3>当前来源条目</h3>{view.entries.length ? <ul className="nwa-memory-list">{view.entries.map(entryCard)}</ul> : <p className="nwa-muted">当前历史边界内暂无已匹配的来源条目。</p>}
        <details><summary>未验证参考（{view.unverifiedReferences.length}）</summary><p className="nwa-muted">这些记录尚未匹配正文证据，不作为确定事实。</p><ul className="nwa-memory-list">{view.unverifiedReferences.map(entryCard)}</ul></details>
        <details><summary>已接受来源（{view.acceptedSources.length}）</summary><ul className="nwa-memory-list">{view.acceptedSources.map(({ source }) => <li key={sourceKey(source)}>{sourceDetails(source)}</li>)}</ul></details></div> : null}
      {tab === 'controls' ? <div role="tabpanel"><div className="nwa-memory-actions">{(['preference', 'fact_correction', 'thread'] as const).map((kind) => <button type="button" key={kind} className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy || Boolean(draft)} onClick={() => newControl(kind)}>新增{KIND_LABELS[kind]}</button>)}</div>
        {draft ? <form className="nwa-memory-form" onSubmit={(event) => { event.preventDefault(); void saveControl(); }}>
          <h3>{draft.control.id ? '编辑' : '新增'}{KIND_LABELS[draft.control.kind]}</h3><fieldset disabled={busy}>
            <label>记录内容<textarea required rows={4} value={draft.control.text} onChange={(event) => updateControl({ text: event.target.value })} /></label>
            <div className="nwa-memory-actions"><label><input type="checkbox" checked={draft.control.enabled} onChange={(event) => updateControl({ enabled: event.target.checked })} />启用记录</label>
              <label>约束强度<select value={draft.control.importance} onChange={(event) => updateControl({ importance: event.target.value as StoryControl['importance'] })}><option value="advisory">建议</option><option value="required">必须遵守</option></select></label></div>
            <div className="nwa-memory-actions"><label>从第几{unit}生效<input type="number" required min="1" value={draft.control.fromUnit} onChange={(event) => updateControl({ fromUnit: Number(event.target.value) })} /></label><label>截至第几{unit}（可空）<input type="number" min={draft.control.fromUnit} value={draft.control.throughUnit ?? ''} onChange={(event) => updateControl({ throughUnit: optionalNumber(event.target.value) })} /></label></div>
            {draft.control.kind === 'fact_correction' ? <div><label>纠错的已接受来源<select required value={draft.control.source ? sourceKey(draft.control.source) : ''} onChange={(event) => updateControl({ source: view.acceptedSources.find((item) => sourceKey(item.source) === event.target.value)?.source, resolutionConfirmed: false })}><option value="">请选择明确来源</option>{draft.control.source && !view.acceptedSources.some((item) => sourceKey(item.source) === sourceKey(draft.control.source!)) ? <option value={sourceKey(draft.control.source)}>原来源已撤回 · 第 {draft.control.source.unitNumber} {unit}</option> : null}{view.acceptedSources.map(({ source, title }) => <option key={sourceKey(source)} value={sourceKey(source)}>第 {source.unitNumber} {unit} · {title} · 版本 {source.revision}</option>)}</select></label>
              <p>事实纠错是作者裁决：会撤回所选来源及受影响的后继记忆，正文保持原样。修改正文后需重新接受。停用或删除纠错不会自动恢复已撤回来源。</p>
              <label><input type="checkbox" checked={draft.control.resolutionConfirmed ?? false} onChange={(event) => updateControl({ resolutionConfirmed: event.target.checked })} />我确认来源与撤回影响</label></div> : null}
            {draft.control.thread ? <div><label>伏笔标题<input required value={draft.control.thread.title} onChange={(event) => updateThread({ title: event.target.value })} /></label><div className="nwa-memory-actions"><label>伏笔状态<select value={draft.control.thread.status} onChange={(event) => updateThread({ status: event.target.value as StoryThreadView['status'] })}>{Object.entries(THREAD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>紧迫度<select value={draft.control.thread.urgency} onChange={(event) => updateThread({ urgency: event.target.value as StoryThreadView['urgency'] })}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label></div><div className="nwa-memory-actions"><label>回应期限（第几{unit}）<input type="number" min="1" value={draft.control.thread.deadlineUnit ?? ''} onChange={(event) => updateThread({ deadlineUnit: optionalNumber(event.target.value) })} /></label><label>指定必须回应（第几{unit}）<input type="number" min="1" value={draft.control.thread.requiredAtUnit ?? ''} onChange={(event) => updateThread({ requiredAtUnit: optionalNumber(event.target.value) })} /></label></div><p className="nwa-muted">期限和紧迫度用于排序；只有明确指定“必须回应”章集，才会成为该次写作目标。</p></div> : null}
          </fieldset>
          {conflict ? <div className="nwa-memory-conflict"><button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" onClick={() => setReload((value) => value + 1)}>读取最新版本作对照</button>{view.controls.revision !== draft.expectedRevision ? <><p>服务器最新记录：{currentRemote?.text ?? '该记录不存在或为新建记录'}</p><button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" onClick={() => { setDraft({ ...draft, expectedRevision: view.controls.revision }); setConflict(false); }}>已核对，使用最新版本重试</button></> : null}</div> : null}
          <div className="nwa-memory-actions"><button className="nwa-button nwa-button--sm" disabled={busy || conflict || !draft.control.text.trim() || (draft.control.kind === 'fact_correction' && (!draft.control.source || !draft.control.resolutionConfirmed))}>保存作者记录</button><button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy} onClick={() => { setDraft(undefined); setConflict(false); }}>取消编辑</button></div>
        </form> : null}
        <ul className="nwa-memory-list">{view.controls.items.map((control) => <li key={control.id} className="nwa-memory-card"><small>{KIND_LABELS[control.kind]} · {control.enabled ? '已启用' : '已停用'} · {control.importance === 'required' ? '必须遵守' : '建议'} · 从第 {control.fromUnit} {unit}{control.throughUnit ? `至第 ${control.throughUnit} ${unit}` : ''}</small><p>{control.text}</p>{control.source ? sourceDetails(control.source) : <small className="nwa-muted">作者记录，不代表已发生的正文事实。</small>}<div className="nwa-memory-actions"><button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy || Boolean(draft)} onClick={() => editControl(control)}>编辑 / 启停</button><button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy || Boolean(draft)} onClick={() => setRemove({ control, expectedRevision: view.controls.revision })}>删除记录</button></div></li>)}</ul>
        {remove ? <div className="nwa-memory-confirm" role="alert"><p>删除记录“{remove.control.text}”？{remove.control.kind === 'fact_correction' ? '已撤回来源不会因此恢复。' : '该作者记录将不再参与后续写作。'}</p><button type="button" className="nwa-button nwa-button--sm" disabled={busy} onClick={() => void deleteControl()}>确认删除记录</button><button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy} onClick={() => setRemove(undefined)}>取消删除</button></div> : null}
      </div> : null}
      {tab === 'threads' ? <div role="tabpanel"><h3>待回应伏笔（{pendingThreads.length}）</h3><p className="nwa-muted">顺序由服务器结合本次写作目标、期限和紧迫度统一计算。</p><ul className="nwa-memory-list">{pendingThreads.map(threadCard)}</ul>{!pendingThreads.length ? <p>当前没有待回应伏笔。</p> : null}<details><summary>已回收 / 已作废（{closedThreads.length}）</summary><ul className="nwa-memory-list">{closedThreads.map(threadCard)}</ul></details><button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy || Boolean(draft)} onClick={() => newControl('thread')}>新增作者伏笔</button></div> : null}
      {tab === 'search' ? <div role="tabpanel"><form className="nwa-memory-form" onSubmit={(event) => { event.preventDefault(); setQuery((current) => ({ ...current, q: search.trim(), topK: Number(topK), maxContextChars: Number(budget) })); }}><label>检索关键词<input required value={search} onChange={(event) => setSearch(event.target.value)} placeholder="人物、道具或事件" /></label><div className="nwa-memory-actions"><label>最多结果<input type="number" required min="1" max="20" value={topK} onChange={(event) => setTopK(event.target.value)} /></label><label>结果字符预算<input type="number" required min="200" max="20000" value={budget} onChange={(event) => setBudget(event.target.value)} /></label><button className="nwa-button nwa-button--sm" disabled={loading}>检索来源</button></div></form>
        {view.retrieval ? <><p className="nwa-muted">关键词检索 · {view.retrieval.hits.length} 条正文结果 · 结果字符（含引文及作者记录） {view.retrieval.statistics.returnedChars} / {view.retrieval.statistics.maxContextChars} · 扫描 {view.retrieval.statistics.scannedChars} / {view.retrieval.statistics.maxScanChars} 字</p>{view.retrieval.statistics.outputBudgetExhausted || view.retrieval.statistics.scanBudgetExhausted ? <p>已达到本次检索预算，结果可能未包含所有匹配来源。</p> : null}<ul className="nwa-memory-list">{view.retrieval.hits.map((hit) => <li className="nwa-memory-card" key={hit.id}><strong>{hit.title}</strong><p>{hit.text}</p><small>{hit.explanation}</small><p className="nwa-muted">匹配词：{hit.matchedTerms.join('、')} · {hit.evidenceStatus === 'matched' ? '引文已匹配' : '未验证参考'}</p>{hit.matchedMetadata?.length ? <p className="nwa-muted">资料字段匹配：{hit.matchedMetadata.join('、')}（用于查找，不作为正文证据）</p> : null}{sourceDetails(hit.source, hit.evidence)}</li>)}</ul>
          {view.retrieval.authorMatches?.length ? <section aria-label="作者记录检索结果"><h3>作者记录匹配（{view.retrieval.authorMatches.length}）</h3><p className="nwa-muted">作者记录单独列出，不代表已发生的正文事实。</p><ul className="nwa-memory-list">{view.retrieval.authorMatches.map((match) => <li className="nwa-memory-card" key={match.controlId}><small>{KIND_LABELS[match.kind]} · 作者记录</small><p>{match.text}</p><small>{match.explanation}</small><p className="nwa-muted">匹配词：{match.matchedTerms.join('、')}</p><button type="button" className="nwa-button nwa-button--ghost nwa-button--sm" disabled={busy || Boolean(draft) || !view.controls.items.some((control) => control.id === match.controlId)} onClick={() => { const control = view.controls.items.find((item) => item.id === match.controlId); if (control) editControl(control); }}>编辑作者记录</button></li>)}</ul></section> : null}
          {!view.retrieval.hits.length && !view.retrieval.authorMatches?.length ? <p>本次预算和历史范围内没有匹配结果。</p> : null}</> : null}</div> : null}
    </> : null}
  </section>;
}
