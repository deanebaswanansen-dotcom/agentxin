import { describe, expect, it } from 'vitest';

import type { ModelProxy } from '../../../proxy/ModelProxy.js';
import type { StreamDelta } from '../../../proxy/sseParser.js';
import type { ModelConfig } from '../../../types/index.js';
import { ContinuityInspectorSubAgent } from './ContinuityInspectorSubAgent.js';

function mockProxy(response: string): ModelProxy {
  return {
    async *streamCompletion(): AsyncIterable<StreamDelta> {
      yield { kind: 'content', text: response };
    },
  };
}

const CONFIG: ModelConfig = {
  baseUrl: 'mock',
  apiKey: 'k',
  modelName: 'mock-model',
};

describe('ContinuityInspectorSubAgent', () => {
  it('parses inspector JSON and flags revision when score is low', async () => {
    const agent = new ContinuityInspectorSubAgent(
      mockProxy(
        JSON.stringify({
          score0to100: 55,
          verdict: 'needs_revision',
          plotCoherence: '碎片化',
          fatalIssues: ['主角性别被改写'],
          earlyCharacterStatus: [{ id: 'hero', consistent: false, note: '姓名不一致' }],
          recommendRevision: true,
          revisionHints: ['恢复沈砚秋女主设定'],
        }),
      ),
    );
    const report = await agent.inspectChapter(
      CONFIG,
      {
        projectId: 'p1',
        atChapter: 12,
        chapterTitle: '第12章',
        chapterContent: '沈砚秋在雨中奔跑。',
        canonLocks: [{ id: 'hero', keyword: '沈砚秋', introducedBy: 1, rule: '女主' }],
        earlyChapterSamples: [{ title: '第1章', excerpt: '沈砚秋醒来' }],
        recentChapterSamples: [{ title: '第11章', excerpt: '沈砚秋' }],
        injectedMemory: '沈砚秋是女主',
        injectedMemoryOptions: { maxSummaries: 8 },
      },
      new AbortController().signal,
    );
    expect(report.score0to100).toBe(55);
    expect(report.recommendRevision).toBe(true);
    expect(report.fatalIssues).toContain('主角性别被改写');
    expect(report.structuralChecks[0]?.pass).toBe(true);
  });

  it('runs reflection and inspection helpers in parallel', async () => {
    const { runReflectionAndInspectionParallel } = await import('./SubAgentRunner.js');
    let reflectionDone = false;
    const result = await runReflectionAndInspectionParallel(
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        reflectionDone = true;
      },
      async () => ({ ok: true }),
    );
    expect(reflectionDone).toBe(true);
    expect(result.inspection).toEqual({ ok: true });
  });
});