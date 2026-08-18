/**
 * Unit tests for {@link ProjectWorkspaceView} (task 12.8, Requirement 8.2).
 *
 * Covers:
 *  - Rendering the project's chapters, characters, world settings and outlines
 *    for a selected project (Requirement 8.2).
 *  - Selecting a chapter invokes `onSelectChapter`.
 *  - Surfacing backend errors via `onError` (Requirement 8.6).
 *
 * The injected client (`Pick<typeof apiClient, 'chapters' | 'settings'>`) is
 * mocked with `vi.fn()` so no real network calls happen.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Chapter, Character, Outline, WorldSetting } from '../types/index.js';
import {
  ProjectWorkspaceView,
  type ProjectWorkspaceViewProps,
  type WorkspaceClient,
} from './ProjectWorkspaceView.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function makeClient(data: {
  chapters?: Chapter[];
  characters?: Character[];
  worldSettings?: WorldSetting[];
  outlines?: Outline[];
}): WorkspaceClient {
  return {
    chapters: {
      list: vi.fn().mockResolvedValue(data.chapters ?? []),
      create: vi.fn().mockResolvedValue({ id: 'ch-new' }),
      updateContent: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue({ id: 'ch-1', title: 'renamed', content: '', position: 0, projectId: 'p-1' }),
      remove: vi.fn().mockResolvedValue(undefined),
      reorder: vi.fn().mockResolvedValue(undefined),
    },
    settings: {
      characters: {
        list: vi.fn().mockResolvedValue(data.characters ?? []),
        create: vi.fn((_projectId, fields) =>
          Promise.resolve({ id: 'c-new', projectId: 'p-1', name: fields.name, description: fields.description }),
        ),
        update: vi.fn((id, fields) =>
          Promise.resolve({
            id,
            projectId: 'p-1',
            name: fields.name ?? '林动',
            description: fields.description ?? '主角',
          }),
        ),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      worldSettings: {
        list: vi.fn().mockResolvedValue(data.worldSettings ?? []),
        create: vi.fn((_projectId, fields) =>
          Promise.resolve({ id: 'w-new', projectId: 'p-1', title: fields.title, content: fields.content }),
        ),
        update: vi.fn((id, fields) =>
          Promise.resolve({
            id,
            projectId: 'p-1',
            title: fields.title ?? '旧标题',
            content: fields.content ?? '',
          }),
        ),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      outlines: {
        list: vi.fn().mockResolvedValue(data.outlines ?? []),
        create: vi.fn((_projectId, fields) =>
          Promise.resolve({ id: 'o-new', projectId: 'p-1', title: fields.title, content: fields.content, position: 0 }),
        ),
        update: vi.fn((id, fields) =>
          Promise.resolve({
            id,
            projectId: 'p-1',
            title: fields.title ?? '旧大纲',
            content: fields.content ?? '',
            position: 0,
          }),
        ),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
  } as unknown as WorkspaceClient;
}

const baseProps: Pick<ProjectWorkspaceViewProps, 'projectId' | 'onSelectChapter'> = {
  projectId: 'p-1',
  onSelectChapter: vi.fn(),
};

describe('ProjectWorkspaceView', () => {
  it('renders chapters, characters, world settings and outlines (Requirement 8.2)', async () => {
    const client = makeClient({
      chapters: [
        { id: 'ch-1', projectId: 'p-1', title: '第一章', content: '', position: 0 },
        { id: 'ch-2', projectId: 'p-1', title: '第二章', content: '', position: 1 },
      ],
      characters: [{ id: 'c-1', projectId: 'p-1', name: '林动', description: '主角' }],
      worldSettings: [{ id: 'w-1', projectId: 'p-1', title: '大荒古界', content: '广袤的修炼世界' }],
      outlines: [{
        id: 'o-1',
        projectId: 'p-1',
        title: '开篇',
        content: '第一卷 风起\n第一章 少年觉醒\n- 结尾钩子',
        position: 0,
      }],
    });

    render(<ProjectWorkspaceView {...baseProps} onSelectChapter={vi.fn()} client={client} />);

    // Tabs present; content is intentionally split instead of all sections shown at once.
    expect(screen.getByRole('heading', { name: '章节' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '人物' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '世界观' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '大纲' })).toBeInTheDocument();

    expect(await screen.findByRole('button', { name: '第一章' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '第二章' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '人物' }));
    expect(screen.getByText('林动')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '世界观' }));
    expect(screen.getByText('大荒古界')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '大纲' }));
    expect(screen.getByLabelText('大纲层级树')).toBeInTheDocument();
    expect(screen.getAllByText('开篇').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('第一卷 风起')).toBeInTheDocument();
    expect(screen.getByText('第一章 少年觉醒')).toBeInTheDocument();
    expect(screen.getByText('结尾钩子')).toBeInTheDocument();
  });

  it('passes the project id to each list endpoint', async () => {
    const client = makeClient({});
    render(<ProjectWorkspaceView {...baseProps} onSelectChapter={vi.fn()} client={client} />);

    await waitFor(() => expect(client.chapters.list).toHaveBeenCalled());
    expect(client.chapters.list).toHaveBeenCalledWith('p-1', expect.anything());
    expect(client.settings.characters.list).toHaveBeenCalledWith('p-1', expect.anything());
    expect(client.settings.worldSettings.list).toHaveBeenCalledWith('p-1', expect.anything());
    expect(client.settings.outlines.list).toHaveBeenCalledWith('p-1', expect.anything());
  });

  it('renders finished resource lists while another list is still loading', async () => {
    const outlineRequest = deferred<Outline[]>();
    const client = makeClient({
      chapters: [{ id: 'ch-1', projectId: 'p-1', title: '第一章', content: '', position: 0 }],
      characters: [{ id: 'c-1', projectId: 'p-1', name: '林动', description: '主角' }],
      worldSettings: [{ id: 'w-1', projectId: 'p-1', title: '大荒古界', content: '修炼世界' }],
    });
    (client.settings.outlines.list as ReturnType<typeof vi.fn>).mockReturnValue(outlineRequest.promise);

    render(<ProjectWorkspaceView {...baseProps} onSelectChapter={vi.fn()} client={client} />);

    expect(await screen.findByRole('button', { name: '第一章' })).toBeInTheDocument();
    expect(screen.getByLabelText('项目统计')).toHaveTextContent('1 章');
    expect(screen.getByLabelText('项目统计')).toHaveTextContent('1 人物');
    expect(screen.getByLabelText('项目统计')).toHaveTextContent('1 设定');
    expect(screen.getByText('加载中…')).toBeInTheDocument();

    await act(async () => {
      outlineRequest.resolve([]);
      await outlineRequest.promise;
    });
    await waitFor(() => expect(screen.queryByText('加载中…')).not.toBeInTheDocument());
  });

  it('selecting a chapter invokes onSelectChapter', async () => {
    const onSelectChapter = vi.fn();
    const client = makeClient({
      chapters: [{ id: 'ch-1', projectId: 'p-1', title: '第一章', content: '', position: 0 }],
    });
    render(<ProjectWorkspaceView {...baseProps} onSelectChapter={onSelectChapter} client={client} />);

    fireEvent.click(await screen.findByRole('button', { name: '第一章' }));
    expect(onSelectChapter).toHaveBeenCalledWith('ch-1');
  });

  it('can edit and delete character settings', async () => {
    const client = makeClient({
      characters: [{ id: 'c-1', projectId: 'p-1', name: '林动', description: '主角' }],
    });
    render(<ProjectWorkspaceView {...baseProps} onSelectChapter={vi.fn()} client={client} />);

    fireEvent.click(screen.getByRole('tab', { name: '人物' }));
    expect(await screen.findByText('林动')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('编辑标题'), { target: { value: '林澈' } });
    fireEvent.change(screen.getByLabelText('编辑内容'), { target: { value: '主角，能感知灵脉' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(client.settings.characters.update).toHaveBeenCalledWith('c-1', {
        name: '林澈',
        description: '主角，能感知灵脉',
      }),
    );
    expect(await screen.findByText('林澈')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByRole('dialog', { name: '删除资料确认' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(client.settings.characters.remove).toHaveBeenCalledWith('c-1'));
    await waitFor(() => expect(screen.queryByText('林澈')).not.toBeInTheDocument());
  });

  it('updates character creation locally without reloading every workspace list', async () => {
    const client = makeClient({});
    render(<ProjectWorkspaceView {...baseProps} onSelectChapter={vi.fn()} client={client} />);

    await waitFor(() => expect(client.settings.characters.list).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('tab', { name: '人物' }));
    fireEvent.change(screen.getByLabelText('人物姓名'), { target: { value: '沈鸢' } });
    fireEvent.change(screen.getByLabelText('人物描述'), { target: { value: '阵营：旧城区' } });
    fireEvent.click(screen.getByRole('button', { name: '添加人物' }));

    expect((await screen.findAllByText('沈鸢')).length).toBeGreaterThan(0);
    expect(client.settings.characters.create).toHaveBeenCalledWith('p-1', {
      name: '沈鸢',
      description: '阵营：旧城区',
    });
    expect(client.chapters.list).toHaveBeenCalledTimes(1);
    expect(client.settings.characters.list).toHaveBeenCalledTimes(1);
    expect(client.settings.worldSettings.list).toHaveBeenCalledTimes(1);
    expect(client.settings.outlines.list).toHaveBeenCalledTimes(1);
  });

  it('renders a character attribute table and relationship graph from character descriptions', async () => {
    const client = makeClient({
      characters: [
        {
          id: 'c-1',
          projectId: 'p-1',
          name: '林澈',
          description: '年龄：17\n阵营：守夜人\n身份：电梯管理员\n关系：林澈 -> 沈鸢：师徒',
        },
        {
          id: 'c-2',
          projectId: 'p-1',
          name: '沈鸢',
          description: '年龄：24\n阵营：旧城区\n关系：沈鸢 -> 顾眠：宿敌',
        },
      ],
    });

    render(<ProjectWorkspaceView {...baseProps} onSelectChapter={vi.fn()} client={client} />);
    fireEvent.click(screen.getByRole('tab', { name: '人物' }));

    expect(await screen.findByLabelText('角色属性表')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '年龄' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '阵营' })).toBeInTheDocument();
    expect(screen.getByText('电梯管理员')).toBeInTheDocument();

    expect(screen.getByLabelText('人物关系图谱')).toBeInTheDocument();
    expect(screen.getByText('林澈 -> 沈鸢')).toBeInTheDocument();
    expect(screen.getByText('师徒')).toBeInTheDocument();
    expect(screen.getByText('沈鸢 -> 顾眠')).toBeInTheDocument();
    expect(screen.getByText('宿敌')).toBeInTheDocument();
  });

  it('keeps reference-analysis markdown actions out of character table columns', async () => {
    const client = makeClient({
      characters: [
        {
          id: 'c-reference',
          projectId: 'p-1',
          name: '顾停舟',
          description: [
            '# 顾停舟',
            '- **人物定位**：主角',
            '- **身份**：司灯人',
            '- **目标**：找回失去的名字',
            '## 关键行动',
            '- 第一章 空灯：顾停舟发现无名灯',
            '- **顾停舟 → 祝青岚**：同伴',
          ].join('\n'),
        },
      ],
    });

    render(<ProjectWorkspaceView {...baseProps} onSelectChapter={vi.fn()} client={client} />);
    fireEvent.click(screen.getByRole('tab', { name: '人物' }));

    expect(await screen.findByRole('columnheader', { name: '人物定位' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '身份' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '目标' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /第一章/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /顾停舟 → 祝青岚/ })).not.toBeInTheDocument();
  });

  it('renders a story timeline from world setting and outline lines', async () => {
    const client = makeClient({
      worldSettings: [
        {
          id: 'w-1',
          projectId: 'p-1',
          title: '旧城区年表',
          content: '时间线：\n- 第一天：电梯里多出一个人\n- 第三天：整栋楼停电',
        },
      ],
      outlines: [
        {
          id: 'o-1',
          projectId: 'p-1',
          title: '卷一',
          content: 'T4：林澈发现地下层\n普通说明不应进入时间线',
          position: 0,
        },
      ],
    });

    render(<ProjectWorkspaceView {...baseProps} onSelectChapter={vi.fn()} client={client} />);
    fireEvent.click(screen.getByRole('tab', { name: '世界观' }));

    expect(await screen.findByLabelText('故事时间线')).toBeInTheDocument();
    expect(screen.getByText('第一天')).toBeInTheDocument();
    expect(screen.getByText('电梯里多出一个人')).toBeInTheDocument();
    expect(screen.getByText('第三天')).toBeInTheDocument();
    expect(screen.getByText('整栋楼停电')).toBeInTheDocument();
    expect(screen.getByText('T4')).toBeInTheDocument();
    expect(screen.getByText('林澈发现地下层')).toBeInTheDocument();
    expect(screen.queryByText('普通说明不应进入时间线')).not.toBeInTheDocument();
  });

  it('notifies the parent when the selected chapter is deleted', async () => {
    const onChapterDeleted = vi.fn();
    const client = makeClient({
      chapters: [{ id: 'ch-1', projectId: 'p-1', title: '第一章', content: '', position: 0 }],
    });
    render(
      <ProjectWorkspaceView
        {...baseProps}
        selectedChapterId="ch-1"
        onSelectChapter={vi.fn()}
        onChapterDeleted={onChapterDeleted}
        client={client}
      />,
    );

    await screen.findByRole('button', { name: '第一章' });
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(client.chapters.remove).toHaveBeenCalledWith('ch-1'));
    expect(onChapterDeleted).toHaveBeenCalledWith('ch-1');
  });

  it('notifies the parent after a chapter is renamed', async () => {
    const onChapterRenamed = vi.fn();
    const onChapterListChanged = vi.fn();
    const client = makeClient({
      chapters: [{ id: 'ch-1', projectId: 'p-1', title: '第一章', content: '', position: 0 }],
    });
    render(
      <ProjectWorkspaceView
        {...baseProps}
        selectedChapterId="ch-1"
        onChapterRenamed={onChapterRenamed}
        onChapterListChanged={onChapterListChanged}
        client={client}
      />,
    );

    await screen.findByRole('button', { name: '第一章' });
    fireEvent.click(screen.getByRole('button', { name: '重命名' }));
    const dialog = screen.getByRole('dialog', { name: '重命名章节' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '新章名' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    const updated = {
      id: 'ch-1',
      title: 'renamed',
      content: '',
      position: 0,
      projectId: 'p-1',
    };
    await waitFor(() => expect(onChapterRenamed).toHaveBeenCalledWith(updated));
    expect(onChapterListChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'renamed' })).toBeInTheDocument();
  });

  it('surfaces backend errors via onError when a list load fails (Requirement 8.6)', async () => {
    const failure = new Error('加载章节失败');
    const client = makeClient({});
    (client.chapters.list as ReturnType<typeof vi.fn>).mockRejectedValue(failure);
    const onError = vi.fn();
    render(
      <ProjectWorkspaceView
        {...baseProps}
        onSelectChapter={vi.fn()}
        onError={onError}
        client={client}
      />,
    );

    await waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
  });
});
