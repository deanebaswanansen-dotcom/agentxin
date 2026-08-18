import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import fc from 'fast-check';
import { App } from './App.js';

describe('App shell', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the workbench heading', async () => {
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: /小说\s*Agent/ }),
    ).toBeInTheDocument();
  });

  it('renders the project tree and centered chat workspace immediately', async () => {
    render(<App />);
    expect(await screen.findByRole('navigation', { name: '项目导航' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '对话主题' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '对话输入' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    expect(document.querySelector('[data-empty-illustration="project"]')).toBeInTheDocument();
  });

  it('opens the slash command menu from the chat input', async () => {
    render(<App />);
    const input = await screen.findByRole('textbox', { name: '对话输入' });
    fireEvent.change(input, { target: { value: '/' } });
    expect(await screen.findByRole('listbox', { name: '斜杠命令' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /演示模式/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /新书/ })).toBeInTheDocument();
  });

  it('renders the settings gear button in the header', async () => {
    render(<App />);
    expect(
      await screen.findByRole('button', { name: '打开设置' }),
    ).toBeInTheDocument();
  });

  it('shows a logout button for clearing the current API key', async () => {
    render(<App />);
    expect(await screen.findByRole('button', { name: '登出' })).toBeInTheDocument();
  });

  it('exposes VS Code style resizable splitters', async () => {
    render(<App />);
    expect(await screen.findByRole('separator', { name: '调整项目栏宽度' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: '调整 AI 对话栏宽度' })).toBeInTheDocument();
  });

  it('exposes DOCX export and disables it until a project is selected', async () => {
    render(<App />);
    expect(await screen.findByRole('button', { name: '导出 DOCX' })).toBeDisabled();
  });

  it('opens a short-drama project in its isolated five-stage workspace', async () => {
    const plan = {
      id: 'plan-script-1', projectId: 'script-1', status: 'draft', revision: 1,
      title: '竖屏短剧', theme: '', market: 'domestic', channel: 'female', genres: [], audience: '',
      coreConflict: '', logline: '', highlights: [], totalEpisodes: 60,
      episodeDurationSeconds: { min: 60, max: 90 }, targetCharsPerEpisode: 1200,
      maxPrimaryCharacters: 10, maxScenesPerEpisode: 3, dialogueDensityPercent: 60,
      language: 'zh-CN', format: 'cn_short_drama', coreRequirements: '', forbiddenElements: [],
      endingDirection: '', createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
      if (url.pathname.endsWith('/script-workspace')) return Response.json({
        schemaVersion: 1,
        projectId: 'script-1',
        plan,
        characters: [],
        episodeSummaries: [],
        batchSummaries: [],
        reviewRevision: 0,
        reviewIssues: [],
        updatedAt: '2026-08-14T00:00:00.000Z',
      });
      if (url.pathname.endsWith('/script-plan')) return Response.json(plan);
      if (url.pathname.endsWith('/script-world') || url.pathname.endsWith('/script-outline')) {
        return Response.json({ error: { code: 'NOT_FOUND', message: 'missing' } }, { status: 404 });
      }
      if (url.pathname.endsWith('/projects')) return Response.json([{ id: 'script-1', name: '竖屏短剧', kind: 'short_drama' }]);
      return Response.json([]);
    }));

    render(<App />);
    fireEvent.click(await screen.findByTitle('竖屏短剧'));

    expect(
      await screen.findByRole('tab', { name: '剧本策划' }, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(screen.getByText('短剧生产工作台')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '对话输入' })).not.toBeInTheDocument());
  });

  it('fast-check is wired up (array reverse twice is identity)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), (xs) => {
        const twice = [...xs].reverse().reverse();
        return JSON.stringify(twice) === JSON.stringify(xs);
      }),
    );
  });
});
