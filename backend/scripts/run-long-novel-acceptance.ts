import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { CachingModelProxy } from '../src/proxy/CachingModelProxy.js';
import { OpenAiCompatibleModelProxy } from '../src/proxy/ModelProxy.js';
import { resetCacheStats } from '../src/proxy/cacheStats.js';
import { AgentOrchestrator } from '../src/services/agent/AgentOrchestrator.js';
import { MemoryService } from '../src/services/memory/MemoryService.js';
import { MemoryStore } from '../src/services/memory/MemoryStore.js';
import { FileDataStore } from '../src/store/FileDataStore.js';
import type { AgentProgressEvent, AgentRunMetrics, ChatMessage, ModelConfig } from '../src/types/index.js';

interface Args {
  prompt: string;
  chapters: number;
  targetWords: number;
  batchSize: number;
  maxBatches: number;
  outDir: string;
  audit: boolean;
}

interface BatchRecord {
  batchNo: number;
  requestedChapters: number;
  totalChaptersNow: number;
  elapsedMs: number;
  summary: string;
  metrics?: AgentRunMetrics;
}

interface LongRunReport {
  runId: string;
  startedAt: string;
  updatedAt: string;
  prompt: string;
  model: {
    baseUrl: string;
    modelName: string;
  };
  target: {
    chapters: number;
    targetWords: number;
    plannedWords: number;
    batchSize: number;
  };
  projectId?: string;
  batches: BatchRecord[];
  totals: {
    chapters: number;
    actualChars: number;
    modelCalls: number;
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    localCacheHits: number;
    localCacheMisses: number;
    estimatedCostUsd?: number;
  };
  audit?: unknown;
}

function parseArgs(argv: string[]): Args {
  const options = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      options.set(key, true);
    } else {
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
  const nonNegativeIntValue = (name: string, fallback: number): number => {
    const parsed = Number(value(name, String(fallback)));
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
  };
  return {
    prompt: value('prompt', '赛博修仙学院，主角靠写代码御剑。要求主线清晰、人物稳定、长期伏笔可回收。'),
    chapters: intValue('chapters', 500),
    targetWords: intValue('words', 2000),
    batchSize: intValue('batch', 10),
    maxBatches: nonNegativeIntValue('max-batches', Number.MAX_SAFE_INTEGER),
    outDir: resolve(value('out', '../reports/long-run/million-word-acceptance')),
    audit: options.get('no-audit') !== true,
  };
}

function readModelConfig(): ModelConfig {
  const baseUrl = process.env.LLM_BASE_URL?.trim() ?? '';
  const apiKey = process.env.LLM_API_KEY?.trim() ?? '';
  const modelName = process.env.LLM_MODEL?.trim() ?? '';
  if (!baseUrl || !apiKey || !modelName) {
    throw new Error('缺少 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 环境变量。');
  }
  applyDeepSeekPriceDefaults(modelName);
  return {
    baseUrl,
    apiKey,
    modelName,
    temperature: readNumber('LLM_TEMPERATURE', 0.8),
    topP: readNumber('LLM_TOP_P', 1),
  };
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function applyDeepSeekPriceDefaults(modelName: string): void {
  if (!modelName.startsWith('deepseek-v4-')) return;
  const isPro = modelName.includes('pro');
  process.env.LLM_CACHED_PROMPT_USD_PER_1M_TOKENS ??= isPro ? '0.003625' : '0.0028';
  process.env.LLM_PROMPT_USD_PER_1M_TOKENS ??= isPro ? '0.435' : '0.14';
  process.env.LLM_COMPLETION_USD_PER_1M_TOKENS ??= isPro ? '0.87' : '0.28';
}

async function readReport(path: string, args: Args, config: ModelConfig): Promise<LongRunReport> {
  if (existsSync(path)) {
    const report = JSON.parse(await readFile(path, 'utf8')) as LongRunReport;
    report.target = {
      chapters: args.chapters,
      targetWords: args.targetWords,
      plannedWords: args.chapters * args.targetWords,
      batchSize: args.batchSize,
    };
    report.totals.modelCalls ??= report.batches.reduce((sum, batch) => sum + (batch.metrics?.modelCalls ?? 0), 0);
    return report;
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
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      localCacheHits: 0,
      localCacheMisses: 0,
    },
  };
}

