import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/apiClient.js';
import { makeStoryMemory, memorySource } from '../test/storyMemoryFixture.js';
import type { StoryControl, StoryMemoryWorkspaceView } from '../types/storyMemory.js';
import { StoryMemoryPanel } from './StoryMemoryPanel.js';

function fixture(view = makeStoryMemory()) {
  const storyMemory = { workspace: vi.fn().mockResolvedValue(view), status: vi.fn(), retry: vi.fn().mockResolvedValue({ ...view.memorySync, status: 'succeeded' }),
    saveControl: vi.fn().mockResolvedValue({ schemaVersion: 1, revision: 3, items: [] }), removeControl: vi.fn().mockResolvedValue({ schemaVersion: 1, revision: 3, items: [] }) };
  const onNavigate = vi.fn(); const onControlsChanged = vi.fn();
  const props = { projectId: 'p-1', mode: 'novel' as const, client: { storyMemory }, onNavigate, onControlsChanged };
  return { storyMemory, props, onNavigate, onControlsChanged };
}
const preference: StoryControl = { id: 'note-1', revision: 1, kind: 'preference', text: '保持第三人称', enabled: true, importance: 'advisory', fromUnit: 1, createdAt: '', updatedAt: '' };

describe('StoryMemoryPanel', () => {
  it('loads in StrictMode, separates unverified references and opens exact server evidence without displaying hashes', async () => {
    const f = fixture();
    render(<StrictMode><StoryMemoryPanel {...f.props} bodyState="unsaved" /></StrictMode>);
    await screen.findByText('钥匙在门外。');
    expect(screen.getByText('正文：有未保存修改')).toBeInTheDocument();
    const unverified = screen.getByText('未验证参考（1）').closest('details')!;
    expect(unverified).not.toHaveAttribute('open');
    expect(within(unverified).getByText('门后有陌生人。')).toBeInTheDocument();
    const card = screen.getByText('钥匙在门外。').closest('li')!;
    fireEvent.click(within(card).getByText(/第 1 章/));
    fireEvent.click(within(card).getByRole('button', { name: '定位正文证据' }));
    expect(f.onNavigate).toHaveBeenCalledWith({ source: memorySource, evidence: makeStoryMemory().entries[0].evidence[0] });
    expect(screen.getByLabelText('故事记忆工作台').textContent).not.toContain('private-');
  });

  it('requires an explicit accepted source and retraction confirmation for a fact correction', async () => {
    const f = fixture(); render(<StoryMemoryPanel {...f.props} />);
    await screen.findByText('钥匙在门外。');
    fireEvent.click(screen.getByRole('tab', { name: '作者纠错与偏好' }));
    fireEvent.click(screen.getByRole('button', { name: '新增事实纠错' }));
    fireEvent.change(screen.getByLabelText('记录内容'), { target: { value: '钥匙已由作者改为藏在抽屉' } });
    expect(screen.getByRole('button', { name: '保存作者记录' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('纠错的已接受来源'), { target: { value: memorySource.acceptanceId } });
    expect(screen.getByRole('button', { name: '保存作者记录' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('我确认来源与撤回影响'));
    fireEvent.click(screen.getByRole('button', { name: '保存作者记录' }));
    await screen.findByText('作者记录已保存。');
    expect(f.storyMemory.saveControl).toHaveBeenCalledWith('p-1', expect.objectContaining({ kind: 'fact_correction', source: memorySource, resolutionConfirmed: true }), 2, expect.any(AbortSignal));
    expect(f.onControlsChanged).toHaveBeenCalledOnce();
  });

  it('marks a retained snapshot as unrefreshed when a later read fails without exposing server details', async () => {
    const f = fixture(); render(<StoryMemoryPanel {...f.props} />);
    await screen.findByText('钥匙在门外。');
    f.storyMemory.workspace.mockRejectedValueOnce(new Error('private internal stack'));
    fireEvent.click(screen.getByRole('button', { name: '刷新记忆' }));
    await screen.findByText('记忆：读取失败 · 上次快照');
    expect(screen.getByText('钥匙在门外。')).toBeInTheDocument();
    expect(screen.queryByText('记忆：同步完成')).not.toBeInTheDocument();
    expect(screen.queryByText('private internal stack')).not.toBeInTheDocument();
  });

  it('keeps an edited form on CAS conflict and requires comparison before using the newer revision', async () => {
    const f = fixture(makeStoryMemory({ controls: { schemaVersion: 1, revision: 2, items: [preference] } }));
    f.storyMemory.saveControl.mockRejectedValueOnce(new ApiClientError({ error: { code: 'CONFLICT', message: 'private server stack' } }, 409));
    render(<StoryMemoryPanel {...f.props} />); await screen.findByText('钥匙在门外。');
    fireEvent.click(screen.getByRole('tab', { name: '作者纠错与偏好' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑 / 启停' }));
    fireEvent.change(screen.getByLabelText('记录内容'), { target: { value: '我的手工新偏好' } });
    fireEvent.click(screen.getByRole('button', { name: '保存作者记录' }));
    await screen.findByText(/作者记录已被更新/);
    expect(screen.getByLabelText('记录内容')).toHaveValue('我的手工新偏好');
    expect(screen.getByRole('button', { name: '保存作者记录' })).toBeDisabled();
    f.storyMemory.workspace.mockResolvedValue(makeStoryMemory({ controls: { schemaVersion: 1, revision: 4, items: [{ ...preference, text: '别处修改的偏好' }] } }));
    fireEvent.click(screen.getByRole('button', { name: '读取最新版本作对照' }));
    await screen.findByText('服务器最新记录：别处修改的偏好');
    expect(screen.getByLabelText('记录内容')).toHaveValue('我的手工新偏好');
    fireEvent.click(screen.getByRole('button', { name: '已核对，使用最新版本重试' }));
    fireEvent.click(screen.getByRole('button', { name: '保存作者记录' }));
    await waitFor(() => expect(f.storyMemory.saveControl).toHaveBeenLastCalledWith('p-1', expect.objectContaining({ text: '我的手工新偏好' }), 4, expect.any(AbortSignal)));
    expect(screen.queryByText('private server stack')).not.toBeInTheDocument();
  });

  it('ignores an old project read and mutation response after navigation or unmount', async () => {
    const f = fixture(); let resolve!: (value: StoryMemoryWorkspaceView) => void;
    f.storyMemory.workspace.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const rendered = render(<StoryMemoryPanel {...f.props} />);
    f.storyMemory.workspace.mockResolvedValue(makeStoryMemory({ projectId: 'p-2', entries: [], unverifiedReferences: [], acceptedSources: [] }));
    rendered.rerender(<StoryMemoryPanel {...f.props} projectId="p-2" />);
    await screen.findByText('当前历史边界内暂无已匹配的来源条目。');
    await act(async () => resolve(makeStoryMemory()));
    expect(screen.queryByText('钥匙在门外。')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '作者纠错与偏好' }));
    fireEvent.click(screen.getByRole('button', { name: '新增表达偏好' }));
    fireEvent.change(screen.getByLabelText('记录内容'), { target: { value: '旧项目草稿' } });
    let saved!: (value: unknown) => void;
    f.storyMemory.saveControl.mockImplementationOnce(() => new Promise((done) => { saved = done; }));
    fireEvent.click(screen.getByRole('button', { name: '保存作者记录' }));
    rendered.unmount();
    await act(async () => saved({ schemaVersion: 1, revision: 3, items: [] }));
    expect(f.onControlsChanged).not.toHaveBeenCalled();
  });

  it('uses server thread order, keeps closed threads out of pending, and preserves the source when author requirements change', async () => {
    const thread = { id: 'thread-1', threadId: 'canonical-1', title: '钥匙来历', text: '解释钥匙来历', status: 'planted' as const,
      urgency: 'high' as const, importance: 'advisory' as const, origin: 'accepted_source' as const, source: memorySource,
      effectiveFromUnit: 1, requiredNow: false, priority: 'overdue' as const, deadlineUnit: 2 };
    const f = fixture(makeStoryMemory({ threads: [thread, { ...thread, id: 'closed', title: '已经解释的信', status: 'resolved', priority: 'closed' }] }));
    render(<StoryMemoryPanel {...f.props} />); await screen.findByText('钥匙在门外。');
    fireEvent.click(screen.getByRole('tab', { name: '伏笔账本' }));
    expect(screen.getByText('待回应伏笔（1）')).toBeInTheDocument();
    expect(screen.getByText('已经解释的信').closest('details')).not.toHaveAttribute('open');
    fireEvent.click(within(screen.getByText('钥匙来历').closest('li')!).getByRole('button', { name: '编辑回应要求' }));
    fireEvent.change(screen.getByLabelText('指定必须回应（第几章）'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: '保存作者记录' }));
    await waitFor(() => expect(f.storyMemory.saveControl).toHaveBeenCalledWith('p-1', expect.objectContaining({ source: memorySource,
      thread: expect.objectContaining({ threadId: 'canonical-1', deadlineUnit: 2, requiredAtUnit: 4 }) }), 2, expect.any(AbortSignal)));
  });

  it('retries synchronization independently and sends explicit history and retrieval budgets', async () => {
    const f = fixture(makeStoryMemory({ memorySync: { mode: 'novel', status: 'failed', revision: 1, attempts: 1, acceptedSources: 1 } }));
    render(<StoryMemoryPanel {...f.props} bodyState="saved" />); await screen.findByText('钥匙在门外。');
    fireEvent.click(screen.getByRole('button', { name: '单独重试记忆同步' }));
    await waitFor(() => expect(f.storyMemory.retry).toHaveBeenCalledWith('p-1', expect.any(AbortSignal)));
    fireEvent.change(screen.getByLabelText('历史章集边界'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '查询历史' }));
    await waitFor(() => expect(f.storyMemory.workspace).toHaveBeenLastCalledWith('p-1', { beforeUnit: 2 }, expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole('tab', { name: '关键词检索' }));
    fireEvent.change(screen.getByLabelText('检索关键词'), { target: { value: '钥匙' } });
    fireEvent.change(screen.getByLabelText('结果字符预算'), { target: { value: '1200' } });
    fireEvent.click(screen.getByRole('button', { name: '检索来源' }));
    await waitFor(() => expect(f.storyMemory.workspace).toHaveBeenLastCalledWith('p-1', { beforeUnit: 2, q: '钥匙', topK: 5, maxContextChars: 1200 }, expect.any(AbortSignal)));
  });

  it('shows source retrieval evidence and author matches separately with truthful budget limits', async () => {
    const f = fixture(makeStoryMemory({ controls: { schemaVersion: 1, revision: 2, items: [preference] }, retrieval: {
      query: '钥匙', method: 'keyword_zh_words_bigrams',
      hits: [{ id: 'hit-1', kind: 'body', title: '正文匹配', text: '钥匙留在门口', source: memorySource,
        evidence: [{ blockId: 'body', start: 0, end: 2, quote: '钥匙' }], evidenceStatus: 'matched', score: 2,
        matchedTerms: ['钥匙'], matchedMetadata: ['人物名'], explanation: '正文包含查询关键词' }],
      authorMatches: [{ controlId: preference.id, revision: 1, kind: 'preference', text: '作者关于钥匙的偏好', origin: 'author', score: 1, matchedTerms: ['钥匙'], explanation: '作者记录包含查询词' }],
      statistics: { elapsedMs: 1, eligibleSources: 1, scannedCandidates: 3, scannedChars: 1000, matchedCandidates: 2,
        returnedChars: 200, topK: 5, maxContextChars: 200, maxScanChars: 1000, scanBudgetExhausted: true, outputBudgetExhausted: true },
    } }));
    render(<StoryMemoryPanel {...f.props} />); await screen.findByText('钥匙在门外。');
    fireEvent.click(screen.getByRole('tab', { name: '关键词检索' }));
    expect(screen.getByLabelText('最多结果')).toHaveAttribute('max', '20');
    expect(screen.getByLabelText('结果字符预算')).toHaveAttribute('min', '200');
    expect(screen.getByLabelText('结果字符预算')).toHaveAttribute('max', '20000');
    expect(screen.getByText(/结果字符（含引文及作者记录） 200 \/ 200/)).toBeInTheDocument();
    expect(screen.getByText(/已达到本次检索预算/)).toBeInTheDocument();
    const authors = screen.getByLabelText('作者记录检索结果');
    expect(within(authors).queryByText(/引文已匹配/)).not.toBeInTheDocument();
    expect(within(authors).queryByRole('button', { name: '定位正文证据' })).not.toBeInTheDocument();
    fireEvent.click(within(authors).getByRole('button', { name: '编辑作者记录' }));
    expect(screen.getByLabelText('记录内容')).toHaveValue(preference.text);
  });
});
