import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ScriptEpisode, ScriptEpisodeSummary } from '../../types/index.js';
import {
  buildScriptBatchNavigation,
  ScriptEpisodeReader,
  ScriptProductionSidebar,
} from './ScriptProductViews.js';

function episodeSummary(episodeNumber: number, status: ScriptEpisodeSummary['status']): ScriptEpisodeSummary {
  return {
    id: `episode-${episodeNumber}`,
    episodeNumber,
    title: `标题 ${episodeNumber}`,
    status,
    targetChars: 1200,
    visibleChars: 1000,
    sceneCount: 1,
    revision: 1,
    updatedAt: '2026-08-15T00:00:00.000Z',
  };
}

describe('short drama product views', () => {
  it('builds fixed five-episode batches with truthful state and totals', () => {
    const batches = buildScriptBatchNavigation(
      12,
      [1, 2, 3, 4, 5].map((episode) => episodeSummary(episode, 'completed')),
      [{
        id: 'job-2', projectId: 'project-1', task: 'script_episode_batch', status: 'running', continuable: false,
        scriptBatchOptions: { startEpisode: 6, episodeCount: 5, expectedPlanRevision: 2 },
      }],
      true,
    );

    expect(batches).toEqual([
      expect.objectContaining({ startEpisode: 1, endEpisode: 5, status: 'completed', completedEpisodes: 5, visibleChars: 5000 }),
      expect.objectContaining({ startEpisode: 6, endEpisode: 10, status: 'generating' }),
      expect.objectContaining({ startEpisode: 11, endEpisode: 12, status: 'ready' }),
    ]);
  });

  it('exposes the product directory and selects a dynamic batch', () => {
    const onBatchChange = vi.fn();
    render(<ScriptProductionSidebar
      title="夜班真相"
      activeStage="plan"
      activeBatchStart={1}
      totalEpisodes={12}
      completedEpisodes={5}
      totalVisibleChars={5000}
      batches={buildScriptBatchNavigation(12, [1, 2, 3, 4, 5].map((episode) => episodeSummary(episode, 'completed')), [], true)}
      onStageChange={vi.fn()}
      onBatchChange={onBatchChange}
    />);

    expect(screen.getByText('已完成：5集/12集')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /11–12集剧本正文/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /6–10集剧本正文/ }));
    expect(onBatchChange).toHaveBeenCalledWith(6);
  });

  it('renders structured blocks as standard Chinese short-drama script', () => {
    const episode: ScriptEpisode = {
      id: 'episode-1', projectId: 'project-1', episodeNumber: 1, title: '夜班真相', outlineId: 'outline-1',
      status: 'completed', targetChars: 1200, summary: '', newFacts: [], openedThreads: [], closedThreads: [], revision: 3,
      createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
      scenes: [{
        id: 'scene-1', ordinal: 1, location: '便利店', timeOfDay: 'night', interiorExterior: 'interior', characterIds: ['character-1'],
        blocks: [
          { id: 'caption-1', type: 'caption', text: '凌晨两点' },
          { id: 'action-1', type: 'action', text: '【特写】林晓攥紧账本。' },
          { id: 'dialogue-1', type: 'dialogue', characterId: 'character-1', speaker: '林晓', mode: 'os', text: '证据终于齐了。' },
        ],
      }],
    };
    const { container } = render(<ScriptEpisodeReader
      episodes={[episode]}
      summaries={[episodeSummary(1, 'completed')]}
      characters={[{
        id: 'character-1', projectId: 'project-1', name: '林晓', aliases: [], role: 'lead', identity: '夜班店员', biography: '',
        motivation: '', goal: '', weakness: '', arc: '', appearance: '', hairstyle: '', physique: '', defaultOutfit: '',
        personality: [], skills: [], speechStyle: '', catchphrases: [], relationships: [], revision: 1,
        updatedAt: '2026-08-15T00:00:00.000Z',
      }]}
      batchStart={1}
      batchEnd={5}
      loading={false}
      onEditEpisode={vi.fn()}
    />);

    expect(screen.getByText('1-1 夜 内 便利店')).toBeInTheDocument();
    expect(container.querySelector('.script-reader-characters')).toHaveTextContent('人物：林晓（夜班店员）');
    expect(screen.getByText('【字幕：凌晨两点】')).toBeInTheDocument();
    expect(container.querySelector('.is-action')).toHaveTextContent('△【特写】林晓攥紧账本。');
    expect([...container.querySelectorAll('.is-action strong')].map((item) => item.textContent)).toEqual(['【特写】', '林晓']);
    expect(container.querySelector('.is-dialogue')).toHaveTextContent('林晓OS：证据终于齐了。');
  });

  it('uses serializer-equivalent time labels and scene ordinal ordering', () => {
    const episode: ScriptEpisode = {
      id: 'episode-2', projectId: 'project-1', episodeNumber: 2, title: '清晨反转', outlineId: 'outline-2',
      status: 'completed', targetChars: 1200, summary: '', newFacts: [], openedThreads: [], closedThreads: [], revision: 1,
      createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
      scenes: [
        { id: 'scene-2', ordinal: 2, location: '天台', timeOfDay: 'dusk', interiorExterior: 'exterior', characterIds: [], blocks: [{ id: 'action-2', type: 'action', text: '夕阳落下。' }] },
        { id: 'scene-1', ordinal: 1, location: '厨房', timeOfDay: 'dawn', interiorExterior: 'interior', characterIds: [], blocks: [{ id: 'action-1', type: 'action', text: '晨光亮起。' }] },
      ],
    };

    render(<ScriptEpisodeReader
      episodes={[episode]}
      summaries={[episodeSummary(2, 'completed')]}
      characters={[]}
      batchStart={1}
      batchEnd={5}
      loading={false}
      onEditEpisode={vi.fn()}
    />);

    const headings = screen.getAllByRole('heading', { level: 5 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['2-1 晨 内 厨房', '2-2 黄昏 外 天台']);
  });
});
