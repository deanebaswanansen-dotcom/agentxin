/**
 * Unit tests for {@link ReportView} (task 12.5, Requirement 14.4).
 *
 * Covers Requirement 14.4 — given a `wordCountReport` / `pacingReport` prop the
 * view renders each field (per-scene target/actual/expansion suggestion; plot
 * point status; violated forbidden points; per-scene pacing issue + priority),
 * and the "字数检查" / "节奏检查" buttons invoke
 * `client.blueprint.wordCount.run` / `client.blueprint.pacing.run`.
 *
 * The injected client is the minimal `Pick<typeof apiClient, 'blueprint'>`
 * subset; methods are `vi.fn()`. Interaction uses `fireEvent`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { PacingReport, WordCountReport } from '../types/index.js';
import { ReportView, type ReportClient } from './ReportView.js';

function makeClient(overrides: Partial<ReportClient['blueprint']> = {}): ReportClient {
  return {
    blueprint: {
      get: vi.fn(),
      generate: vi.fn(),
      merge: vi.fn(),
      wordCount: { run: vi.fn(), get: vi.fn() },
      pacing: { run: vi.fn(), get: vi.fn() },
      writeScene: vi.fn(),
      expandScene: vi.fn(),
      rewriteScene: vi.fn(),
      assembleChapter: vi.fn(),
      ...overrides,
    },
  } as unknown as ReportClient;
}

const wordCountReport: WordCountReport = {
  chapterId: 'ch-1',
  chapterTargetWords: 6000,
  chapterActualWords: 4200,
  chapterDelta: -1800,
  generatedAt: '2024-01-01T00:00:00.000Z',
  scenes: [
    {
      sceneId: 'scene-1',
      targetWords: 3000,
      actualWords: 1500,
      delta: -1500,
      needsExpansion: true,
      suggestedExpansion: 1500,
    },
    {
      sceneId: 'scene-2',
      targetWords: 3000,
      actualWords: 2700,
      delta: -300,
      needsExpansion: false,
      suggestedExpansion: 0,
    },
  ],
};

const pacingReport: PacingReport = {
  chapterId: 'ch-1',
  generatedAt: '2024-01-01T00:00:00.000Z',
  plotPoints: [
    { point: '主角觉醒', status: 'completed' },
    { point: '反派登场', status: 'partial' },
    { point: '埋下伏笔', status: 'missing' },
  ],
  violatedForbiddenPoints: ['提前揭示结局'],
  sceneIssues: [
    {
      sceneId: 'scene-1',
      issue: '节奏过缓',
      suggestion: '删减环境描写',
      priority: 'high',
    },
  ],
};

describe('ReportView', () => {
  it('renders word-count report fields (scene target/actual + expansion suggestion) (Requirement 14.4)', () => {
    const scenes = [
      { sceneId: 'scene-1', name: '主角觉醒' },
      { sceneId: 'scene-2', name: '反派登场' },
    ];
    render(<ReportView chapterId="ch-1" wordCountReport={wordCountReport} scenes={scenes} client={makeClient()} />);

    // Chapter-level summary.
    expect(screen.getByLabelText('字数报告内容')).toBeInTheDocument();
    expect(screen.getByLabelText('字数目标实际图表')).toBeInTheDocument();
    expect(screen.getByText(/整章：目标 6000 字 \/ 实际 4200 字 \/ 差值 -1800 字/)).toBeInTheDocument();

    // Per-scene rows now use human-readable names (NEW-08).
    expect(screen.getAllByText('主角觉醒').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/目标 3000 \/ 实际 1500 \/ 差值 -1500/)).toBeInTheDocument();
    // Expansion suggestion shown only for the under-target scene.
    expect(screen.getByText('建议扩写约 1500 字。')).toBeInTheDocument();

    expect(screen.getAllByText('反派登场').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/目标 3000 \/ 实际 2700 \/ 差值 -300/)).toBeInTheDocument();
  });

  it('renders pacing report fields (plot point status / violated forbidden / scene issue + priority) (Requirement 14.4)', () => {
    const scenes = [{ sceneId: 'scene-1', name: '开场场景' }];
    render(<ReportView chapterId="ch-1" pacingReport={pacingReport} scenes={scenes} client={makeClient()} />);

    expect(screen.getByLabelText('节奏报告内容')).toBeInTheDocument();
    expect(screen.getByLabelText('剧情点完成分布图')).toBeInTheDocument();

    // Plot point statuses.
    expect(screen.getByText('主角觉醒')).toBeInTheDocument();
    expect(screen.getAllByText('已完成').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('反派登场')).toBeInTheDocument();
    expect(screen.getAllByText('部分完成').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('埋下伏笔')).toBeInTheDocument();
    expect(screen.getAllByText('未完成').length).toBeGreaterThanOrEqual(2);

    // Violated forbidden point.
    expect(screen.getByText('提前揭示结局')).toBeInTheDocument();

    // Per-scene pacing issue with priority. Now shows name (NEW-08).
    expect(screen.getByText('开场场景')).toBeInTheDocument();
    expect(screen.getByText('节奏过缓')).toBeInTheDocument();
    expect(screen.getByText('删减环境描写')).toBeInTheDocument();
    expect(screen.getByText(/优先级：高/)).toBeInTheDocument();
  });

  it('invokes blueprint.wordCount.run when 字数检查 is clicked (Requirement 14.4)', async () => {
    const run = vi.fn().mockResolvedValue(wordCountReport);
    const onWordCountReport = vi.fn();
    const client = makeClient({ wordCount: { run, get: vi.fn() } });
    render(
      <ReportView chapterId="ch-1" onWordCountReport={onWordCountReport} client={client} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '字数检查' }));

    await waitFor(() => expect(run).toHaveBeenCalledWith('ch-1'));
    await waitFor(() => expect(onWordCountReport).toHaveBeenCalledWith(wordCountReport));
  });

  it('invokes blueprint.pacing.run when 节奏检查 is clicked (Requirement 14.4)', async () => {
    const run = vi.fn().mockResolvedValue(pacingReport);
    const onPacingReport = vi.fn();
    const client = makeClient({ pacing: { run, get: vi.fn() } });
    render(<ReportView chapterId="ch-1" onPacingReport={onPacingReport} client={client} />);

    fireEvent.click(screen.getByRole('button', { name: '节奏检查' }));

    await waitFor(() => expect(run).toHaveBeenCalledWith('ch-1'));
    await waitFor(() => expect(onPacingReport).toHaveBeenCalledWith(pacingReport));
  });
});
