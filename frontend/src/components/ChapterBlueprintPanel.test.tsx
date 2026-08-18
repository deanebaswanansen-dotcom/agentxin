/**
 * Unit tests for {@link ChapterBlueprintPanel} (task 12.5, Requirements 14.1,
 * 14.6, 14.7).
 *
 * Covers:
 *  - empty blueprint state appears after automatic load returns NOT_FOUND
 *    (Requirement 14.7).
 *  - automatic load of an existing blueprint renders the chapter-level field
 *    summary and the scene list (Requirement 14.1).
 *  - failed automatic blueprint request surfaces it via `onError`
 *    (Requirement 14.6).
 *
 * The injected client satisfies the `Pick<typeof apiClient, 'blueprint'>` subset
 * the panel consumes; each method is a `vi.fn()` so no real network happens.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ApiClientError } from '../api/apiClient.js';
import type { ChapterBlueprint } from '../types/index.js';
import {
  ChapterBlueprintPanel,
  type BlueprintPanelClient,
} from './ChapterBlueprintPanel.js';

function makeBlueprint(overrides: Partial<ChapterBlueprint> = {}): ChapterBlueprint {
  return {
    chapter_id: 'ch-1',
    title: '风起云涌',
    target_words: 6000,
    main_goal: '主角觉醒异能',
    tone: '热血',
    pacing: '渐进加速',
    required_plot_points: ['觉醒', '初战'],
    forbidden_points: ['提前暴露反派身份'],
    emotional_curve: '低落→振奋',
    ending_hook: '神秘人现身',
    scenes: [
      {
        scene_id: 'scene-1',
        name: '危机降临',
        target_words: 3000,
        location: '荒野',
        characters: ['林动'],
        purpose: '建立危机',
        emotion: '紧张',
        pacing: '快',
        must_include: ['遭遇袭击'],
        ending_state: '陷入绝境',
      },
      {
        scene_id: 'scene-2',
        name: '绝地反击',
        target_words: 3000,
        location: '荒野',
        characters: ['林动'],
        purpose: '觉醒异能',
        emotion: '振奋',
        pacing: '高潮',
        must_include: ['觉醒'],
        ending_state: '击退强敌',
      },
    ],
    ...overrides,
  };
}

/** Build the minimal blueprint-client subset the panel + children consume. */
function makeClient(
  overrides: Partial<BlueprintPanelClient['blueprint']> = {},
): BlueprintPanelClient {
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
  } as unknown as BlueprintPanelClient;
}

function notFoundError(): ApiClientError {
  return new ApiClientError({ error: { code: 'NOT_FOUND', message: '尚无蓝图' } }, 404);
}

describe('ChapterBlueprintPanel', () => {
  it('renders the empty state + BlueprintForm after automatic NOT_FOUND load (Requirement 14.7)', async () => {
    const client = makeClient({ get: vi.fn().mockRejectedValue(notFoundError()) });
    const onError = vi.fn();
    render(<ChapterBlueprintPanel chapterId="ch-1" onError={onError} client={client} />);

    expect(await screen.findByText('该章节尚无蓝图，请先生成章节蓝图。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '加载已有蓝图' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成蓝图' })).toBeInTheDocument();
    expect(screen.getByLabelText('章节需求')).toBeInTheDocument();
    expect(client.blueprint.get).toHaveBeenCalledWith('ch-1', undefined);
    expect(onError).not.toHaveBeenCalled();
  });

  it('treats any HTTP 404 blueprint response as an empty state', async () => {
    const missing = new ApiClientError(
      { error: { code: 'STORE_ERROR', message: 'blueprint missing' } },
      404,
    );
    const client = makeClient({ get: vi.fn().mockRejectedValue(missing) });
    const onError = vi.fn();

    render(<ChapterBlueprintPanel chapterId="ch-1" onError={onError} client={client} />);

    expect(await screen.findByText('该章节尚无蓝图，请先生成章节蓝图。')).toBeInTheDocument();
    expect(screen.queryByText('加载中…')).not.toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();
  });

  it('renders the chapter field summary and scene list after automatic load (Requirement 14.1)', async () => {
    const blueprint = makeBlueprint();
    const client = makeClient({ get: vi.fn().mockResolvedValue(blueprint) });
    render(<ChapterBlueprintPanel chapterId="ch-1" client={client} />);

    expect(await screen.findByText('风起云涌')).toBeInTheDocument();
    expect(screen.getByLabelText('章节蓝图摘要')).toBeInTheDocument();
    expect(screen.getByText('主角觉醒异能')).toBeInTheDocument();

    expect(screen.getByLabelText('场景列表')).toBeInTheDocument();
    expect(screen.getByText('场景（2）')).toBeInTheDocument();
    expect(screen.getByText('危机降临')).toBeInTheDocument();
    expect(screen.getByText('绝地反击')).toBeInTheDocument();

    expect(client.blueprint.get).toHaveBeenCalledWith('ch-1', undefined);
  });

  it('surfaces non-NOT_FOUND errors via onError (Requirement 14.6)', async () => {
    const failure = new ApiClientError(
      { error: { code: 'STORE_ERROR', message: '存储读取失败' } },
      500,
    );
    const client = makeClient({ get: vi.fn().mockRejectedValue(failure) });
    const onError = vi.fn();
    render(<ChapterBlueprintPanel chapterId="ch-1" onError={onError} client={client} />);

    await waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    expect(
      screen.queryByText('该章节尚无蓝图，请先生成章节蓝图。'),
    ).not.toBeInTheDocument();
  });
});
