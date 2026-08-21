import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chapter } from '../types/index.js';
import { ReaderWorkspace, sanitizeReaderInlineHtml, type ReaderClient } from './ReaderWorkspace.js';

function chapter(overrides: Partial<Chapter>): Chapter {
  return {
    id: 'c-1',
    projectId: 'p-1',
    title: '章节',
    content: '正文',
    position: 0,
    ...overrides,
  };
}

function makeClient(overrides: Partial<ReaderClient> = {}): ReaderClient {
  return {
    chapters: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      updateContent: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn(),
      remove: vi.fn(),
      reorder: vi.fn(),
    },
    projects: {
      list: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'created-project' }),
      rename: vi.fn(),
      remove: vi.fn(),
    },
    settings: {
      characters: {
        list: vi.fn(),
        create: vi.fn().mockResolvedValue({ id: 'char-1' }),
        update: vi.fn(),
        remove: vi.fn(),
      },
      worldSettings: {
        list: vi.fn(),
        create: vi.fn().mockResolvedValue({ id: 'world-1' }),
        update: vi.fn(),
        remove: vi.fn(),
      },
      outlines: {
        list: vi.fn(),
        create: vi.fn().mockResolvedValue({ id: 'outline-1' }),
        update: vi.fn(),
        remove: vi.fn(),
      },
    },
    freeChat: {
      stream: vi.fn(async (_projectId, _body, options) => {
        options?.onDelta?.('改写后的文字');
        return '改写后的文字';
      }),
    },
    ...overrides,
  } as ReaderClient;
}

