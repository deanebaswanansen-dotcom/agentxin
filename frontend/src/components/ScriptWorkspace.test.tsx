import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/apiClient.js';
import type { ScriptPlan } from '../types/index.js';
import { ScriptWorkspace } from './ScriptWorkspace.js';

function buildPlan(projectId = 'project-1'): ScriptPlan {
  return {
    id: `plan-${projectId}`,
    projectId,
    status: 'approved',
    revision: 2,
    title: '绝食逼我道歉？我当面吃香喝辣',
    theme: '打破情绪勒索',
    market: 'domestic',
    channel: 'female',
    genres: ['都市', '家庭'],
    audience: '女性用户',
    coreConflict: '新媳妇对抗家族情绪勒索',
    logline: '新媳妇用美食拆穿绝食骗局。',
    highlights: ['当面烧烤'],
    totalEpisodes: 60,
    episodeDurationSeconds: { min: 60, max: 90 },
    targetCharsPerEpisode: 1200,
    maxPrimaryCharacters: 10,
    maxScenesPerEpisode: 3,
    dialogueDensityPercent: 60,
    language: 'zh-CN',
    format: 'cn_short_drama',
    coreRequirements: '每集有反转和卡点',
    forbiddenElements: [],
    endingDirection: '家庭秩序重建',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
  };
}

function createClient(plan = buildPlan()) {
  return {
    script: {
      plan: {
        get: vi.fn().mockResolvedValue(plan),
        save: vi.fn().mockImplementation((_projectId, value) => Promise.resolve({ ...value, revision: 3 })),
        approve: vi.fn().mockImplementation(() => Promise.resolve({ ...plan, status: 'approved', revision: 3 })),
        turn: vi.fn(),
      },
      characters: { list: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue([]) },
      world: { get: vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { status: 404 })), save: vi.fn() },
      outline: { get: vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { status: 404 })), save: vi.fn() },
      episodeOutlines: { get: vi.fn(), save: vi.fn() },
      episodes: { list: vi.fn().mockResolvedValue([]), get: vi.fn(), save: vi.fn() },
      jobs: {
        create: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn(),
        resume: vi.fn(),
        cancel: vi.fn(),
      },
      export: vi.fn(),
    },
  } as unknown as Pick<ApiClient, 'script'>;
}

