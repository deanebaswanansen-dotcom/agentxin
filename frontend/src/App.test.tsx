import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import fc from 'fast-check';
import { App } from './App.js';
import { makeWriteBrief } from './test/writeBriefFixture.js';

function installWritingServer(accept?: (body: { content: string }) => Response | Promise<Response>) {
  let chapter = { id: 'ch-1', projectId: 'p-1', title: '测试第一章', content: '已有正文', revision: 3, position: 0 };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/projects')) return Response.json([{ id: 'p-1', name: '小说测试项目', kind: 'novel' }]);
    if (url.pathname.endsWith('/chapters') && init?.method !== 'POST') return Response.json([chapter]);
    if (url.pathname.endsWith('/write')) return new Response(`event: write_brief\ndata: ${JSON.stringify(makeWriteBrief())}\n\nevent: delta\ndata: "生成片段"\n\nevent: done\ndata: \n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    if (url.pathname.endsWith('/generated-content')) {
      const body = JSON.parse(init!.body as string) as { content: string };
      if (accept) return accept(body);
      chapter = { ...chapter, content: body.content, revision: chapter.revision + 1 };
      return Response.json(chapter);
    }
    if (url.pathname.endsWith('/content') && init?.method === 'PUT') {
      const body = JSON.parse(init.body as string) as { content: string };
      chapter = { ...chapter, content: body.content, revision: chapter.revision + 1 };
      return Response.json(chapter);
    }
    return Response.json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function openWritingCandidate() {
  render(<App />);
  fireEvent.click(await screen.findByTitle('小说测试项目'));
  fireEvent.click(await screen.findByTitle('测试第一章'));
  await screen.findByRole('textbox', { name: '章节正文' });
  fireEvent.change(screen.getByLabelText('对话输入'), { target: { value: '继续写' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByText('生成片段');
  fireEvent.click(screen.getByRole('button', { name: '采用到正文' }));
  await screen.findByRole('dialog', { name: '整章替换确认' });
}

describe('App shell', () => {
  beforeEach(() => {
    window.localStorage.clear();
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

  it('accepts generated content through its guarded endpoint and continues manual edits at the returned revision', async () => {
    const fetchMock = installWritingServer();
    await openWritingCandidate();
    fireEvent.click(screen.getByRole('button', { name: '确认替换' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '整章替换确认' })).not.toBeInTheDocument());
    const candidateCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/generated-content'));
    expect(candidateCall).toBeDefined();
    expect(JSON.parse(candidateCall![1]!.body as string)).toEqual({ content: '已有正文生成片段', writeBrief: makeWriteBrief() });
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('已有正文生成片段');
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/content') && init?.method === 'PUT')).toHaveLength(0);
    fireEvent.change(screen.getByRole('textbox', { name: '章节正文' }), { target: { value: '手工修订' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/content'))).toBe(true));
    const manualCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/content'))!;
    expect(JSON.parse(manualCall[1]!.body as string)).toEqual({ content: '手工修订', expectedRevision: 4 });
  });

  it('keeps the existing editor text when generated acceptance fails', async () => {
    const fetchMock = installWritingServer(() => Response.json({ error: { code: 'CONFLICT', message: '来源已过期' } }, { status: 409 }));
    await openWritingCandidate();
    fireEvent.click(screen.getByRole('button', { name: '确认替换' }));
    await screen.findByText('来源已过期');
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('已有正文');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/content'))).toHaveLength(0);
  });

  it('does not overwrite an edit made while generated acceptance is in flight', async () => {
    let release!: (response: Response) => void;
    const fetchMock = installWritingServer(() => new Promise<Response>((resolve) => { release = resolve; }));
    await openWritingCandidate();
    fireEvent.click(screen.getByRole('button', { name: '确认替换' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/generated-content'))).toBe(true));
    fireEvent.change(screen.getByRole('textbox', { name: '章节正文' }), { target: { value: '等待时的手工编辑' } });
    await act(async () => release(Response.json({ id: 'ch-1', projectId: 'p-1', content: '已有正文生成片段', title: '测试第一章', revision: 4, position: 0 })));
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('等待时的手工编辑');
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