function selectText(text: string, length: number): void {
  const node = screen.getByText(text).firstChild;
  expect(node).toBeTruthy();
  const range = document.createRange();
  range.setStart(node!, 0);
  range.setEnd(node!, length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent.mouseUp(screen.getByText(text));
}

describe('ReaderWorkspace', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('opens the current Agent project as a readable book', async () => {
    const client = makeClient({
      chapters: {
        ...makeClient().chapters,
        list: vi.fn().mockResolvedValue([
          chapter({ id: 'c-2', title: '第二章', content: '乙乙', position: 1 }),
          chapter({ id: 'c-1', title: '第一章', content: '甲甲甲', position: 0 }),
        ]),
      },
    });

    render(
      <ReaderWorkspace
        projectId="p-1"
        projectName="测试项目"
        onOpenAgentMode={vi.fn()}
        client={client}
      />,
    );

    await waitFor(() => expect(screen.getByText('测试项目')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(screen.getByRole('heading', { name: '测试项目' })).toBeInTheDocument();
    expect(screen.getByLabelText('全书统计')).toHaveTextContent('2 章');
    expect(screen.getAllByText('第一章').length).toBeGreaterThan(0);
    expect(screen.getByText('甲甲甲')).toBeInTheDocument();
  });

  it('imports a text file into the shelf and opens it', async () => {
    const client = makeClient();
    render(
      <ReaderWorkspace
        projectId={null}
        onOpenAgentMode={vi.fn()}
        client={client}
      />,
    );

    const input = document.body.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['第1章 导入\n\n导入正文'], '导入书.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getAllByText('第1章 导入').length).toBeGreaterThan(0));
    expect(screen.getByText('导入正文')).toBeInTheDocument();
  });

  it('imports directory files and exposes the folder category', async () => {
    const client = makeClient();
    render(
      <ReaderWorkspace
        projectId={null}
        onOpenAgentMode={vi.fn()}
        client={client}
      />,
    );

    const inputs = document.body.querySelectorAll('input[type="file"]');
    const folderInput = inputs[1] as HTMLInputElement;
    const file = new File(['第1章 扫描\n\n扫描正文'], '扫描书.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'webkitRelativePath', {
      configurable: true,
      value: '测试目录/扫描书.txt',
    });
    fireEvent.change(folderInput, { target: { files: [file] } });

    await waitFor(() => expect(screen.getAllByText('第1章 扫描').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: '书架' }));
    fireEvent.click(screen.getByRole('button', { name: /文件夹扫描/ }));
    expect(screen.getByText('测试目录/扫描书.txt')).toBeInTheDocument();
  });

  it('imports image folders as a continuous comic reader', async () => {
    const client = makeClient();
    render(
      <ReaderWorkspace
        projectId={null}
        onOpenAgentMode={vi.fn()}
        client={client}
      />,
    );

    const inputs = document.body.querySelectorAll('input[type="file"]');
    const folderInput = inputs[1] as HTMLInputElement;
    const first = new File([new Uint8Array([1, 2, 3])], '001.png', { type: 'image/png' });
    const second = new File([new Uint8Array([4, 5, 6])], '002.png', { type: 'image/png' });
    Object.defineProperty(first, 'webkitRelativePath', { configurable: true, value: '漫画/001.png' });
    Object.defineProperty(second, 'webkitRelativePath', { configurable: true, value: '漫画/002.png' });
    fireEvent.change(folderInput, { target: { files: [second, first] } });

    await waitFor(() => expect(screen.getByAltText('漫画/001.png')).toBeInTheDocument());
    expect(screen.getByAltText('漫画/002.png')).toBeInTheDocument();
    expect(screen.getByLabelText('全书统计')).toHaveTextContent('IMAGES · 2 页');
  });

  it('keeps the current project category separate from imported books', async () => {
    const client = makeClient({
      chapters: {
        ...makeClient().chapters,
        list: vi.fn().mockResolvedValue([
          chapter({ id: 'c-1', title: '项目章', content: '项目正文', position: 0 }),
        ]),
      },
    });
    render(
      <ReaderWorkspace
        projectId="p-1"
        projectName="测试项目"
        onOpenAgentMode={vi.fn()}
        client={client}
      />,
    );

    await waitFor(() => expect(screen.getByText('测试项目')).toBeInTheDocument());
    const input = document.body.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['第1章 导入\n\n导入正文'], '导入书.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getAllByText('第1章 导入').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: '书架' }));
    fireEvent.click(screen.getByRole('button', { name: /当前项目/ }));
    const library = within(screen.getByLabelText('书籍列表'));
    expect(library.getByText('测试项目')).toBeInTheDocument();
    expect(library.queryByText('第1章 导入')).not.toBeInTheDocument();
  });

  it('rewrites a selected segment and applies it to a project chapter', async () => {
    const client = makeClient({
      chapters: {
        ...makeClient().chapters,
        list: vi.fn().mockResolvedValue([
          chapter({ id: 'c-1', title: '第一章', content: '原文需要修改。保留。', position: 0 }),
        ]),
        updateContent: vi.fn().mockResolvedValue(undefined),
      },
    });

    render(
      <ReaderWorkspace
        projectId="p-1"
        projectName="测试项目"
        onOpenAgentMode={vi.fn()}
        client={client}
      />,
    );

    await waitFor(() => expect(screen.getByText('测试项目')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    selectText('原文需要修改。保留。', 6);
    fireEvent.click(screen.getByRole('tab', { name: 'Agent' }));
    await waitFor(() => expect(screen.getByText('原文需要修改')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '重写选段' }));
    await waitFor(() => expect(screen.getByText('改写后的文字')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '应用改写' }));

    await waitFor(() => {
      expect(client.chapters.updateContent).toHaveBeenCalledWith('c-1', '改写后的文字。保留。');
    });
    expect(screen.getByText('改写后的文字。保留。')).toBeInTheDocument();
  });

  it('extracts reading notes into project resources', async () => {
    const client = makeClient({
      chapters: {
        ...makeClient().chapters,
        list: vi.fn().mockResolvedValue([
          chapter({ id: 'c-1', title: '第一章', content: '林默说这里有灵脉规则。', position: 0 }),
        ]),
      },
    });

    render(
      <ReaderWorkspace
        projectId="p-1"
        projectName="测试项目"
        onOpenAgentMode={vi.fn()}
        client={client}
      />,
    );

    await waitFor(() => expect(screen.getByText('测试项目')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Agent' }));
    fireEvent.click(screen.getByRole('button', { name: '提取世界观' }));
    await waitFor(() => {
      expect(client.settings.worldSettings.create).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('button', { name: '提取大纲' }));
    await waitFor(() => {
      expect(client.settings.outlines.create).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('button', { name: '提取人物' }));

    await waitFor(() => {
      expect(client.settings.characters.create).toHaveBeenCalled();
    });
  });

  it('keeps raster data URLs and strips SVG or scripted HTML', () => {
    const png = 'data:image/png;base64,QQ==';
    expect(sanitizeReaderInlineHtml(`<figure class="nwa-reader-inline-image"><img src="${png}" alt="ok" onerror="alert(1)"></figure>`))
      .toContain(png);
    expect(sanitizeReaderInlineHtml('<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+" alt="x">'))
      .not.toContain('svg');
    expect(sanitizeReaderInlineHtml('<img src="javascript:alert(1)"><script>window.bad=1</script>'))
      .not.toContain('javascript');
  });
});
