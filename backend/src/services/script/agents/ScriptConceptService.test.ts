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
  it('returns exactly three validated and distinct proposals', async () => {
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

  it('rejects duplicate or malformed proposals and non-script projects', async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({
      proposals: [candidate(1), candidate(1), candidate(3)],
    }));
    const service = new ScriptConceptService({ complete }, async () => project);
    await expect(service.generate('project-1')).rejects.toThrow('标题不能重复');

    const novelService = new ScriptConceptService({ complete }, async () => ({ ...project, kind: 'novel' }));
    await expect(novelService.generate('project-1')).rejects.toThrow('只能用于 short_drama');
  });

  it.each([
    ['logline', '一句话故事'],
    ['coreConflict', '核心冲突'],
    ['mainArc', '主线'],
  ] as const)('rejects normalized duplicate %s values', async (field, label) => {
    const proposals = [candidate(1), candidate(2), candidate(3)];
    proposals[1]![field] = ` ${proposals[0]![field]}！ `;
    const complete = vi.fn().mockResolvedValue(JSON.stringify({ proposals }));
    const service = new ScriptConceptService({ complete }, async () => project);

    await expect(service.generate('project-1')).rejects.toThrow(label);
  });
});
