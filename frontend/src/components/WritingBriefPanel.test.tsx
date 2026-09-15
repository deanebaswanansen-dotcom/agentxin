import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/apiClient.js';
import { makeWriteBrief } from '../test/writeBriefFixture.js';
import type { WriteBriefView } from '../types/writeBrief.js';
import { WritingBriefPanel } from './WritingBriefPanel.js';

describe('WritingBriefPanel', () => {
  it('shows server provenance and generation status without exposing hashes', async () => {
    render(<WritingBriefPanel targetKey="ch-1" load={vi.fn().mockResolvedValue({ status: 'stale', origin: 'generation', brief: makeWriteBrief(), reason: '上一章已修改' })} />);
    expect(await screen.findByText('本次写前依据')).toBeInTheDocument();
    const panel = screen.getByLabelText('写前依据');
    expect(panel).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('本次写前依据'));
    expect(screen.getByText('已过期')).toBeInTheDocument();
    expect(screen.getByText('寻找失踪同伴')).toBeInTheDocument();
    expect(screen.getByText('承接上一章留下的信件')).toBeInTheDocument();
    expect(screen.getByText('不能提前揭晓幕后主使')).toBeInTheDocument();
    expect(screen.getByText('保持第三人称')).toBeInTheDocument();
    expect(screen.getByText('第 1 章：失踪 · 修订 2')).toBeInTheDocument();
    expect(panel.textContent).not.toContain('private-');
    expect(panel.textContent).not.toContain('已验证');
  });

  it('hides an older server endpoint and offers retry only for a genuine read failure', async () => {
    const load = vi.fn().mockRejectedValueOnce(new ApiClientError({ error: { code: 'NOT_FOUND', message: 'missing' } }, 404));
    const { rerender } = render(<WritingBriefPanel targetKey="old" load={load} />);
    await waitFor(() => expect(screen.queryByLabelText('写前依据')).not.toBeInTheDocument());
    load.mockRejectedValueOnce(new Error('internal stack')).mockResolvedValueOnce({ status: 'unavailable', origin: 'preview', reason: '请先保存大纲' });
    rerender(<WritingBriefPanel targetKey="new" load={load} />);
    await screen.findByText('加载失败');
    fireEvent.click(screen.getByText('下次写前依据'));
    expect(screen.queryByText('internal stack')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新读取依据' }));
    expect(await screen.findByText('请先保存大纲')).toBeInTheDocument();
  });

  it('rejects late results after changing target or editing', async () => {
    let resolveOld!: (view: WriteBriefView) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise<WriteBriefView>((resolve) => { resolveOld = resolve; })).mockResolvedValue({ status: 'current', origin: 'preview', brief: makeWriteBrief({ objective: [{ text: '新章节目标', sourceKeys: [] }] }) });
    const { rerender } = render(<WritingBriefPanel targetKey="old" load={load} />);
    rerender(<WritingBriefPanel targetKey="new" load={load} />);
    await screen.findByText('新章节目标');
    await act(async () => resolveOld({ status: 'current', origin: 'generation', brief: makeWriteBrief() }));
    expect(screen.queryByText('寻找失踪同伴')).not.toBeInTheDocument();
    expect(load.mock.calls[0][0].aborted).toBe(true);
    rerender(<WritingBriefPanel targetKey="new" load={load} locallyChanged />);
    expect(screen.getByText('已过期')).toBeInTheDocument();
    expect(screen.queryByText('当前')).not.toBeInTheDocument();
  });
});