function addMetrics(totals: LongRunReport['totals'], metrics?: AgentRunMetrics): void {
  if (!metrics) return;
  totals.modelCalls += metrics.modelCalls;
  totals.promptTokens += metrics.promptTokens;
  totals.completionTokens += metrics.completionTokens;
  totals.cacheHitTokens += metrics.cacheHitTokens;
  totals.cacheMissTokens += metrics.cacheMissTokens;
  totals.localCacheHits += metrics.localCacheHits;
  totals.localCacheMisses += metrics.localCacheMisses;
  if (metrics.estimatedCostUsd !== undefined) {
    totals.estimatedCostUsd = (totals.estimatedCostUsd ?? 0) + metrics.estimatedCostUsd;
    totals.estimatedCostUsd = Math.round(totals.estimatedCostUsd * 1_000_000) / 1_000_000;
  }
}

async function writeReports(reportPath: string, markdownPath: string, report: LongRunReport): Promise<void> {
  report.updatedAt = new Date().toISOString();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(
    markdownPath,
    [
      '# 长篇小说 Agent 验收报告',
      '',
      `- runId: ${report.runId}`,
      `- model: ${report.model.modelName}`,
      `- projectId: ${report.projectId ?? 'pending'}`,
      `- target: ${report.target.chapters} x ${report.target.targetWords} = ${report.target.plannedWords.toLocaleString()} 字`,
      `- completed chapters: ${report.totals.chapters}`,
      `- actual chars: ${report.totals.actualChars.toLocaleString()}`,
      `- model calls: ${report.totals.modelCalls.toLocaleString()}`,
      `- prompt tokens: ${report.totals.promptTokens.toLocaleString()}`,
      `- completion tokens: ${report.totals.completionTokens.toLocaleString()}`,
      `- cache hit/miss tokens: ${report.totals.cacheHitTokens.toLocaleString()} / ${report.totals.cacheMissTokens.toLocaleString()}`,
      `- local cache hits/misses: ${report.totals.localCacheHits} / ${report.totals.localCacheMisses}`,
      `- estimated cost USD: ${report.totals.estimatedCostUsd ?? 'not configured'}`,
      '',
      '## Batches',
      ...report.batches.map(
        (b) =>
          `- #${b.batchNo}: requested=${b.requestedChapters}, totalChapters=${b.totalChaptersNow}, elapsedMs=${b.elapsedMs}, summary=${b.summary}`,
      ),
      '',
      report.audit ? `## Audit\n\n\`\`\`json\n${JSON.stringify(report.audit, null, 2)}\n\`\`\`\n` : '',
    ].join('\n'),
    'utf8',
  );
}

async function collectText(
  proxy: CachingModelProxy,
  config: ModelConfig,
  messages: ChatMessage[],
  jsonMode = false,
): Promise<string> {
  const chunks: string[] = [];
  for await (const delta of proxy.streamCompletion(config, messages, new AbortController().signal, { jsonMode })) {
    if (delta.kind === 'content') chunks.push(delta.text);
  }
  return chunks.join('');
}

function parseJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { parseError: 'no json object found', raw: raw.slice(0, 2000) };
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    return {
      parseError: error instanceof Error ? error.message : String(error),
      raw: raw.slice(0, 2000),
    };
  }
}

async function runAudit(
  proxy: CachingModelProxy,
  config: ModelConfig,
  store: FileDataStore,
  memory: MemoryService,
  projectId: string,
): Promise<unknown> {
  const [project, chapters, worlds, characters, outlines] = await Promise.all([
    store.getProject(projectId),
    store.listChapters(projectId),
    store.listWorldSettings(projectId),
    store.listCharacters(projectId),
    store.listOutlines(projectId),
  ]);
  const snapshot = {
    project: project?.name,
    counts: { chapters: chapters.length, worlds: worlds.length, characters: characters.length, outlines: outlines.length },
    world: worlds.at(-1)?.content.slice(0, 1500),
    characters: characters.at(-1)?.description.slice(0, 1500),
    outline: outlines.at(-1)?.content.slice(0, 1500),
    memory: memory.buildContext(projectId, { maxSummaries: 20, maxFacts: 40, maxLearnings: 12 }).slice(0, 5000),
    chapterSamples: chapters.map((chapter) => ({
      title: chapter.title,
      chars: chapter.content.length,
      start: chapter.content.replace(/\s+/g, ' ').slice(0, 500),
      end: chapter.content.replace(/\s+/g, ' ').slice(-500),
    })),
  };
  const raw = await collectText(
    proxy,
    config,
    [
      {
        role: 'system',
        content:
          '你是长篇小说连续性验收 Agent。只输出 JSON：plotDeviationRisk(0-100), characterConsistency(0-100), worldConsistency(0-100), styleConsistency(0-100), issues[], verdict。',
      },
      { role: 'user', content: JSON.stringify(snapshot, null, 2) },
    ],
    true,
  );
  return parseJsonObject(raw);
}

