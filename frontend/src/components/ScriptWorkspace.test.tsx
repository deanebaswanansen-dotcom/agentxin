import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/apiClient.js';
import type {
  ScriptCharacter,
  ScriptEpisode,
  ScriptPlan,
  ScriptSeriesOutline,
  ScriptWorkspaceSnapshot,
  ScriptWorldBible,
} from '../types/index.js';
import completeCharacterFixtureJson from '../test/fixtures/script-character.v1.json';
import { ScriptWorkspace } from './ScriptWorkspace.js';

const completeCharacterFixture: ScriptCharacter = {
  ...completeCharacterFixtureJson,
  role: completeCharacterFixtureJson.role as ScriptCharacter['role'],
};

function buildPlan(projectId = 'project-1'): ScriptPlan {
  return {
    id: `plan-${projectId}`,
    projectId,
    status: 'draft',
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
        concepts: vi.fn(),
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
      exportFile: vi.fn(),
    },
  } as unknown as Pick<ApiClient, 'script'>;
}

function buildOutline(synopsis = '服务器大纲'): ScriptSeriesOutline {
  return {
    projectId: 'project-1', synopsis, openingState: '开局', midpointTurn: '中点', climax: '高潮',
    endingState: '结局', mainArc: ['破局'], subplotArcs: ['亲情'], episodeCards: [], revision: 4,
  };
}

function buildCharacter(name = '服务器角色'): ScriptCharacter {
  return {
    ...completeCharacterFixture,
    id: 'character-1', projectId: 'project-1', name, revision: 2,
    updatedAt: '2026-08-15T00:00:00.000Z',
  };
}

function buildWorld(era = '服务器时代'): ScriptWorldBible {
  return {
    projectId: 'project-1', era, primaryLocations: ['老宅'], worldState: '现状', rules: [], transport: [],
    communication: [], organizations: [], recurringProps: [], forbiddenAnachronisms: [], revision: 3,
    updatedAt: '2026-08-15T00:00:00.000Z',
  };
}

function buildEpisode(actionText = '服务器旧正文', revision = 1): ScriptEpisode {
  return {
    id: 'episode-1', projectId: 'project-1', episodeNumber: 1, title: '第一集', outlineId: 'outline-1',
    status: 'completed', targetChars: 1200,
    scenes: [{
      id: 'scene-1', ordinal: 1, location: '老宅', timeOfDay: 'day', interiorExterior: 'interior',
      characterIds: [], blocks: [{ id: 'block-1', type: 'action', text: actionText }],
    }],
    summary: '', newFacts: [], openedThreads: [], closedThreads: [], revision,
    createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
  };
}

function buildNumberedEpisode(episodeNumber: number, actionText: string, revision = 1): ScriptEpisode {
  const episode = buildEpisode(actionText, revision);
  return {
    ...episode,
    id: `episode-${episodeNumber}`,
    episodeNumber,
    title: `第 ${episodeNumber} 集`,
    outlineId: `outline-${episodeNumber}`,
    scenes: episode.scenes.map((scene) => ({
      ...scene,
      id: `scene-${episodeNumber}-1`,
      blocks: scene.blocks.map((block) => ({ ...block, id: `block-${episodeNumber}-1` })),
    })),
  };
}

function summarizeEpisode(episode: ScriptEpisode): ScriptWorkspaceSnapshot['episodeSummaries'][number] {
  return {
    id: episode.id,
    episodeNumber: episode.episodeNumber,
    title: episode.title,
    status: episode.status,
    targetChars: episode.targetChars,
    visibleChars: episode.scenes.reduce((total, scene) => (
      total + scene.blocks.reduce((sceneTotal, block) => sceneTotal + block.text.replace(/\s/gu, '').length, 0)
    ), 0),
    sceneCount: episode.scenes.length,
    revision: episode.revision,
    updatedAt: episode.updatedAt,
  };
}

