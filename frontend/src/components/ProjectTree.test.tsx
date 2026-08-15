import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Chapter } from '../types/index.js';
import { ProjectTree, type ProjectTreeProps } from './ProjectTree.js';

type Client = NonNullable<ProjectTreeProps['client']>;

function makeClient(options: {
  projects?: Array<{ id: string; name: string; kind?: 'novel' | 'short_drama' }>;
  chapters?: Record<string, Chapter[]>;
} = {}): Client {
  return {
    projects: {
      list: vi.fn().mockResolvedValue(options.projects ?? []),
      create: vi.fn().mockResolvedValue({ id: 'p-new' }),
      rename: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    chapters: {
      list: vi.fn((projectId: string) => Promise.resolve(options.chapters?.[projectId] ?? [])),
      create: vi.fn(),
      updateContent: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      reorder: vi.fn(),
    },
  } as unknown as Client;
}

describe('ProjectTree', () => {
  it('creates a project locally without reloading the whole project list', async () => {
    const client = makeClient();
    const onSelectProject = vi.fn();
    render(
      <ProjectTree
        onSelectProject={onSelectProject}
        onSelectChapter={vi.fn()}
        client={client}
      />,
    );

    await waitFor(() => expect(client.projects.list).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('新项目名称'), { target: { value: '新书计划' } });
    fireEvent.keyDown(screen.getByLabelText('新项目名称'), { key: 'Enter' });

    expect(await screen.findByText('新书计划')).toBeInTheDocument();
    expect(client.projects.create).toHaveBeenCalledWith('新书计划', 'novel');
    expect(onSelectProject).toHaveBeenCalledWith('p-new', 'novel');
    expect(client.projects.list).toHaveBeenCalledTimes(1);
  });

  it('creates a short-drama project and selects its dedicated workspace kind', async () => {
    const client = makeClient();
    const onSelectProject = vi.fn();
    render(
      <ProjectTree
        onSelectProject={onSelectProject}
        onSelectChapter={vi.fn()}
        client={client}
      />,
    );

    await waitFor(() => expect(client.projects.list).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('新项目类型'), { target: { value: 'short_drama' } });
    fireEvent.change(screen.getByLabelText('新项目名称'), { target: { value: '竖屏短剧' } });
    fireEvent.click(screen.getByRole('button', { name: '新建' }));

    expect(await screen.findByText('竖屏短剧')).toBeInTheDocument();
    expect(screen.getAllByText('短剧')).toHaveLength(2);
    expect(client.projects.create).toHaveBeenCalledWith('竖屏短剧', 'short_drama');
    expect(onSelectProject).toHaveBeenCalledWith('p-new', 'short_drama');
    expect(client.chapters.list).not.toHaveBeenCalled();
  });

  it('deletes the selected project locally and notifies the parent', async () => {
    const client = makeClient({ projects: [{ id: 'p-1', name: '旧项目' }] });
    const onProjectDeleted = vi.fn();
    render(
      <ProjectTree
        selectedProjectId="p-1"
        onSelectProject={vi.fn()}
        onSelectChapter={vi.fn()}
        onProjectDeleted={onProjectDeleted}
        client={client}
      />,
    );

    expect(await screen.findByText('旧项目')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除 旧项目' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(client.projects.remove).toHaveBeenCalledWith('p-1'));
    expect(onProjectDeleted).toHaveBeenCalledWith('p-1');
    expect(screen.queryByText('旧项目')).not.toBeInTheDocument();
    expect(client.projects.list).toHaveBeenCalledTimes(1);
  });

  it('surfaces a malformed project list without crashing the tree', async () => {
    const client = makeClient();
    vi.mocked(client.projects.list).mockResolvedValue('<!doctype html>' as unknown as []);
    const onError = vi.fn();

    render(
      <ProjectTree
        onSelectProject={vi.fn()}
        onSelectChapter={vi.fn()}
        onError={onError}
        client={client}
      />,
    );

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(screen.getByText('还没有项目')).toBeInTheDocument();
  });
});
