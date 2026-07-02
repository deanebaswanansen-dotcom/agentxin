/**
 * Long-form continuity acceptance for the novel Agent.
 *
 * Goals (几十万字 scale):
 * - Batch-generate chapters with locked canon (characters / world / plot hooks).
 * - At checkpoints (e.g. ch 10 / 20 / 30), audit:
 *   1) what memory is actually injected into the next chapter;
 *   2) whether early characters still appear correctly in recent chapters;
 *   3) LLM continuity probe on canon locks from ch 1–15.
 *
 * Resume-friendly: re-run with the same --out dir to continue batches.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { CachingModelProxy } from '../src/proxy/CachingModelProxy.js';
import { OpenAiCompatibleModelProxy } from '../src/proxy/ModelProxy.js';
import { resetCacheStats } from '../src/proxy/cacheStats.js';
import { AgentOrchestrator } from '../src/services/agent/AgentOrchestrator.js';
import {
  ContinuityInspectorSubAgent,
  type CanonLock,
  type InspectorReport,
} from '../src/services/agent/subagents/index.js';
import { MemoryService, scaledMemoryOptions } from '../src/services/memory/MemoryService.js';
import { MemoryStore } from '../src/services/memory/MemoryStore.js';
import { FileDataStore } from '../src/store/FileDataStore.js';
import type { AgentProgressEvent, AgentRunMetrics, ModelConfig } from '../src/types/index.js';

interface Args {
  prompt: string;
  chapters: number;
  targetWords: number;
  batchSize: number;
  maxBatches: number;
  checkpoints: number[];
  outDir: string;
}

interface CheckpointRecord {
  atChapter: number;
  injectedMemoryChars: number;
  injectedMemoryOptions: ReturnType<typeof scaledMemoryOptions>;
  structuralChecks: Array<{
    id: string;
    keyword: string;
    inInjectedMemory: boolean;
    inEarlyChapters: boolean;
    inRecentChapters: boolean;
    pass: boolean;
  }>;
  probe?: InspectorReport;
}

interface ContinuityReport {
  runId: string;
  startedAt: string;
  updatedAt: string;
  prompt: string;
  model: { baseUrl: string; modelName: string };
  target: { chapters: number; targetWords: number; plannedWords: number; batchSize: number };
  projectId?: string;
  batches: Array<{
    batchNo: number;
    requestedChapters: number;
    totalChaptersNow: number;
    elapsedMs: number;
    summary: string;
    metrics?: AgentRunMetrics;
  }>;
  totals: {
    chapters: number;
    actualChars: number;
    modelCalls: number;
    promptTokens: number;
    completionTokens: number;
    estimatedCostUsd?: number;
  };
  checkpoints: CheckpointRecord[];
  verdict?: string;
}

const DEFAULT_CANON_LOCKS: CanonLock[] = [
  { id: 'hero', keyword: '沈砚秋', introducedBy: 1, rule: '女主，左手朱砂胎记，不可改性别' },
  { id: 'master', keyword: '顾寒山', introducedBy: 1, rule: '师父，道观观主，沈砚秋唯一信任者' },
  { id: 'bell', keyword: '青玉铃铛', introducedBy: 1, rule: '第3章必须碎裂，碎后不可复原' },
  { id: 'limper', keyword: '瘸七爷', introducedBy: 8, rule: '第8章出场，卖药老头，左脚跛，魅影阁眼线' },
  { id: 'swordsman', keyword: '苏绾绾', introducedBy: 15, rule: '第15章出场，玄门剑宗，佩剑霜华，性格冷傲' },
];

const DEFAULT_PROMPT = [
  '【长篇连贯性验收专用】必须一以贯之，禁止中途改设定、乱加角色、死人复活。',
  '铁律角色：沈砚秋（女主，17岁，左手朱砂胎记=先天封印印）；顾寒山（师父，36岁道观观主）；',
  '青玉铃铛（镇魂铃，第3章必须碎裂且不可复原）；瘸七爷（第8章出场，左脚跛，卖药老头，实为魅影阁眼线）；',
  '苏绾绾（第15章出场，玄门剑宗弟子，佩剑「霜华」，冷傲）。',
  '世界：炁可修炼，残秽引山魈；魅影阁猎杀失控修行者。',
  '禁区：禁止改主角性别；禁止青玉铃铛复活；禁止顾寒山前50章死亡。',
  '要求：主线清晰，人物口吻稳定，伏笔可回收，不可写成鸡毛蒜皮的碎片化剧情。',
].join('');

function parseArgs(argv: string[]): Args {
  const options = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) options.set(key, true);
    else {
      options.set(key, next);
      i += 1;
    }
  }
  const value = (name: string, fallback: string): string => {
    const raw = options.get(name);
    return typeof raw === 'string' ? raw : fallback;
  };
  const intValue = (name: string, fallback: number): number => {
    const parsed = Number(value(name, String(fallback)));
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  };
  const checkpoints = value('checkpoints', '10,20,30,50,100')
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return {
    prompt: value('prompt', DEFAULT_PROMPT),
    chapters: intValue('chapters', 250),
    targetWords: intValue('words', 2000),
    batchSize: intValue('batch', 10),
    maxBatches: intValue('max-batches', Number.MAX_SAFE_INTEGER),
    checkpoints: checkpoints.length > 0 ? checkpoints : [10, 20, 30],
    outDir: resolve(value('out', '../reports/continuity-acceptance/latest')),
  };
}

function readModelConfig(): ModelConfig {
  const baseUrl = process.env.LLM_BASE_URL?.trim() ?? '';
  const apiKey = process.env.LLM_API_KEY?.trim() ?? '';
  const modelName = process.env.LLM_MODEL?.trim() ?? '';
  if (!baseUrl || !apiKey || !modelName) {
    throw new Error('缺少 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 环境变量。');
  }
  return {
    baseUrl,
    apiKey,
    modelName,
    temperature: Number(process.env.LLM_TEMPERATURE ?? 0.75),
    topP: Number(process.env.LLM_TOP_P ?? 1),
  };
}

async function readReport(path: string, args: Args, config: ModelConfig): Promise<ContinuityReport> {
  if (existsSync(path)) {
    return JSON.parse(await readFile(path, 'utf8')) as ContinuityReport;
  }
  const startedAt = new Date().toISOString();
  return {
    runId: startedAt.replace(/[:.]/g, '-'),
    startedAt,
    updatedAt: startedAt,
    prompt: args.prompt,
    model: { baseUrl: config.baseUrl, modelName: config.modelName },
    target: {
      chapters: args.chapters,
      targetWords: args.targetWords,
      plannedWords: args.chapters * args.targetWords,
      batchSize: args.batchSize,
    },
    batches: [],
    totals: {
      chapters: 0,
      actualChars: 0,
      modelCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
    },
    checkpoints: [],
  };
}

async function runCheckpoint(
  inspector: ContinuityInspectorSubAgent,
  config: ModelConfig,
  store: FileDataStore,
  memory: MemoryService,
  projectId: string,
  atChapter: number,
  locks: CanonLock[],
): Promise<CheckpointRecord> {
  const chapters = await store.listChapters(projectId);
  const options = scaledMemoryOptions(atChapter);
  const injected = memory.buildContext(projectId, options);
  const early = chapters.slice(0, 3);
  const recent = chapters.slice(-3);
  const latest = chapters.at(-1);
  const probe = await inspector.inspectChapter(
    config,
    {
      projectId,
      atChapter,
      chapterTitle: latest?.title ?? `第${atChapter}章`,
      chapterContent: latest?.content ?? '',
      canonLocks: locks,
      earlyChapterSamples: early.map((ch) => ({
        title: ch.title,
        excerpt: ch.content.replace(/\s+/g, ' ').slice(0, 600),
      })),
      recentChapterSamples: recent.map((ch) => ({
        title: ch.title,
        excerpt: ch.content.replace(/\s+/g, ' ').slice(0, 600),
      })),
      injectedMemory: injected,
      injectedMemoryOptions: options,
    },
    new AbortController().signal,
  );

  return {
    atChapter,
    injectedMemoryChars: probe.injectedMemoryChars,
    injectedMemoryOptions: probe.injectedMemoryOptions,
    structuralChecks: probe.structuralChecks,
    probe,
  };
}

async function writeReports(reportPath: string, markdownPath: string, report: ContinuityReport): Promise<void> {
  report.updatedAt = new Date().toISOString();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const lines = [
    '# 长篇小说 Agent 连贯性验收报告',
    '',
    `- runId: ${report.runId}`,
    `- model: ${report.model.modelName}`,
    `- projectId: ${report.projectId ?? 'pending'}`,
    `- target: ${report.target.chapters} 章 × ${report.target.targetWords} 字 ≈ ${report.target.plannedWords.toLocaleString()} 字`,
    `- completed: ${report.totals.chapters} 章 / ${report.totals.actualChars.toLocaleString()} 字`,
    `- verdict: ${report.verdict ?? 'pending'}`,
    '',
    '## Checkpoints',
    ...report.checkpoints.map((cp) => {
      const fails = cp.structuralChecks.filter((c) => !c.pass);
      return [
        `### 第 ${cp.atChapter} 章`,
        `- injected memory chars: ${cp.injectedMemoryChars}`,
        `- memory options: ${JSON.stringify(cp.injectedMemoryOptions)}`,
        `- structural fails: ${fails.length === 0 ? 'none' : fails.map((f) => f.id).join(', ')}`,
        `- probe: \`${JSON.stringify(cp.probe)}\``,
        '',
      ].join('\n');
    }),
  ];
  await writeFile(markdownPath, `${lines.join('\n')}\n`, 'utf8');
}

function summarizeVerdict(checkpoints: CheckpointRecord[]): string {
  if (checkpoints.length === 0) return 'pending';
  const last = checkpoints[checkpoints.length - 1]!;
  const structuralFails = last.structuralChecks.filter((c) => !c.pass).length;
  const probe = last.probe as { score0to100?: number; verdict?: string; fatalIssues?: string[] } | undefined;
  const score = typeof probe?.score0to100 === 'number' ? probe.score0to100 : 0;
  if (structuralFails > 0) return `FAIL structural(${structuralFails}) score=${score}`;
  if (score < 70) return `FAIL score=${score}`;
  return typeof probe?.verdict === 'string' && probe.verdict.length > 0 ? probe.verdict : `PASS score=${score}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = readModelConfig();
  await mkdir(args.outDir, { recursive: true });
  const reportPath = join(args.outDir, 'report.json');
  const markdownPath = join(args.outDir, 'report.md');
  const eventsPath = join(args.outDir, 'events.jsonl');
  const store = await FileDataStore.create(join(args.outDir, 'store.json'));
  const memory = new MemoryService(await MemoryStore.create(join(args.outDir, 'memory.json')));
  const proxy = new CachingModelProxy(new OpenAiCompatibleModelProxy(), { dir: join(args.outDir, 'llm-cache') });
  const inspector = new ContinuityInspectorSubAgent(proxy);
  const orchestrator = new AgentOrchestrator(store, { getInternalConfig: async () => config }, proxy, undefined, undefined, memory);
  const report = await readReport(reportPath, args, config);
  resetCacheStats();

  const completedCheckpoints = new Set(report.checkpoints.map((c) => c.atChapter));

  for (let batchIndex = 0; batchIndex < args.maxBatches; batchIndex += 1) {
    const existingChapters = report.projectId ? await store.listChapters(report.projectId) : [];
    const completedChapters = existingChapters.filter((ch) => ch.content.trim().length > 0).length;
    const remaining = args.chapters - completedChapters;
    if (remaining <= 0) break;

    const requestedChapters = Math.min(args.batchSize, remaining);
    const started = Date.now();
    const result = await orchestrator.run(
      {
        task: 'full_novel',
        mode: 'draft',
        prompt: report.prompt,
        projectId: report.projectId,
        options: { chapters: requestedChapters, targetWords: args.targetWords, totalChapters: args.chapters },
      },
      new AbortController().signal,
      async (event: AgentProgressEvent) => {
        await appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), event })}\n`, 'utf8');
      },
    );

    report.projectId = result.projectId;
    const chapters = await store.listChapters(result.projectId);
    report.totals.chapters = chapters.filter((ch) => ch.content.trim().length > 0).length;
    report.totals.actualChars = chapters.reduce((sum, ch) => sum + ch.content.length, 0);
    if (result.metrics) {
      report.totals.modelCalls += result.metrics.modelCalls;
      report.totals.promptTokens += result.metrics.promptTokens;
      report.totals.completionTokens += result.metrics.completionTokens;
      if (result.metrics.estimatedCostUsd !== undefined) {
        report.totals.estimatedCostUsd = (report.totals.estimatedCostUsd ?? 0) + result.metrics.estimatedCostUsd;
      }
    }
    report.batches.push({
      batchNo: report.batches.length + 1,
      requestedChapters,
      totalChaptersNow: chapters.length,
      elapsedMs: Date.now() - started,
      summary: result.summary,
      metrics: result.metrics,
    });

    const completedNow = chapters.filter((ch) => ch.content.trim().length > 0).length;
    for (const checkpoint of args.checkpoints) {
      if (completedNow >= checkpoint && !completedCheckpoints.has(checkpoint)) {
        const record = await runCheckpoint(inspector, config, store, memory, result.projectId, checkpoint, DEFAULT_CANON_LOCKS);
        report.checkpoints.push(record);
        completedCheckpoints.add(checkpoint);
        report.verdict = summarizeVerdict(report.checkpoints);
      }
    }

    await writeReports(reportPath, markdownPath, report);
  }

  report.verdict = summarizeVerdict(report.checkpoints);
  await writeReports(reportPath, markdownPath, report);

  console.log(
    JSON.stringify(
      {
        report: reportPath,
        markdown: markdownPath,
        projectId: report.projectId,
        chapters: report.totals.chapters,
        actualChars: report.totals.actualChars,
        checkpoints: report.checkpoints.map((c) => c.atChapter),
        verdict: report.verdict,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});