async function persistAuditFeedback(memory: MemoryService, projectId: string, audit: unknown): Promise<void> {
  if (typeof audit !== 'object' || audit === null) return;
  const obj = audit as { issues?: unknown; verdict?: unknown };
  const verdict = typeof obj.verdict === 'string' && obj.verdict.trim().length > 0 ? obj.verdict.trim() : '';
  if (!Array.isArray(obj.issues) || obj.issues.length === 0) {
    if (isPassingVerdict(verdict)) {
      await memory.recordLearning(projectId, `最新连续性审计通过且无新问题；后续写作优先遵循最新章节状态，避免重复修复已消失的问题。`);
    }
    return;
  }
  const issues = obj.issues.filter((issue): issue is string => typeof issue === 'string' && issue.trim().length > 0);
  const actionable = issues.filter(isActionableAuditIssue);
  const resolved = issues.filter((issue) => !isActionableAuditIssue(issue));
  if (actionable.length === 0 && resolved.length === 0) return;
  if (actionable.length > 0) {
    await memory.recordFacts(
      projectId,
      actionable.slice(0, 8).map((issue) => ({ kind: 'plot' as const, text: `连续性审计问题：${issue}` })),
    );
  }
  if (resolved.length > 0) {
    await memory.recordFacts(
      projectId,
      resolved.slice(0, 4).map((issue) => ({ kind: 'plot' as const, text: `连续性审计修正：${issue}` })),
    );
  }
  if (actionable.length > 0) {
    const verdictText = verdict.length > 0 ? `；审计结论：${verdict}` : '';
    await memory.recordLearning(projectId, `下一批写作必须修复连续性审计问题：${actionable.join('；')}${verdictText}`);
  }
}

function isActionableAuditIssue(issue: string): boolean {
  return !/实际未发现|未发现矛盾|可能已修复|已经修复|已修复/.test(issue);
}

function isPassingVerdict(verdict: string): boolean {
  return /pass|通过|可发布/i.test(verdict);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = readModelConfig();
  await mkdir(args.outDir, { recursive: true });
  const reportPath = join(args.outDir, 'report.json');
  const markdownPath = join(args.outDir, 'report.md');
  const eventsPath = join(args.outDir, 'events.jsonl');
  const store = await FileDataStore.create(join(args.outDir, 'store.json'));
  const memoryStore = await MemoryStore.create(join(args.outDir, 'memory.json'));
  const memory = new MemoryService(memoryStore);
  const proxy = new CachingModelProxy(new OpenAiCompatibleModelProxy(), { dir: join(args.outDir, 'llm-cache') });
  const modelConfigService = { getInternalConfig: async () => config };
  const orchestrator = new AgentOrchestrator(store, modelConfigService, proxy, undefined, undefined, memory);
  const report = await readReport(reportPath, args, config);
  resetCacheStats();

  for (let batchIndex = 0; batchIndex < args.maxBatches; batchIndex += 1) {
    const existingChapters = report.projectId ? await store.listChapters(report.projectId) : [];
    const remaining = args.chapters - existingChapters.length;
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
    report.totals.chapters = chapters.length;
    report.totals.actualChars = chapters.reduce((sum, chapter) => sum + chapter.content.length, 0);
    addMetrics(report.totals, result.metrics);
    report.batches.push({
      batchNo: report.batches.length + 1,
      requestedChapters,
      totalChaptersNow: chapters.length,
      elapsedMs: Date.now() - started,
      summary: result.summary,
      metrics: result.metrics,
    });
    await writeReports(reportPath, markdownPath, report);
  }

  await writeReports(reportPath, markdownPath, report);

  if (args.audit && report.projectId) {
    report.audit = await runAudit(proxy, config, store, memory, report.projectId);
    await persistAuditFeedback(memory, report.projectId, report.audit);
    await writeReports(reportPath, markdownPath, report);
  }

  console.log(JSON.stringify({
    report: reportPath,
    markdown: markdownPath,
    projectId: report.projectId,
    chapters: report.totals.chapters,
    actualChars: report.totals.actualChars,
    modelCalls: report.totals.modelCalls,
    promptTokens: report.totals.promptTokens,
    completionTokens: report.totals.completionTokens,
    estimatedCostUsd: report.totals.estimatedCostUsd,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