describe('ScriptWorkspace', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the selected project and exposes all five production stages', async () => {
    const client = createClient();
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    expect(await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣')).toBeInTheDocument();
    for (const name of ['剧本策划', '剧本大纲', '角色设定', '世界设定', '分批正文']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
    expect(client.script.plan.get).toHaveBeenCalledWith('project-1', expect.any(AbortSignal));
  });

  it('saves the edited plan with the loaded revision', async () => {
    const client = createClient();
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);
    const title = await screen.findByLabelText('剧本名称');
    fireEvent.change(title, { target: { value: '新剧名' } });
    fireEvent.click(screen.getByRole('button', { name: '保存策划' }));

    await waitFor(() => {
      expect(client.script.plan.save).toHaveBeenCalledWith(
        'project-1',
        expect.objectContaining({ title: '新剧名' }),
        2,
      );
    });
    expect(await screen.findByText('策划已保存')).toBeInTheDocument();
  });

  it('runs a multi-turn planning interview and requires explicit approval', async () => {
    const draft = { ...buildPlan(), status: 'draft' as const };
    const client = createClient(draft);
    vi.mocked(client.script.plan.turn)
      .mockResolvedValueOnce({
        status: 'asking', session: 'session-1', round: 1,
        questions: [{
          field: 'endingDirection', label: '结局要给观众什么情绪？', kind: 'single', required: true,
          options: [{ label: '痛快翻盘', value: 'revenge' }, { label: '温暖和解', value: 'healing' }],
        }],
      })
      .mockResolvedValueOnce({
        status: 'ready', session: 'session-1', round: 2,
        plan: { ...draft, title: 'Agent 完成的策划', endingDirection: '痛快翻盘' },
      });
    vi.mocked(client.script.plan.approve).mockResolvedValue({
      ...draft, title: 'Agent 完成的策划', endingDirection: '痛快翻盘', status: 'approved', revision: 3,
    });
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('button', { name: 'Agent 帮我策划' }));
    expect(await screen.findByText('结局要给观众什么情绪？')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '痛快翻盘' }));
    fireEvent.click(screen.getByRole('button', { name: '提交本轮答案' }));

    expect(await screen.findByDisplayValue('Agent 完成的策划')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认策划' }));
    await waitFor(() => expect(client.script.plan.approve).toHaveBeenCalledWith('project-1', 2));
    expect(await screen.findByText('策划已确认，可生成大纲、角色与世界设定')).toBeInTheDocument();
  });

  it('starts outline and bible agents from their production stages', async () => {
    const client = createClient();
    vi.mocked(client.script.jobs.create).mockImplementation((request) => Promise.resolve({
      id: `job-${request.task}`, projectId: request.projectId, task: request.task,
      status: 'queued', continuable: false,
    }));
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '剧本大纲' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agent 生成大纲' }));
    await waitFor(() => expect(client.script.jobs.create).toHaveBeenCalledWith({
      projectId: 'project-1', task: 'script_series_outline',
    }));

    fireEvent.click(screen.getByRole('tab', { name: '角色设定' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agent 生成角色' }));
    fireEvent.click(screen.getByRole('tab', { name: '世界设定' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agent 生成世界' }));
    await waitFor(() => {
      expect(client.script.jobs.create).toHaveBeenCalledWith({
        projectId: 'project-1', task: 'script_bible', prompt: '仅生成角色设定',
      });
      expect(client.script.jobs.create).toHaveBeenCalledWith({
        projectId: 'project-1', task: 'script_bible', prompt: '仅生成世界设定',
      });
    });
  });

  it('starts the next five-episode batch and shows its durable checkpoint', async () => {
    const client = createClient();
    vi.mocked(client.script.jobs.create).mockResolvedValue({
      id: 'job-1',
      projectId: 'project-1',
      task: 'script_episode_batch',
      status: 'running',
      continuable: false,
      checkpoint: { episodeNumber: 1, node: 'draft', attempt: 1, artifactRevision: 0 },
    });
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    fireEvent.click(screen.getByRole('button', { name: '生成第 1–5 集' }));

    await waitFor(() => {
      expect(client.script.jobs.create).toHaveBeenCalledWith({
        projectId: 'project-1',
        task: 'script_episode_batch',
        scriptBatchOptions: { startEpisode: 1, episodeCount: 5, expectedPlanRevision: 2 },
      });
    });
    expect(await screen.findByText('第 1 集 · 正文初稿')).toBeInTheDocument();
    expect(screen.getByText('运行中')).toBeInTheDocument();
  });

  it('edits and saves the versioned series outline', async () => {
    const client = createClient();
    const outline = {
      projectId: 'project-1',
      synopsis: '旧梗概',
      openingState: '开局',
      midpointTurn: '中点',
      climax: '高潮',
      endingState: '结局',
      mainArc: ['破局'],
      subplotArcs: ['亲情'],
      episodeCards: [],
      revision: 4,
    };
    vi.mocked(client.script.outline.get).mockResolvedValue(outline);
    vi.mocked(client.script.outline.save).mockResolvedValue({ ...outline, synopsis: '新梗概', revision: 5 });
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '剧本大纲' }));
    fireEvent.change(screen.getByLabelText('全剧梗概'), { target: { value: '新梗概' } });
    fireEvent.click(screen.getByRole('button', { name: '保存大纲' }));

    await waitFor(() => expect(client.script.outline.save).toHaveBeenCalledWith(
      'project-1', expect.objectContaining({ synopsis: '新梗概' }), 4,
    ));
  });

  it('adds a structured character including wardrobe and saves the bible', async () => {
    const client = createClient();
    vi.mocked(client.script.characters.save).mockImplementation((_projectId, items) => Promise.resolve(items));
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '角色设定' }));
    fireEvent.click(screen.getByRole('button', { name: '添加角色' }));
    fireEvent.change(screen.getByLabelText('角色姓名 1'), { target: { value: '沈清' } });
    fireEvent.change(screen.getByLabelText('角色服装 1'), { target: { value: '白色衬衫与黑色西装裤' } });
    fireEvent.click(screen.getByRole('button', { name: '保存角色设定' }));

    await waitFor(() => expect(client.script.characters.save).toHaveBeenCalledWith(
      'project-1',
      expect.arrayContaining([expect.objectContaining({ name: '沈清', defaultOutfit: '白色衬衫与黑色西装裤' })]),
      0,
    ));
  });

  it('edits and saves the world bible as structured lists', async () => {
    const client = createClient();
    const world = {
      projectId: 'project-1',
      era: '当代 2026 年',
      primaryLocations: ['沈家老宅'],
      worldState: '新旧家庭秩序碰撞',
      rules: ['绝食规矩'],
      transport: ['私家车'],
      communication: ['智能手机'],
      organizations: ['沈家'],
      recurringProps: ['雕花木门'],
      forbiddenAnachronisms: [],
      revision: 3,
      updatedAt: '2026-08-14T00:00:00.000Z',
    };
    vi.mocked(client.script.world.get).mockResolvedValue(world);
    vi.mocked(client.script.world.save).mockResolvedValue({ ...world, era: '当代 2027 年', revision: 4 });
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '世界设定' }));
    fireEvent.change(screen.getByLabelText('时代'), { target: { value: '当代 2027 年' } });
    fireEvent.click(screen.getByRole('button', { name: '保存世界设定' }));

    await waitFor(() => expect(client.script.world.save).toHaveBeenCalledWith(
      'project-1', expect.objectContaining({ era: '当代 2027 年' }), 3,
    ));
  });

  it('opens a generated episode, edits a script block, and saves its revision', async () => {
    const client = createClient();
    vi.mocked(client.script.episodes.list).mockResolvedValue([{
      id: 'episode-1', episodeNumber: 1, title: '请太奶奶用膳', status: 'completed',
      targetChars: 1200, visibleChars: 1180, sceneCount: 1, revision: 7,
      updatedAt: '2026-08-14T00:00:00.000Z',
    }]);
    const episode = {
      id: 'episode-1', projectId: 'project-1', episodeNumber: 1, title: '请太奶奶用膳',
      outlineId: 'outline-1', status: 'completed' as const, targetChars: 1200,
      scenes: [{ id: 'scene-1', ordinal: 1, location: '沈家老宅', timeOfDay: 'day' as const, interiorExterior: 'exterior' as const, characterIds: [], blocks: [{ id: 'block-1', type: 'action' as const, text: '旧动作' }] }],
      summary: '', newFacts: [], openedThreads: [], closedThreads: [], revision: 7,
      createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
    };
    vi.mocked(client.script.episodes.get).mockResolvedValue(episode);
    vi.mocked(client.script.episodes.save).mockResolvedValue({ ...episode, revision: 8 });
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    fireEvent.click(screen.getByRole('button', { name: '打开第 1 集' }));
    fireEvent.change(await screen.findByLabelText('第 1 集场景 1 块 1'), { target: { value: '新动作' } });
    fireEvent.click(screen.getByRole('button', { name: '保存第 1 集' }));

    await waitFor(() => expect(client.script.episodes.save).toHaveBeenCalledWith(
      'project-1', 1, expect.objectContaining({ scenes: [expect.objectContaining({ blocks: [expect.objectContaining({ text: '新动作' })] })] }), 7,
    ));
  });

  it('polls active jobs and episode summaries every two seconds', async () => {
    const client = createClient();
    vi.mocked(client.script.jobs.list)
      .mockResolvedValueOnce([{ id: 'job-1', projectId: 'project-1', task: 'script_episode_batch', status: 'running', continuable: false }])
      .mockResolvedValueOnce([{ id: 'job-1', projectId: 'project-1', task: 'script_episode_batch', status: 'completed', continuable: false }]);
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    await waitFor(() => expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 2000));
    const poll = intervalSpy.mock.calls.find((call) => call[1] === 2000)?.[0] as () => Promise<void>;
    await act(async () => { await poll(); });

    expect(client.script.jobs.list).toHaveBeenCalledTimes(2);
    expect(client.script.episodes.list).toHaveBeenCalledTimes(2);
  });

  it('exports TXT, Markdown, and DOCX from the completed script', async () => {
    const client = createClient();
    vi.mocked(client.script.export).mockResolvedValue('第一集\n1-1 沈家老宅 日/外');
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:script'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    fireEvent.click(screen.getByRole('button', { name: '导出 TXT' }));
    await waitFor(() => expect(client.script.export).toHaveBeenCalledWith('project-1', 'txt'));
    fireEvent.click(screen.getByRole('button', { name: '导出 MD' }));
    await waitFor(() => expect(client.script.export).toHaveBeenCalledWith('project-1', 'md'));
    fireEvent.click(screen.getByRole('button', { name: '导出 DOCX' }));
    await waitFor(() => expect(client.script.export).toHaveBeenCalledWith('project-1', 'txt'));
  });
});
