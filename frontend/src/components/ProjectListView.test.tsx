/**
 * Unit tests for {@link ProjectListView} (task 12.8, Requirement 8.1).
 *
 * Covers:
 *  - Rendering the project list and the create-new entry (Requirement 8.1).
 *  - Creating a project submits via the injected client and selects the new id.
 *  - Surfacing backend errors via `onError` (Requirement 8.6).
 *
 * The injectable `client` prop (a `Pick<typeof apiClient, 'projects'>`) is
 * mocked with `vi.fn()` so no real network calls happen.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Id } from '../types/index.js';
import { ProjectListView, type ProjectListViewProps, type ProjectListItem } from './ProjectListView.js';

type Client = NonNullable<ProjectListViewProps['client']>;

function makeClient(overrides: Partial<Client['projects']> = {}): Client {
  return {
    projects: {
      list: vi.fn<() => Promise<ProjectListItem[]>>().mockResolvedValue([]),
      create: vi.fn<(name: string) => Promise<{ id: Id }>>().mockResolvedValue({ id: 'p-new' }),
      rename: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
  } as unknown as Client;
}

describe('ProjectListView', () => {
  it('renders the project list and the create entry (Requirement 8.1)', async () => {
    const client = makeClient({
      list: vi.fn().mockResolvedValue([
        { id: 'p1', name: '我的小说' },
        { id: 'p2', name: '第二本书' },
      ]),
    });

    render(<ProjectListView onSelectProject={vi.fn()} client={client} />);

    // Create entry is present.
    expect(screen.getByLabelText('新项目名称')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();

    // Project list renders after the async load.
    expect(await screen.findByText('我的小说')).toBeInTheDocument();
    expect(screen.getByText('第二本书')).toBeInTheDocument();
  });

  it('shows the empty state when there are no projects', async () => {
    const client = makeClient();
    render(<ProjectListView onSelectProject={vi.fn()} client={client} />);
    expect(await screen.findByText('还没有项目，先创建一个吧。')).toBeInTheDocument();
  });

  it('selecting a project invokes onSelectProject', async () => {
    const onSelectProject = vi.fn();
    const client = makeClient({
      list: vi.fn().mockResolvedValue([{ id: 'p1', name: '我的小说' }]),
    });
    render(<ProjectListView onSelectProject={onSelectProject} client={client} />);

    fireEvent.click(await screen.findByRole('button', { name: '我的小说' }));
    expect(onSelectProject).toHaveBeenCalledWith('p1');
  });

  it('creating a project submits via the client and selects the new project', async () => {
    const onSelectProject = vi.fn();
    const create = vi.fn().mockResolvedValue({ id: 'p-new' });
    const client = makeClient({ create });
    render(<ProjectListView onSelectProject={onSelectProject} client={client} />);

    fireEvent.change(screen.getByLabelText('新项目名称'), { target: { value: '新书' } });
    fireEvent.click(screen.getByRole('button', { name: '新建项目' }));

    await waitFor(() => expect(create).toHaveBeenCalledWith('新书'));
    await waitFor(() => expect(onSelectProject).toHaveBeenCalledWith('p-new'));
    expect(screen.getByText('新书')).toBeInTheDocument();
    expect(client.projects.list).toHaveBeenCalledTimes(1);
  });

  it('surfaces backend errors via onError when the list load fails (Requirement 8.6)', async () => {
    const failure = new Error('加载项目列表失败');
    const client = makeClient({ list: vi.fn().mockRejectedValue(failure) });
    const onError = vi.fn();
    render(<ProjectListView onSelectProject={vi.fn()} onError={onError} client={client} />);

    await waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
  });
});