function buildWorkspaceSnapshot(
  overrides: Partial<ScriptWorkspaceSnapshot> = {},
): ScriptWorkspaceSnapshot {
  return {
    schemaVersion: 1,
    projectId: 'project-1',
    plan: buildPlan(),
    outline: buildOutline(),
    characters: [buildCharacter()],
    worldBible: buildWorld(),
    episodeSummaries: [],
    batchSummaries: [],
    reviewRevision: 0,
    reviewIssues: [],
    updatedAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  };
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

  it('opens completed planning material in a readable product view before editing', async () => {
    const client = createClient({ ...buildPlan(), status: 'approved' });
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    expect(
      await screen.findByRole('heading', {
        level: 3,
        name: '绝食逼我道歉？我当面吃香喝辣',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('剧本名称')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '编辑模式' }));
    expect(screen.getByLabelText('剧本名称')).toHaveValue('绝食逼我道歉？我当面吃香喝辣');
  });

  it('uses the aggregate workspace snapshot and persists proofreading decisions', async () => {
    const client = createClient();
    const issue = {
      id: 'issue-1', projectId: 'project-1', episodeNumber: 1, code: 'MISSING_HOOK',
      severity: 'soft' as const, category: 'hook' as const, message: '结尾缺少明确卡点。',
      suggestion: '增加下一集危机。', status: 'open' as const, source: 'deterministic' as const,
      createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    };
    const summary = {
      id: 'episode-1', episodeNumber: 1, title: '第一集', status: 'reviewing' as const,
      targetChars: 1200, visibleChars: 980, sceneCount: 3, revision: 1,
      updatedAt: '2026-08-15T00:00:00.000Z',
    };
    const workspaceGet = vi.fn().mockResolvedValue({
      schemaVersion: 1 as const,
      projectId: 'project-1',
      plan: buildPlan(),
      characters: [],
      episodeSummaries: [summary],
      batchSummaries: [{
        startEpisode: 1, endEpisode: 5, status: 'proofreading' as const,
        completedEpisodes: 0, visibleChars: 980, unresolvedHardIssues: 0, unresolvedSoftIssues: 1,
      }],
      reviewRevision: 3,
      reviewIssues: [issue],
      updatedAt: '2026-08-15T00:00:00.000Z',
    });
    const updateStatus = vi.fn().mockResolvedValue({ revision: 4, item: { ...issue, status: 'fixed' } });
    Object.assign(client.script, {
      workspace: { get: workspaceGet },
      reviews: { list: vi.fn(), save: vi.fn(), updateStatus },
    });
    Object.assign(client.script.episodes, {
      review: vi.fn(),
    });

    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    expect(await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣')).toBeInTheDocument();
    expect(workspaceGet).toHaveBeenCalledWith('project-1', expect.any(AbortSignal));
    expect(client.script.plan.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    expect(await screen.findByText('结尾缺少明确卡点。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '标记已修复' }));
    await waitFor(() => expect(updateStatus).toHaveBeenCalledWith('project-1', 'issue-1', 'fixed', 3));
    expect(await screen.findByText('已修复')).toBeInTheDocument();
  });

  it('loads jobs before the aggregate snapshot so a completed job cannot strand stale workspace data', async () => {
    const client = createClient();
    let resolveJobs!: (jobs: Awaited<ReturnType<typeof client.script.jobs.list>>) => void;
    vi.mocked(client.script.jobs.list).mockReturnValue(new Promise((resolve) => {
      resolveJobs = resolve;
    }));
    const workspaceGet = vi.fn().mockResolvedValue(buildWorkspaceSnapshot({
      plan: { ...buildPlan(), title: '任务完成后的快照' },
    }));
    Object.assign(client.script, { workspace: { get: workspaceGet } });
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await waitFor(() => expect(client.script.jobs.list).toHaveBeenCalledTimes(1));
    expect(workspaceGet).not.toHaveBeenCalled();
    await act(async () => { resolveJobs([{
      id: 'job-1', projectId: 'project-1', task: 'script_bible', status: 'completed', continuable: false,
    }]); });

    expect(await screen.findByDisplayValue('任务完成后的快照')).toBeInTheDocument();
    expect(workspaceGet).toHaveBeenCalledWith('project-1', expect.any(AbortSignal));
  });

  it('shows an AI hard finding as advisory instead of a blocking hard count', async () => {
    const client = createClient();
    const aiIssue = {
      id: 'ai-hard-1', projectId: 'project-1', episodeNumber: 1, code: 'AI_WEAK_HOOK',
      severity: 'hard' as const, category: 'hook' as const, message: 'AI 认为卡点还可以更强。',
      status: 'open' as const, source: 'ai' as const,
      createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    };
    Object.assign(client.script, {
      workspace: {
        get: vi.fn().mockResolvedValue(buildWorkspaceSnapshot({
          episodeSummaries: [summarizeEpisode(buildEpisode())],
          reviewIssues: [aiIssue],
        })),
      },
      reviews: { list: vi.fn(), save: vi.fn(), updateStatus: vi.fn() },
    });

    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);
    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));

    expect(await screen.findByText('第 1 集 · AI 重点建议')).toBeInTheDocument();
    expect(screen.getByText('0 个硬性')).toBeInTheDocument();
    expect(screen.getByText('1 个待优化')).toBeInTheDocument();
  });

  it('does not offer a later fixed batch until every preceding episode is completed', async () => {
    const client = createClient();
    const first = { ...buildNumberedEpisode(1, '第一集未完成'), status: 'reviewing' as const };
    vi.mocked(client.script.episodes.list).mockResolvedValue([
      { ...summarizeEpisode(first), status: 'reviewing' },
    ]);

    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);
    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    fireEvent.click(screen.getByText('6–10集剧本正文').closest('button')!);

    expect(screen.getByText('请先完成第 1–5 集')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '生成第 6–10 集' })).not.toBeInTheDocument();
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

  it('keeps a resource dirty and reports remaining edits when it changes during save', async () => {
    const client = createClient();
    let resolveSave!: (plan: ScriptPlan) => void;
    vi.mocked(client.script.plan.save).mockReturnValue(new Promise((resolve) => {
      resolveSave = resolve;
    }));
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    const title = await screen.findByLabelText('剧本名称');
    fireEvent.change(title, { target: { value: '准备保存的策划' } });
    fireEvent.click(screen.getByRole('button', { name: '保存策划' }));
    await waitFor(() => expect(client.script.plan.save).toHaveBeenCalledTimes(1));
    fireEvent.change(title, { target: { value: '保存期间继续编辑的策划' } });
    const submitted = vi.mocked(client.script.plan.save).mock.calls[0]?.[1];
    await act(async () => {
      resolveSave({
        ...submitted!,
        revision: 3,
        updatedAt: '2026-08-15T00:01:00.000Z',
      });
    });

    expect(screen.getByLabelText('剧本名称')).toHaveValue('保存期间继续编辑的策划');
    expect(screen.getByText('策划已保存，仍有未保存修改')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认策划' }));
    expect(client.script.plan.approve).not.toHaveBeenCalled();
    expect(screen.getByText('请先保存策划，再确认')).toBeInTheDocument();
  });

  it('requires saving a dirty plan before approval without losing the edit', async () => {
    const client = createClient();
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);
    const title = await screen.findByLabelText('剧本名称');
    fireEvent.change(title, { target: { value: '尚未保存的新剧名' } });

    fireEvent.click(screen.getByRole('button', { name: '确认策划' }));
    expect(client.script.plan.approve).not.toHaveBeenCalled();
    expect(screen.getByText('请先保存策划，再确认')).toBeInTheDocument();
    expect(title).toHaveValue('尚未保存的新剧名');

    fireEvent.click(screen.getByRole('button', { name: '保存策划' }));
    await screen.findByText('策划已保存');
    fireEvent.click(screen.getByRole('button', { name: '确认策划' }));
    await waitFor(() => expect(client.script.plan.approve).toHaveBeenCalledWith('project-1', 3));
  });

  it('preserves edits made while plan approval is in flight and merges approval metadata', async () => {
    const client = createClient();
    let resolveApprove!: (plan: ScriptPlan) => void;
    vi.mocked(client.script.plan.approve).mockReturnValue(new Promise((resolve) => {
      resolveApprove = resolve;
    }));
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    const title = await screen.findByLabelText('剧本名称');
    fireEvent.click(screen.getByRole('button', { name: '确认策划' }));
    await waitFor(() => expect(client.script.plan.approve).toHaveBeenCalledWith('project-1', 2));
    fireEvent.change(title, { target: { value: '确认期间继续修改' } });

    await act(async () => {
      resolveApprove({
        ...buildPlan(),
        title: '服务器确认稿',
        status: 'approved',
        revision: 4,
        updatedAt: '2026-08-15T00:02:00.000Z',
      });
    });

    expect(screen.getByLabelText('剧本名称')).toHaveValue('确认期间继续修改');
    expect(screen.getByText('已确认')).toBeInTheDocument();
    expect(screen.getByText('策划已确认，仍有未保存修改')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存策划' }));
    await waitFor(() => expect(client.script.plan.save).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ title: '确认期间继续修改', status: 'approved', revision: 4 }),
      4,
    ));
  });

  it('generates three real concept candidates and adopts one without saving automatically', async () => {
    const client = createClient();
    const proposal = {
      title: '夜班真相', theme: '职场反击', market: 'domestic' as const, channel: 'female' as const,
      genres: ['都市', '职场'], logline: '夜班店员查出奖金被盗的证据。', audience: '年轻女性',
      coreConflict: '普通店员对抗黑心店长', highlights: ['证据反转'], endingDirection: '公开真相',
      mainArc: '从忍气吞声到公开证据完成反击', coverPrompt: '9:16 便利店夜景', totalEpisodes: 60,
    };
    vi.mocked(client.script.plan.concepts).mockResolvedValue({
      proposals: [proposal, { ...proposal, title: '监控死角' }, { ...proposal, title: '凌晨账本' }],
    });
    vi.mocked(client.script.jobs.create).mockResolvedValue({
      id: 'outline-job', projectId: 'project-1', task: 'script_series_outline', status: 'queued', continuable: false,
    });
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.change(screen.getByLabelText('选题灵感'), { target: { value: '便利店夜班反击' } });
    fireEvent.click(screen.getByRole('button', { name: '生成 3 个选题' }));
    expect(await screen.findByText('监控死角')).toBeInTheDocument();
    expect(client.script.plan.concepts).toHaveBeenCalledWith('project-1', '便利店夜班反击');
    fireEvent.click(screen.getAllByRole('button', { name: '采用此方案' })[0]!);

    expect(screen.getByLabelText('剧本名称')).toHaveValue('夜班真相');
    expect(client.script.plan.save).not.toHaveBeenCalled();
    expect(screen.getByText('已采用选题《夜班真相》，请检查后保存策划')).toBeInTheDocument();
    expect((screen.getByLabelText('核心要求') as HTMLTextAreaElement).value).toContain('主线提示：从忍气吞声到公开证据完成反击');

    fireEvent.click(screen.getByRole('button', { name: '保存策划' }));
    await screen.findByText('策划已保存');
    fireEvent.click(screen.getByRole('tab', { name: '剧本大纲' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agent 生成大纲' }));
    await waitFor(() => expect(client.script.jobs.create).toHaveBeenCalledWith({
      projectId: 'project-1', task: 'script_series_outline',
    }));
    expect(screen.queryByText(/请先保存.*大纲/)).not.toBeInTheDocument();
    expect(client.script.outline.save).not.toHaveBeenCalled();
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
        plan: { ...draft, title: 'Agent 完成的策划', endingDirection: '痛快翻盘', revision: 3 },
      });
    vi.mocked(client.script.plan.approve).mockResolvedValue({
      ...draft, title: 'Agent 完成的策划', endingDirection: '痛快翻盘', status: 'approved', revision: 4,
    });
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('button', { name: 'Agent 帮我策划' }));
    expect(await screen.findByText('结局要给观众什么情绪？')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '痛快翻盘' }));
    fireEvent.click(screen.getByRole('button', { name: '提交本轮答案' }));

    expect(await screen.findByDisplayValue('Agent 完成的策划')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认策划' }));
    await waitFor(() => expect(client.script.plan.approve).toHaveBeenCalledWith('project-1', 3));
    expect(client.script.plan.save).not.toHaveBeenCalled();
    expect(await screen.findByText('策划已确认，可生成大纲、角色与世界设定')).toBeInTheDocument();
  });

  it('does not apply a stale Agent plan when the user edits during the request', async () => {
    const client = createClient();
    let resolveTurn!: (result: Awaited<ReturnType<typeof client.script.plan.turn>>) => void;
    vi.mocked(client.script.plan.turn).mockReturnValue(new Promise((resolve) => {
      resolveTurn = resolve;
    }));
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    const title = await screen.findByLabelText('剧本名称');
    fireEvent.click(screen.getByRole('button', { name: 'Agent 帮我策划' }));
    await waitFor(() => expect(client.script.plan.turn).toHaveBeenCalledTimes(1));
    fireEvent.change(title, { target: { value: '请求期间的本地策划' } });
    await act(async () => {
      resolveTurn({
        status: 'ready',
        session: 'session-stale',
        round: 1,
        plan: {
          ...buildPlan(),
          title: '过期的 Agent 策划',
          revision: 5,
          updatedAt: '2026-08-15T00:03:00.000Z',
        },
      });
    });

    expect(screen.getByLabelText('剧本名称')).toHaveValue('请求期间的本地策划');
    expect(screen.queryByDisplayValue('过期的 Agent 策划')).not.toBeInTheDocument();
    expect(screen.getByText('策划已修改，已保留本地内容，请保存后重新发起 Agent 策划')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存策划' }));
    await waitFor(() => expect(client.script.plan.save).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ title: '请求期间的本地策划', revision: 5 }),
      5,
    ));
  });

  it('starts outline and the truthful combined bible Agent from their production stages', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Agent 补全人物与世界' }));
    await waitFor(() => expect(client.script.jobs.create).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('tab', { name: '世界设定' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agent 补全人物与世界' }));
    await waitFor(() => {
      expect(client.script.jobs.create).toHaveBeenCalledWith({
        projectId: 'project-1', task: 'script_bible',
      });
      expect(client.script.jobs.create).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText('人物与世界补全任务正在运行，请勿重复提交')).toBeInTheDocument();
  });

  it('does not start material Agents from unsaved source data', async () => {
    const client = createClient();
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    const title = await screen.findByLabelText('剧本名称');
    fireEvent.change(title, { target: { value: '尚未保存的策划' } });
    fireEvent.click(screen.getByRole('tab', { name: '剧本大纲' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agent 生成大纲' }));
    expect(client.script.jobs.create).not.toHaveBeenCalled();
    expect(screen.getByText('请先保存策划，再启动 Agent')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '剧本策划' }));
    fireEvent.click(screen.getByRole('button', { name: '保存策划' }));
    await screen.findByText('策划已保存');
    fireEvent.click(screen.getByRole('tab', { name: '角色设定' }));
    fireEvent.click(screen.getByRole('button', { name: '添加角色' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agent 补全人物与世界' }));
    expect(client.script.jobs.create).not.toHaveBeenCalled();
    expect(screen.getByText('请先保存角色设定，再启动 Agent')).toBeInTheDocument();
  });

  it('does not generate episodes while foundational production data is unsaved', async () => {
    const client = createClient();
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    fireEvent.change(await screen.findByLabelText('剧本名称'), { target: { value: '未保存策划' } });
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    fireEvent.click(screen.getByRole('button', { name: '生成第 1–5 集' }));

    expect(client.script.jobs.create).not.toHaveBeenCalled();
    expect(screen.getByText('请先保存策划，再生成正文')).toBeInTheDocument();
  });

  it('does not resume jobs or export server content while a production resource is dirty', async () => {
    const client = createClient();
    vi.mocked(client.script.jobs.list).mockResolvedValue([{
      id: 'job-paused', projectId: 'project-1', task: 'script_episode_batch', status: 'failed', continuable: true,
    }]);
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    fireEvent.change(await screen.findByLabelText('剧本名称'), { target: { value: '未保存策划' } });
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    fireEvent.click(screen.getByRole('button', { name: '从检查点继续' }));
    expect(client.script.jobs.resume).not.toHaveBeenCalled();
    expect(screen.getByText('请先保存策划，再继续任务')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '导出 TXT' }));
    expect(client.script.exportFile).not.toHaveBeenCalled();
    expect(screen.getByText('请先保存策划，再导出')).toBeInTheDocument();
  });

  it('does not submit duplicate active material or overlapping episode jobs', async () => {
    const client = createClient();
    vi.mocked(client.script.jobs.list).mockResolvedValue([{
      id: 'job-bible', projectId: 'project-1', task: 'script_bible', status: 'running', continuable: false,
    }, {
      id: 'job-batch', projectId: 'project-1', task: 'script_episode_batch', status: 'queued', continuable: false,
      scriptBatchOptions: { startEpisode: 1, episodeCount: 5, expectedPlanRevision: 2 },
    }]);
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '角色设定' }));
    fireEvent.click(screen.getByRole('button', { name: 'Agent 补全人物与世界' }));
    expect(screen.getByText('人物与世界补全任务正在运行，请勿重复提交')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    fireEvent.click(screen.getByRole('button', { name: '生成第 1–5 集' }));
    expect(screen.getByText('第 1–5 集已有生成任务正在运行')).toBeInTheDocument();
    expect(client.script.jobs.create).not.toHaveBeenCalled();
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

  it('keeps a failed second episode inside its fixed 1–5 batch and resumes that job', async () => {
    const client = createClient();
    const episode1 = buildNumberedEpisode(1, '第一集已完成');
    const episode2 = { ...buildNumberedEpisode(2, '第二集待修复'), status: 'failed' as const };
    vi.mocked(client.script.episodes.list).mockResolvedValue([
      summarizeEpisode(episode1),
      { ...summarizeEpisode(episode2), status: 'failed' },
    ]);
    const failedJob = {
      id: 'job-failed-episode-2', projectId: 'project-1', task: 'script_episode_batch' as const,
      status: 'failed' as const, continuable: true,
      scriptBatchOptions: { startEpisode: 1, episodeCount: 5, expectedPlanRevision: 2 },
      checkpoint: { episodeNumber: 2, node: 'review' as const, attempt: 2, artifactRevision: 1 },
    };
    vi.mocked(client.script.jobs.list).mockResolvedValue([failedJob]);
    vi.mocked(client.script.jobs.resume).mockResolvedValue({ ...failedJob, status: 'running', continuable: false });
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));

    expect(screen.queryByRole('button', { name: '生成第 2–6 集' })).not.toBeInTheDocument();
    const resume = screen.getByRole('button', { name: '继续第 2 集所在的 1–5 集任务' });
    fireEvent.click(resume);
    await waitFor(() => expect(client.script.jobs.resume).toHaveBeenCalledWith('job-failed-episode-2'));
    expect(client.script.jobs.create).not.toHaveBeenCalled();
  });

  it('restarts a partial batch from its fixed boundary instead of generating episodes 2–6', async () => {
    const client = createClient();
    const episode1 = buildNumberedEpisode(1, '第一集已完成');
    const episode2 = { ...buildNumberedEpisode(2, '第二集失败'), status: 'failed' as const };
    vi.mocked(client.script.episodes.list).mockResolvedValue([
      summarizeEpisode(episode1),
      { ...summarizeEpisode(episode2), status: 'failed' },
    ]);
    vi.mocked(client.script.jobs.create).mockResolvedValue({
      id: 'job-restart-1-5', projectId: 'project-1', task: 'script_episode_batch', status: 'queued', continuable: false,
      scriptBatchOptions: { startEpisode: 1, episodeCount: 5, expectedPlanRevision: 2 },
    });
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    expect(screen.queryByRole('button', { name: '生成第 2–6 集' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '生成第 1–5 集' }));

    await waitFor(() => expect(client.script.jobs.create).toHaveBeenCalledWith({
      projectId: 'project-1',
      task: 'script_episode_batch',
      scriptBatchOptions: { startEpisode: 1, episodeCount: 5, expectedPlanRevision: 2 },
    }));
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
    fireEvent.click(screen.getByRole('button', { name: '编辑模式' }));
    fireEvent.change(screen.getByLabelText('全剧梗概'), { target: { value: '新梗概' } });
    fireEvent.click(screen.getByRole('button', { name: '保存大纲' }));

    await waitFor(() => expect(client.script.outline.save).toHaveBeenCalledWith(
      'project-1', expect.objectContaining({ synopsis: '新梗概' }), 4,
    ));
  });

  it('locally rejects an incomplete character, then saves every canonical field from the editor', async () => {
    const client = createClient();
    vi.mocked(client.script.characters.save).mockImplementation((_projectId, items) => Promise.resolve(items));
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '角色设定' }));
    fireEvent.click(screen.getByRole('button', { name: '添加角色' }));
    fireEvent.click(screen.getByRole('button', { name: '保存角色设定' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('角色 1 缺少人物身份');
    expect(client.script.characters.save).not.toHaveBeenCalled();

    const fields: Array<[string, string]> = [
      ['角色姓名 1', completeCharacterFixture.name],
      ['角色别名 1', `${completeCharacterFixture.aliases[0]}\n${completeCharacterFixture.aliases[0]}`],
      ['角色身份 1', completeCharacterFixture.identity],
      ['角色小传 1', completeCharacterFixture.biography],
      ['角色动机 1', completeCharacterFixture.motivation],
      ['角色目标 1', completeCharacterFixture.goal],
      ['角色弱点 1', completeCharacterFixture.weakness],
      ['角色弧光 1', completeCharacterFixture.arc],
      ['角色外貌 1', completeCharacterFixture.appearance],
      ['角色发型 1', completeCharacterFixture.hairstyle],
      ['角色体格 1', completeCharacterFixture.physique],
      ['角色服装 1', completeCharacterFixture.defaultOutfit],
      ['角色性格 1', `${completeCharacterFixture.personality.join('\n')}\n冷静`],
      ['角色技能 1', completeCharacterFixture.skills.join('\n')],
      ['角色语言风格 1', completeCharacterFixture.speechStyle],
      ['角色口头禅 1', completeCharacterFixture.catchphrases.join('\n')],
    ];
    fields.forEach(([label, value]) => fireEvent.change(screen.getByLabelText(label), { target: { value } }));
    fireEvent.click(screen.getByRole('button', { name: '保存角色设定' }));

    await waitFor(() => expect(client.script.characters.save).toHaveBeenCalledWith(
      'project-1',
      expect.arrayContaining([expect.objectContaining({
        name: completeCharacterFixture.name,
        identity: completeCharacterFixture.identity,
        biography: completeCharacterFixture.biography,
        motivation: completeCharacterFixture.motivation,
        goal: completeCharacterFixture.goal,
        weakness: completeCharacterFixture.weakness,
        arc: completeCharacterFixture.arc,
        appearance: completeCharacterFixture.appearance,
        hairstyle: completeCharacterFixture.hairstyle,
        physique: completeCharacterFixture.physique,
        defaultOutfit: completeCharacterFixture.defaultOutfit,
        personality: completeCharacterFixture.personality,
        skills: completeCharacterFixture.skills,
        speechStyle: completeCharacterFixture.speechStyle,
        catchphrases: completeCharacterFixture.catchphrases,
      })]),
      0,
    ));
  });

  it('edits character relationships as target, label, and notes rows', async () => {
    const client = createClient();
    const shenQing = { ...completeCharacterFixture, id: 'character-1', revision: 2 };
    const shenYizhou = { ...completeCharacterFixture, id: 'character-2', name: '沈亦舟', aliases: [], revision: 2 };
    vi.mocked(client.script.characters.list).mockResolvedValue([shenQing, shenYizhou]);
    vi.mocked(client.script.characters.save).mockImplementation((_projectId, items) => Promise.resolve(items));
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '角色设定' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑模式' }));
    fireEvent.click(screen.getAllByRole('button', { name: '添加关系' })[0]!);
    fireEvent.change(screen.getByLabelText('角色关系目标 1-1'), { target: { value: 'character-2' } });
    fireEvent.change(screen.getByLabelText('角色关系标签 1-1'), { target: { value: '恋人' } });
    fireEvent.change(screen.getByLabelText('角色关系备注 1-1'), { target: { value: '共同对抗旧规矩' } });
    fireEvent.click(screen.getByRole('button', { name: '保存角色设定' }));

    await waitFor(() => expect(client.script.characters.save).toHaveBeenCalledWith(
      'project-1',
      expect.arrayContaining([expect.objectContaining({
        id: 'character-1',
        relationships: [{ characterId: 'character-2', label: '恋人', notes: '共同对抗旧规矩' }],
      })]),
      2,
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
    fireEvent.click(screen.getByRole('button', { name: '编辑模式' }));
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
    vi.mocked(client.script.episodes.save).mockImplementation((_projectId, _episodeNumber, value) => (
      Promise.resolve({ ...value, revision: 8 })
    ));
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    fireEvent.click(screen.getByRole('button', { name: '打开第 1 集' }));
    fireEvent.change(await screen.findByLabelText('第 1 集场景 1 块 1'), { target: { value: ' 新 动作\n' } });
    fireEvent.click(screen.getByRole('button', { name: '保存第 1 集' }));

    await waitFor(() => expect(client.script.episodes.save).toHaveBeenCalledWith(
      'project-1', 1, expect.objectContaining({ scenes: [expect.objectContaining({ blocks: [expect.objectContaining({ text: ' 新 动作\n' })] })] }), 7,
    ));
    await waitFor(() => expect(screen.getAllByText('3 字').length).toBeGreaterThan(0));
  });

  it('keeps a dirty episode open when reopening it, switching episodes or batches, and blocks stale review', async () => {
    const client = createClient();
    const episode1 = { ...buildNumberedEpisode(1, '第一集正文', 3), status: 'reviewing' as const };
    const episode2 = buildNumberedEpisode(2, '第二集正文', 4);
    vi.mocked(client.script.episodes.list).mockResolvedValue([
      { ...summarizeEpisode(episode1), status: 'reviewing' },
      summarizeEpisode(episode2),
    ]);
    vi.mocked(client.script.episodes.get).mockImplementation((_projectId, episodeNumber) => (
      Promise.resolve(episodeNumber === 1 ? episode1 : episode2)
    ));
    vi.mocked(client.script.jobs.list).mockResolvedValue([{
      id: 'job-paused', projectId: 'project-1', task: 'script_episode_batch', status: 'failed', continuable: true,
    }]);
    const review = vi.fn();
    Object.assign(client.script.episodes, { review });
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    await screen.findByText('△第一集正文');
    fireEvent.click(screen.getByRole('button', { name: '打开第 1 集' }));
    const editor = await screen.findByLabelText('第 1 集场景 1 块 1');
    fireEvent.change(editor, { target: { value: '第1集本地未保存正文' } });
    const requestCount = vi.mocked(client.script.episodes.get).mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: '打开第 1 集' }));
    fireEvent.click(screen.getByRole('button', { name: '打开第 2 集' }));
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    fireEvent.click(screen.getByText('6–10集剧本正文').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: '校稿第 1 集' }));
    fireEvent.click(screen.getByRole('button', { name: '生成第 1–5 集' }));
    fireEvent.click(screen.getByRole('button', { name: '从检查点继续' }));
    fireEvent.click(screen.getByRole('button', { name: '导出 TXT' }));

    expect(client.script.episodes.get).toHaveBeenCalledTimes(requestCount);
    expect(review).not.toHaveBeenCalled();
    expect(client.script.jobs.create).not.toHaveBeenCalled();
    expect(client.script.jobs.resume).not.toHaveBeenCalled();
    expect(client.script.exportFile).not.toHaveBeenCalled();
    expect(screen.getByLabelText('第 1 集场景 1 块 1')).toHaveValue('第1集本地未保存正文');
    expect(screen.queryByLabelText('第 2 集场景 1 块 1')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '1–5集剧本正文' })).toBeInTheDocument();
    expect(screen.getByText('请先保存当前集')).toBeInTheDocument();
  });

  it('does not generate the next batch while the preceding episode has unsaved continuity edits', async () => {
    const client = createClient();
    const episodes = Array.from({ length: 5 }, (_, index) => (
      buildNumberedEpisode(index + 1, `第${index + 1}集正文`, 2)
    ));
    vi.mocked(client.script.episodes.list).mockResolvedValue(episodes.map(summarizeEpisode));
    vi.mocked(client.script.episodes.get).mockImplementation((_projectId, episodeNumber) => (
      Promise.resolve(episodes[episodeNumber - 1])
    ));
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    await screen.findByText('△第5集正文');
    fireEvent.click(screen.getByRole('button', { name: '打开第 5 集' }));
    fireEvent.change(await screen.findByLabelText('第 5 集场景 1 块 1'), {
      target: { value: '第5集未保存的连续性修改' },
    });
    fireEvent.click(screen.getByText('6–10集剧本正文').closest('button')!);

    expect(client.script.jobs.create).not.toHaveBeenCalled();
    expect(screen.getByText('请先保存当前集')).toBeInTheDocument();
    expect(screen.getByLabelText('第 5 集场景 1 块 1')).toHaveValue('第5集未保存的连续性修改');
  });

  it('ignores a deferred episode response when the current episode is edited while it loads', async () => {
    const client = createClient();
    const episode1 = buildNumberedEpisode(1, '第一集正文', 3);
    const episode2 = buildNumberedEpisode(2, '第二集正文', 4);
    vi.mocked(client.script.episodes.list).mockResolvedValue([
      summarizeEpisode(episode1),
      summarizeEpisode(episode2),
    ]);
    let episode2Calls = 0;
    let resolveEpisode2!: (episode: ScriptEpisode) => void;
    vi.mocked(client.script.episodes.get).mockImplementation((_projectId, episodeNumber) => {
      if (episodeNumber === 2 && ++episode2Calls === 2) {
        return new Promise((resolve) => { resolveEpisode2 = resolve; });
      }
      return Promise.resolve(episodeNumber === 1 ? episode1 : episode2);
    });
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    await screen.findByText('△第一集正文');
    fireEvent.click(screen.getByRole('button', { name: '打开第 1 集' }));
    const editor = await screen.findByLabelText('第 1 集场景 1 块 1');
    fireEvent.click(screen.getByRole('button', { name: '打开第 2 集' }));
    await waitFor(() => expect(episode2Calls).toBe(2));
    fireEvent.change(editor, { target: { value: '加载第2集期间继续写第1集' } });
    await act(async () => { resolveEpisode2(episode2); });

    expect(screen.getByLabelText('第 1 集场景 1 块 1')).toHaveValue('加载第2集期间继续写第1集');
    expect(screen.queryByLabelText('第 2 集场景 1 块 1')).not.toBeInTheDocument();
    expect(screen.getByText('请先保存当前集')).toBeInTheDocument();
  });

  it('aborts a stale episode request before committing another batch', async () => {
    const client = createClient();
    const episode1 = buildNumberedEpisode(1, '第一集正文', 3);
    const episode6 = buildNumberedEpisode(6, '第六集正文', 2);
    vi.mocked(client.script.episodes.list).mockResolvedValue([
      summarizeEpisode(episode1),
      summarizeEpisode(episode6),
    ]);
    let episode1Calls = 0;
    let resolveEpisode1!: (episode: ScriptEpisode) => void;
    let staleSignal: AbortSignal | undefined;
    vi.mocked(client.script.episodes.get).mockImplementation((_projectId, episodeNumber, signal) => {
      if (episodeNumber === 1 && ++episode1Calls === 2) {
        staleSignal = signal;
        return new Promise((resolve) => { resolveEpisode1 = resolve; });
      }
      return Promise.resolve(episodeNumber === 1 ? episode1 : episode6);
    });
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    await screen.findByText('△第一集正文');
    fireEvent.click(screen.getByRole('button', { name: '打开第 1 集' }));
    await waitFor(() => expect(episode1Calls).toBe(2));
    fireEvent.click(screen.getByText('6–10集剧本正文').closest('button')!);
    expect(staleSignal?.aborted).toBe(true);
    await screen.findByRole('heading', { name: '6–10集剧本正文' });

    await act(async () => { resolveEpisode1(episode1); });
    expect(screen.getByRole('heading', { name: '6–10集剧本正文' })).toBeInTheDocument();
    expect(screen.queryByLabelText('第 1 集场景 1 块 1')).not.toBeInTheDocument();
  });

  it('keeps edits made while an episode save is in flight and advances its revision', async () => {
    const client = createClient();
    const summary = {
      id: 'episode-1', episodeNumber: 1, title: '第一集', status: 'completed' as const,
      targetChars: 1200, visibleChars: 5, sceneCount: 1, revision: 7,
      updatedAt: '2026-08-15T00:00:00.000Z',
    };
    vi.mocked(client.script.episodes.list).mockResolvedValue([summary]);
    vi.mocked(client.script.episodes.get).mockResolvedValue(buildEpisode('初始正文', 7));
    let resolveSave!: (episode: ScriptEpisode) => void;
    vi.mocked(client.script.episodes.save).mockReturnValue(new Promise((resolve) => {
      resolveSave = resolve;
    }));
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    fireEvent.click(await screen.findByRole('button', { name: '编辑本集' }));
    const editor = await screen.findByLabelText('第 1 集场景 1 块 1');
    fireEvent.change(editor, { target: { value: '准备保存的正文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存第 1 集' }));
    await waitFor(() => expect(client.script.episodes.save).toHaveBeenCalledTimes(1));

    fireEvent.change(editor, { target: { value: '保存期间继续编辑' } });
    const submitted = vi.mocked(client.script.episodes.save).mock.calls[0]?.[2];
    await act(async () => {
      resolveSave({
        ...submitted!,
        revision: 8,
        updatedAt: '2026-08-15T00:01:00.000Z',
      });
    });

    expect(screen.getByLabelText('第 1 集场景 1 块 1')).toHaveValue('保存期间继续编辑');
    expect(screen.getByText('第 1 集已保存，仍有未保存修改')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '成品阅读' }));
    expect(await screen.findByText('△保存期间继续编辑')).toBeInTheDocument();
    expect(screen.getByText('版本 8')).toBeInTheDocument();
    expect(screen.queryByText('△准备保存的正文')).not.toBeInTheDocument();
  });

  it('polls only active jobs, prevents overlapping ticks, and refreshes changed resources', async () => {
    const client = createClient();
    const workspaceGet = vi.fn().mockResolvedValue({
      schemaVersion: 1 as const,
      projectId: 'project-1',
      plan: buildPlan(),
      characters: [],
      episodeSummaries: [],
      batchSummaries: [],
      reviewRevision: 0,
      reviewIssues: [],
      updatedAt: '2026-08-15T00:00:00.000Z',
    });
    Object.assign(client.script, { workspace: { get: workspaceGet } });
    let resolvePoll!: (jobs: Awaited<ReturnType<typeof client.script.jobs.list>>) => void;
    const pendingPoll = new Promise<Awaited<ReturnType<typeof client.script.jobs.list>>>((resolve) => {
      resolvePoll = resolve;
    });
    vi.mocked(client.script.jobs.list)
      .mockResolvedValueOnce([{ id: 'job-1', projectId: 'project-1', task: 'script_episode_batch', status: 'running', continuable: false }])
      .mockReturnValueOnce(pendingPoll);
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    await waitFor(() => expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 2000));
    const poll = intervalSpy.mock.calls.find((call) => call[1] === 2000)?.[0] as () => Promise<void>;
    let firstPoll!: Promise<void>;
    await act(async () => {
      firstPoll = poll();
      await Promise.resolve();
    });
    await act(async () => { await poll(); });

    expect(client.script.jobs.list).toHaveBeenCalledTimes(2);
    resolvePoll([{ id: 'job-1', projectId: 'project-1', task: 'script_episode_batch', status: 'completed', continuable: false }]);
    await act(async () => { await firstPoll; });

    expect(client.script.jobs.list).toHaveBeenCalledTimes(2);
    expect(workspaceGet).toHaveBeenCalledTimes(2);
    expect(client.script.episodes.list).not.toHaveBeenCalled();
  });

  it('keeps dirty resources and their CAS revisions intact across an external job refresh', async () => {
    const client = createClient();
    const initial = buildWorkspaceSnapshot({ plan: { ...buildPlan(), revision: 1 } });
    const refreshedOutline = { ...buildOutline('服务器新大纲'), revision: 6 };
    const refreshedCharacter = { ...buildCharacter('服务器新角色'), revision: 7 };
    const refreshedWorld = { ...buildWorld('服务器新时代'), revision: 8 };
    const refreshed = buildWorkspaceSnapshot({
      plan: {
        ...buildPlan(), title: '服务器新策划', status: 'approved', revision: 2,
        updatedAt: '2026-08-15T01:00:00.000Z',
      },
      outline: refreshedOutline,
      characters: [refreshedCharacter],
      worldBible: refreshedWorld,
    });
    const workspaceGet = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);
    Object.assign(client.script, { workspace: { get: workspaceGet } });
    vi.mocked(client.script.jobs.list)
      .mockResolvedValueOnce([{ id: 'job-1', projectId: 'project-1', task: 'script_bible', status: 'running', continuable: false }])
      .mockResolvedValueOnce([{ id: 'job-1', projectId: 'project-1', task: 'script_bible', status: 'completed', continuable: false }]);
    vi.mocked(client.script.plan.save).mockImplementation((_projectId, value) => Promise.resolve({ ...value, revision: 6 }));
    vi.mocked(client.script.outline.save).mockImplementation((_projectId, value) => Promise.resolve({ ...value, revision: 7 }));
    vi.mocked(client.script.characters.save).mockImplementation((_projectId, items) => Promise.resolve(
      items.map((item) => ({ ...item, revision: 8 })),
    ));
    vi.mocked(client.script.world.save).mockImplementation((_projectId, value) => Promise.resolve({ ...value, revision: 9 }));
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    fireEvent.change(await screen.findByLabelText('剧本名称'), { target: { value: '本地未保存策划' } });
    fireEvent.click(screen.getByRole('tab', { name: '剧本大纲' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑模式' }));
    fireEvent.change(screen.getByLabelText('全剧梗概'), { target: { value: '本地未保存大纲' } });
    fireEvent.click(screen.getByRole('tab', { name: '角色设定' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑模式' }));
    fireEvent.change(screen.getByLabelText('角色姓名 1'), { target: { value: '本地未保存角色' } });
    fireEvent.click(screen.getByRole('tab', { name: '世界设定' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑模式' }));
    fireEvent.change(screen.getByLabelText('时代'), { target: { value: '本地未保存时代' } });

    await waitFor(() => expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 2000));
    const poll = intervalSpy.mock.calls.find((call) => call[1] === 2000)?.[0] as () => Promise<void>;
    await act(async () => { await poll(); });

    expect(screen.getByLabelText('时代')).toHaveValue('本地未保存时代');
    fireEvent.click(screen.getByRole('button', { name: '保存世界设定' }));
    await waitFor(() => expect(client.script.world.save).toHaveBeenCalledWith(
      'project-1', expect.objectContaining({ era: '本地未保存时代', revision: 3 }), 3,
    ));
    fireEvent.click(screen.getByRole('tab', { name: '角色设定' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑模式' }));
    expect(screen.getByLabelText('角色姓名 1')).toHaveValue('本地未保存角色');
    fireEvent.click(screen.getByRole('button', { name: '保存角色设定' }));
    await waitFor(() => expect(client.script.characters.save).toHaveBeenCalledWith(
      'project-1', expect.arrayContaining([expect.objectContaining({ name: '本地未保存角色', revision: 2 })]), 2,
    ));
    fireEvent.click(screen.getByRole('tab', { name: '剧本大纲' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑模式' }));
    expect(screen.getByLabelText('全剧梗概')).toHaveValue('本地未保存大纲');
    fireEvent.click(screen.getByRole('button', { name: '保存大纲' }));
    await waitFor(() => expect(client.script.outline.save).toHaveBeenCalledWith(
      'project-1', expect.objectContaining({ synopsis: '本地未保存大纲', revision: 4 }), 4,
    ));
    fireEvent.click(screen.getByRole('tab', { name: '剧本策划' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑模式' }));
    expect(screen.getByLabelText('剧本名称')).toHaveValue('本地未保存策划');
    fireEvent.click(screen.getByRole('button', { name: '保存策划' }));
    await waitFor(() => expect(client.script.plan.save).toHaveBeenCalledWith(
      'project-1', expect.objectContaining({ title: '本地未保存策划', status: 'draft', revision: 1 }), 1,
    ));
  });

  it('refreshes the currently open batch bodies after a job checkpoint changes', async () => {
    const client = createClient();
    const summary = {
      id: 'episode-1', episodeNumber: 1, title: '第一集', status: 'completed' as const,
      targetChars: 1200, visibleChars: 1000, sceneCount: 1, revision: 2,
      updatedAt: '2026-08-15T00:00:00.000Z',
    };
    const workspaceGet = vi.fn()
      .mockResolvedValueOnce(buildWorkspaceSnapshot({ episodeSummaries: [{ ...summary, revision: 1 }] }))
      .mockResolvedValueOnce(buildWorkspaceSnapshot({ episodeSummaries: [summary] }));
    Object.assign(client.script, { workspace: { get: workspaceGet } });
    vi.mocked(client.script.jobs.list)
      .mockResolvedValueOnce([{ id: 'job-1', projectId: 'project-1', task: 'script_episode_batch', status: 'running', continuable: false }])
      .mockResolvedValueOnce([{ id: 'job-1', projectId: 'project-1', task: 'script_episode_batch', status: 'completed', continuable: false }]);
    vi.mocked(client.script.episodes.get)
      .mockResolvedValueOnce(buildEpisode('服务器旧正文', 1))
      .mockResolvedValueOnce(buildEpisode('任务完成后的新正文', 2));
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    expect(await screen.findByText('△服务器旧正文')).toBeInTheDocument();
    const poll = intervalSpy.mock.calls.find((call) => call[1] === 2000)?.[0] as () => Promise<void>;
    await act(async () => { await poll(); });

    expect(await screen.findByText('△任务完成后的新正文')).toBeInTheDocument();
    expect(client.script.episodes.get).toHaveBeenCalledTimes(2);
  });

  it('preserves an unsaved selected episode while refreshing its open batch', async () => {
    const client = createClient();
    const summary = {
      id: 'episode-1', episodeNumber: 1, title: '第一集', status: 'completed' as const,
      targetChars: 1200, visibleChars: 1000, sceneCount: 1, revision: 2,
      updatedAt: '2026-08-15T00:00:00.000Z',
    };
    const workspaceGet = vi.fn()
      .mockResolvedValueOnce(buildWorkspaceSnapshot({ episodeSummaries: [{ ...summary, revision: 1 }] }))
      .mockResolvedValueOnce(buildWorkspaceSnapshot({ episodeSummaries: [summary] }));
    Object.assign(client.script, { workspace: { get: workspaceGet } });
    vi.mocked(client.script.jobs.list)
      .mockResolvedValueOnce([{ id: 'job-1', projectId: 'project-1', task: 'script_episode_batch', status: 'running', continuable: false }])
      .mockResolvedValueOnce([{ id: 'job-1', projectId: 'project-1', task: 'script_episode_batch', status: 'completed', continuable: false }]);
    vi.mocked(client.script.episodes.get)
      .mockResolvedValueOnce(buildEpisode('服务器旧正文', 1))
      .mockResolvedValueOnce(buildEpisode('服务器旧正文', 1))
      .mockResolvedValueOnce(buildEpisode('任务完成后的服务器正文', 2));
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    fireEvent.click(screen.getByRole('tab', { name: '分批正文' }));
    fireEvent.click(await screen.findByRole('button', { name: '编辑本集' }));
    fireEvent.change(await screen.findByLabelText('第 1 集场景 1 块 1'), {
      target: { value: '用户尚未保存的正文' },
    });
    const poll = intervalSpy.mock.calls.find((call) => call[1] === 2000)?.[0] as () => Promise<void>;
    await act(async () => { await poll(); });

    expect(screen.getByLabelText('第 1 集场景 1 块 1')).toHaveValue('用户尚未保存的正文');
    fireEvent.click(screen.getByRole('button', { name: '成品阅读' }));
    expect(await screen.findByText('△用户尚未保存的正文')).toBeInTheDocument();
    expect(screen.queryByText('△任务完成后的服务器正文')).not.toBeInTheDocument();
  });

  it('dismisses only its own transient polling error after recovery', async () => {
    const client = createClient();
    const workspaceGet = vi.fn()
      .mockResolvedValueOnce(buildWorkspaceSnapshot())
      .mockResolvedValueOnce(buildWorkspaceSnapshot());
    Object.assign(client.script, { workspace: { get: workspaceGet } });
    vi.mocked(client.script.jobs.list)
      .mockResolvedValueOnce([{ id: 'job-1', projectId: 'project-1', task: 'script_bible', status: 'running', continuable: false }])
      .mockRejectedValueOnce(new Error('临时轮询失败'))
      .mockResolvedValueOnce([{ id: 'job-1', projectId: 'project-1', task: 'script_bible', status: 'completed', continuable: false }]);
    const onError = vi.fn(() => 'poll-error-id');
    const onErrorClear = vi.fn();
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    render(<ScriptWorkspace projectId="project-1" projectName="短剧项目" client={client} onError={onError} onErrorClear={onErrorClear} />);

    await screen.findByDisplayValue('绝食逼我道歉？我当面吃香喝辣');
    const poll = intervalSpy.mock.calls.find((call) => call[1] === 2000)?.[0] as () => Promise<void>;
    await act(async () => { await poll(); });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: '临时轮询失败' }));
    expect(onErrorClear).not.toHaveBeenCalled();

    await act(async () => { await poll(); });
    expect(onErrorClear).toHaveBeenCalledTimes(1);
    expect(onErrorClear).toHaveBeenCalledWith('poll-error-id');
  });

  it('exports TXT, Markdown, DOCX, and Fountain from the completed script', async () => {
    const client = createClient();
    vi.mocked(client.script.exportFile).mockImplementation((_projectId, format) => Promise.resolve({
      blob: new Blob(['第一集\n1-1 沈家老宅 日/外']),
      filename: `短剧项目.${format}`,
      contentType: 'text/plain;charset=utf-8',
    }));
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
    await waitFor(() => expect(client.script.exportFile).toHaveBeenCalledWith('project-1', 'txt'));
    fireEvent.click(screen.getByRole('button', { name: '导出 MD' }));
    await waitFor(() => expect(client.script.exportFile).toHaveBeenCalledWith('project-1', 'md'));
    fireEvent.click(screen.getByRole('button', { name: '导出 DOCX' }));
    await waitFor(() => expect(client.script.exportFile).toHaveBeenNthCalledWith(3, 'project-1', 'txt'));
    fireEvent.click(screen.getByRole('button', { name: '导出 Fountain' }));
    await waitFor(() => expect(client.script.exportFile).toHaveBeenCalledWith('project-1', 'fountain'));
  });
});
