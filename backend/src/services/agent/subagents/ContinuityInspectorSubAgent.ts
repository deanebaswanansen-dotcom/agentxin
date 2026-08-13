/**
 * Continuity Inspector Sub-Agent — detection only, never writes prose.
 * Pairs with the chapter writer sub-agent in long-form runs.
 */
import type { ModelProxy } from '../../../proxy/ModelProxy.js';
import type { ChatMessage, ModelConfig } from '../../../types/index.js';
import { stripReasoningArtifacts } from '../../text/reasoningSanitizer.js';
import type { CanonLock, InspectChapterInput, InspectorReport } from './types.js';

function parseJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { parseError: 'no json object found', raw: raw.slice(0, 2000) };
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    return {
      parseError: error instanceof Error ? error.message : String(error),
      raw: raw.slice(0, 2000),
    };
  }
}

function runStructuralChecks(
  locks: CanonLock[],
  atChapter: number,
  injected: string,
  earlySamples: InspectChapterInput['earlyChapterSamples'],
  recentSamples: InspectChapterInput['recentChapterSamples'],
  currentChapterText: string,
): InspectorReport['structuralChecks'] {
  const earlyText = earlySamples.map((s) => s.excerpt).join('\n');
  const recentText = `${recentSamples.map((s) => s.excerpt).join('\n')}\n${currentChapterText}`;
  return locks
    .filter((lock) => lock.introducedBy <= atChapter)
    .map((lock) => {
      const inInjectedMemory = injected.includes(lock.keyword);
      const inEarlyChapters = earlyText.includes(lock.keyword);
      const inRecentChapters = recentText.includes(lock.keyword);
      const pass = inInjectedMemory && (lock.introducedBy > atChapter - 5 || inRecentChapters);
      return {
        id: lock.id,
        keyword: lock.keyword,
        inInjectedMemory,
        inEarlyChapters,
        inRecentChapters,
        pass,
      };
    });
}

function normalizeReport(
  parsed: unknown,
  input: InspectChapterInput,
  structuralChecks: InspectorReport['structuralChecks'],
): InspectorReport {
  const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const fatalIssues = Array.isArray(obj.fatalIssues)
    ? obj.fatalIssues.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  const earlyCharacterStatus = Array.isArray(obj.earlyCharacterStatus)
    ? obj.earlyCharacterStatus
        .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
        .map((row) => ({
          id: typeof row.id === 'string' ? row.id : 'unknown',
          consistent: row.consistent === true,
          note: typeof row.note === 'string' ? row.note : '',
        }))
    : [];
  const revisionHints = Array.isArray(obj.revisionHints)
    ? obj.revisionHints.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : fatalIssues.slice(0, 3).map((issue) => `修复：${issue}`);
  const score0to100 =
    typeof obj.score0to100 === 'number' && Number.isFinite(obj.score0to100)
      ? Math.max(0, Math.min(100, Math.round(obj.score0to100)))
      : structuralChecks.every((c) => c.pass) && fatalIssues.length === 0
        ? 80
        : 50;
  const structuralFails = structuralChecks.filter((c) => !c.pass).length;
  const recommendRevision =
    obj.recommendRevision === true || score0to100 < 70 || structuralFails > 0 || fatalIssues.length > 0;
  return {
    score0to100,
    verdict: typeof obj.verdict === 'string' && obj.verdict.trim().length > 0 ? obj.verdict.trim() : score0to100 >= 70 ? 'pass' : 'needs_revision',
    plotCoherence: typeof obj.plotCoherence === 'string' ? obj.plotCoherence : '',
    fatalIssues,
    earlyCharacterStatus,
    recommendRevision,
    revisionHints,
    structuralChecks,
    injectedMemoryChars: input.injectedMemory.length,
    injectedMemoryOptions: input.injectedMemoryOptions,
  };
}

export class ContinuityInspectorSubAgent {
  constructor(private readonly modelProxy: ModelProxy) {}

  async inspectChapter(
    config: ModelConfig,
    input: InspectChapterInput,
    signal: AbortSignal,
  ): Promise<InspectorReport> {
    const locks = input.canonLocks ?? [];
    const structuralChecks = runStructuralChecks(
      locks,
      input.atChapter,
      input.injectedMemory,
      input.earlyChapterSamples,
      input.recentChapterSamples,
      input.chapterContent,
    );

    const payload = {
      role: 'inspector_only',
      atChapter: input.atChapter,
      chapterTitle: input.chapterTitle,
      chapterExcerpt: input.chapterContent.replace(/\s+/g, ' ').slice(0, 2500),
      canonLocks: locks.filter((l) => l.introducedBy <= input.atChapter),
      injectedMemory: input.injectedMemory.slice(0, 6000),
      earlyChapterSamples: input.earlyChapterSamples,
      recentChapterSamples: input.recentChapterSamples,
      structuralChecks,
      questions: [
        '20–30章之前出场的角色，姓名/身份/状态是否仍一致？',
        '有无死人复活、道具复原、主角性别或核心能力被改写？',
        '剧情是一以贯之，还是碎片化、像鸡毛一样乱？',
      ],
    };

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          '你是「检测子 Agent」，只负责审查，绝不写正文。',
          '写作子 Agent 已完成本章，你的任务是发现设定漂移、人物混乱、剧情断裂。',
          '只输出 JSON：',
          '{"score0to100":number,"verdict":string,"plotCoherence":string,',
          '"fatalIssues":string[],"earlyCharacterStatus":[{"id":string,"consistent":boolean,"note":string}],',
          '"recommendRevision":boolean,"revisionHints":string[]}',
        ].join('\n'),
      },
      { role: 'user', content: JSON.stringify(payload, null, 2) },
    ];

    const chunks: string[] = [];
    for await (const delta of this.modelProxy.streamCompletion(config, messages, signal, {
      jsonMode: true,
      disableThinking: true,
      maxTokens: 2048,
    })) {
      if (delta.kind === 'content') chunks.push(delta.text);
    }
    const raw = stripReasoningArtifacts(chunks.join(''));
    return normalizeReport(parseJsonObject(raw), input, structuralChecks);
  }
}
