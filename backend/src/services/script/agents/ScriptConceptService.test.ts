import { describe, expect, it, vi } from 'vitest';

import { ScriptConceptService } from './ScriptConceptService.js';

const project = {
  id: 'project-1',
  name: '短剧',
  kind: 'short_drama' as const,
  createdAt: '2026-08-15T00:00:00.000Z',
  updatedAt: '2026-08-15T00:00:00.000Z',
};

function candidate(index: number) {
  return {
    title: `原创选题${index}`,
    theme: '打破控制',
    market: 'domestic',
    channel: index === 2 ? 'male' : 'female',
    genres: ['都市', '逆袭'],
    logline: `主角${index}在一夜之间识破骗局并承担反击代价。`,
    audience: '喜欢强冲突与连续反转的短剧观众',
    coreConflict: `主角${index}必须在证据消失前揭穿对手`,
    highlights: ['证据反转', '当众翻盘'],
    mainArc: `主角${index}受压迫、找到证据、遭遇反扑并完成公开翻盘。`,
    endingDirection: '秩序重建并留下新悬念',
    coverPrompt: '9:16 竖版海报，主角站在高反差光影中央。',
    totalEpisodes: 60,
  };
}

describe('ScriptConceptService', () => {
  it('returns up to three complete proposals from a complete model response', async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({
      proposals: [candidate(1), candidate(2), candidate(3)],
    }));
    const service = new ScriptConceptService({ complete }, async () => project);

    const result = await service.generate('project-1', '家庭情绪勒索');

    expect(result.proposals).toHaveLength(3);
    expect(result.proposals[0]).toMatchObject({ title: '原创选题1', totalEpisodes: 60 });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      node: 'plan', projectId: 'project-1', prompt: expect.stringContaining('家庭情绪勒索'),
    }));
  });

  it('salvages one partial proposal and fills missing fields locally', async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({
      proposals: [{
        title: '只返回一个也能用',
        market: '国内',
        channel: '女频',
        genres: '都市、悬疑',
        highlights: '身份反转，绝地翻盘',
        totalEpisodes: '88集',
      }],
    }));
    const service = new ScriptConceptService({ complete }, async () => project);

    const result = await service.generate('project-1', '失踪的账本');

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      title: '只返回一个也能用',
      theme: '失踪的账本',
      market: 'domestic',
      channel: 'female',
      genres: ['都市', '悬疑'],
      highlights: ['身份反转', '绝地翻盘'],
      totalEpisodes: 88,
    });
    expect(result.proposals[0]?.logline).toBeTruthy();
    expect(result.proposals[0]?.mainArc).toBeTruthy();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('drops duplicate and unusable entries instead of rejecting the usable proposal', async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({
      proposals: [candidate(1), {}, { ...candidate(1), title: ' 原创选题1！ ' }, candidate(2)],
    }));
    const service = new ScriptConceptService({ complete }, async () => project);

    const result = await service.generate('project-1');

    expect(result.proposals.map((item) => item.title)).toEqual(['原创选题1', '原创选题2']);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each(['', '模型暂时没有生成 JSON', '{"proposals":[]}'])('uses deterministic local proposals for empty or unusable output: %j', async (raw) => {
    const complete = vi.fn().mockResolvedValue(raw);
    const service = new ScriptConceptService({ complete }, async () => project);

    const result = await service.generate('project-1', '修车佬复出');

    expect(result.proposals).toHaveLength(3);
    expect(result.proposals[0]).toMatchObject({
      title: '修车佬复出：绝境反击',
      theme: '修车佬复出',
      totalEpisodes: 60,
    });
    expect(new Set(result.proposals.map((item) => item.title))).toHaveProperty('size', 3);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('falls back locally after one failed model call but still honors user cancellation', async () => {
    const failedComplete = vi.fn().mockRejectedValue(new Error('provider timeout'));
    const service = new ScriptConceptService({ complete: failedComplete }, async () => project);

    const fallback = await service.generate('project-1', '遗嘱疑云');
    expect(fallback.proposals).toHaveLength(3);
    expect(fallback.proposals[0]?.title).toBe('遗嘱疑云：绝境反击');
    expect(failedComplete).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort();
    const abortedComplete = vi.fn().mockRejectedValue(new Error('cancelled'));
    const abortedService = new ScriptConceptService({ complete: abortedComplete }, async () => project);
    await expect(abortedService.generate('project-1', '', controller.signal)).rejects.toThrow('cancelled');
    expect(abortedComplete).toHaveBeenCalledTimes(1);
  });

  it('keeps project and input validation as hard data-integrity floors', async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({ proposals: [candidate(1)] }));

    const novelService = new ScriptConceptService({ complete }, async () => ({ ...project, kind: 'novel' }));
    await expect(novelService.generate('project-1')).rejects.toThrow('只能用于 short_drama');
    const service = new ScriptConceptService({ complete }, async () => project);
    await expect(service.generate('project-1', 'x'.repeat(20_001))).rejects.toThrow('不能超过 20000');
    expect(complete).not.toHaveBeenCalled();
  });
});
