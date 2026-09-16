import { describe, expect, it, vi } from 'vitest';

import { ScriptConceptService } from './ScriptConceptService.js';
import { ProxyError } from '../../../proxy/ProxyError.js';

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

  it('keeps model-authored story fields and fills only optional fields locally', async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({
      proposals: [{
        title: '只返回一个也能用',
        story: '会计为找回失踪账本潜入旧公司，却发现母亲也是嫌疑人。',
        conflict: '她必须在账本销毁前公开证据并承担亲情破裂的代价',
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
      theme: '只返回一个也能用',
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

  it('repairs JSON syntax without fabricating missing story content', async () => {
    const complete = vi.fn().mockResolvedValue(`\`\`\`json\n{"concepts":[${JSON.stringify(candidate(1))},],}\n\`\`\``);
    const service = new ScriptConceptService({ complete }, async () => project);
    await expect(service.generate('project-1')).resolves.toMatchObject({ proposals: [{ title: '原创选题1' }] });
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

  it.each(['', '模型暂时没有生成 JSON', '{}', '{"message":"ok"}', '{"proposals":[]}', '{"proposals":[{"title":"只有标题"}]}'])('rejects unusable output after one fixup: %j', async (raw) => {
    const complete = vi.fn().mockResolvedValue(raw);
    const service = new ScriptConceptService({ complete }, async () => project);

    await expect(service.generate('project-1', '修车佬复出')).rejects.toMatchObject({
      code: 'SCRIPT_MODEL_OUTPUT_INVALID',
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('exposes a safe failure after a failed call and honors cancellation', async () => {
    const failedComplete = vi.fn().mockRejectedValue(new Error('provider timeout Authorization: Bearer private-secret'));
    const service = new ScriptConceptService({ complete: failedComplete }, async () => project);

    await expect(service.generate('project-1', '遗嘱疑云')).rejects.toThrow('AI 选题未生成有效故事方案');
    expect(failedComplete).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort();
    const abortedComplete = vi.fn().mockRejectedValue(new Error('cancelled'));
    const abortedService = new ScriptConceptService({ complete: abortedComplete }, async () => project);
    await expect(abortedService.generate('project-1', '', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedComplete).not.toHaveBeenCalled();
  });

  it('preserves sanitized provider reasons while hiding unknown errors', async () => {
    const known = new ScriptConceptService({
      complete: vi.fn().mockRejectedValue(new ProxyError('模型不存在 model_not_found Bearer reflected-secret', { status: 404 })),
    }, async () => project);
    const knownError = await known.generate('project-1').catch((error: Error) => error);
    expect(knownError).toBeInstanceOf(Error);
    expect((knownError as Error).message).toContain('model_not_found');
    expect((knownError as Error).message).not.toContain('reflected-secret');
    const unknown = new ScriptConceptService({ complete: vi.fn().mockRejectedValue(new Error('private internal diagnostic')) }, async () => project);
    const unknownError = await unknown.generate('project-1').catch((error: Error) => error);
    expect((unknownError as Error).message).not.toContain('private internal diagnostic');
  });

  it('recovers once through fixup and uses only an explicitly configured fallback', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce('not json')
      .mockResolvedValueOnce(JSON.stringify({ concepts: [candidate(1)] }));
    const service = new ScriptConceptService({
      complete, getStructuredFallbackModelName: async () => 'repair-model',
    }, async () => project);
    await expect(service.generate('project-1')).resolves.toMatchObject({ proposals: [{ title: '原创选题1' }] });
    expect(complete).toHaveBeenCalledTimes(3);
    expect(complete.mock.calls[2]?.[0]).toMatchObject({ modelNameOverride: 'repair-model' });
  });

  it('rejects a response which echoes serialized draft context into story fields', async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({ proposals: [{
      ...candidate(1), logline: '当前草稿：{"title":"旧标题"}',
    }] }));
    const service = new ScriptConceptService({ complete }, async () => project);
    await expect(service.generate('project-1')).rejects.toThrow('未生成有效故事方案');
    expect(complete).toHaveBeenCalledTimes(2);
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
