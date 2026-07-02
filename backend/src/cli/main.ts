import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadDotEnv, readLlmRuntimeConfig } from '../config/env.js';
import { createLlmProvider } from '../llm/UnifiedProvider.js';
import type { LlmProvider } from '../llm/UnifiedProvider.js';
import type { LlmRuntimeConfig } from '../config/env.js';
import {
  getProjectPaths,
  initializeNovelProject,
  listChapterFiles,
  loadState,
  readProjectContext,
  saveState,
  writeProjectFile,
} from './projectFiles.js';
import { clearCurrentProject, getCurrentProject, setCurrentProject } from './workspace.js';

interface ParsedArgs {
  command: string;
  options: Record<string, string | boolean>;
  positionals: string[];
}

export async function runCli(argv = process.argv.slice(2), cwd = process.cwd()): Promise<string> {
  loadDotEnv(cwd);
  const parsed = parseArgs(argv);
  if (parsed.command === 'workspace') {
    return runWorkspace(parsed, cwd);
  }
  // DEPRECATED (per Agent_Refactoring_Spec): Node CLI is legacy.
  // Use Python novel-agent CLI (single source of truth entry):
  //   python -m novel_agent.cli  or `novel-agent` after install.
  // This thin wrapper kept for compatibility but will be removed.
  // All core agent work (incl. blueprint plan/write) now via Python LangGraph.
  const runtimeConfig = readLlmRuntimeConfig();
  const provider = createLlmProvider(runtimeConfig);
  const warn = mockWarning(runtimeConfig);
  const withWarning = (message: string): string => (warn ? `${warn}\n${message}` : message);
  switch (parsed.command) {
    case 'ping':
      return withWarning(JSON.stringify(await provider.ping(), null, 2));
    case 'init':
      return runInit(parsed, cwd);
    case 'idea':
      return withWarning(await runIdea(parsed, cwd, provider));
    case 'outline':
      return withWarning(await runOutline(parsed, cwd, provider));
    case 'write':
      return withWarning(await runWrite(parsed, cwd, provider));
    case 'summary':
      return withWarning(await runSummary(parsed, cwd, provider));
    case 'check':
      return withWarning(await runCheck(parsed, cwd, provider));
    case 'export':
      return runExport(parsed, cwd);
    case 'help':
    case '':
      return helpText();
    default:
      throw new Error(`未知指令：${parsed.command} (Node CLI 已降级，推荐使用 Python novel-agent)`);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] ?? '';
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    i += 1;
  }
  return { command, options, positionals };
}

async function runInit(parsed: ParsedArgs, cwd: string): Promise<string> {
  const root = await projectRoot(parsed, cwd);
  const title = stringOption(parsed, 'title') || basename(root);
  const genre = splitList(stringOption(parsed, 'genre'));
  await initializeNovelProject(root, { title, genre });
  await setCurrentProject(cwd, root);
  return progress(['初始化项目目录', '写入项目骨架', `当前工作区已切换：${root}`], `initialized ${root}`);
}

/** Note: use `python -m novel_agent.cli` for full agent (blueprint etc). */
async function runIdea(parsed: ParsedArgs, cwd: string, provider: LlmProvider): Promise<string> {
  const root = await projectRoot(parsed, cwd);
  await ensureInitialized(root);
  const seed = stringOption(parsed, 'seed') || parsed.positionals.join(' ') || '生成一个适合长篇连载的小说创意。';
  const text = await provider.generate([
    { role: 'system', content: '你是小说策划助手，输出 Markdown，包含 premise、selling points、tone、risks。' },
    { role: 'user', content: seed },
  ]);
  const file = join(getProjectPaths(root).bible, 'premise.md');
  await writeProjectFile(file, `# Premise\n\n${text.trim()}\n`, { overwrite: true });
  return progress(['读取当前工作区', '请求模型扩展创意', '写入 premise.md'], `wrote ${file}`);
}

async function runOutline(parsed: ParsedArgs, cwd: string, provider: LlmProvider): Promise<string> {
  const root = await projectRoot(parsed, cwd);
  await ensureInitialized(root);
  const chapters = Number(stringOption(parsed, 'chapters') || '6');
  const context = await readProjectContext(root);
  const text = await provider.generate([
    { role: 'system', content: '你是长篇小说大纲规划助手，输出 Markdown 章节列表，包含每章目标、冲突、钩子。' },
    { role: 'user', content: `章节数：${chapters}\n\n项目上下文：\n${context}` },
  ]);
  const paths = getProjectPaths(root);
  await writeProjectFile(join(paths.outline, 'chapter-list.md'), `# Chapter List\n\n${text.trim()}\n`, {
    overwrite: true,
  });
  return progress(['读取 Bible 与创意', `生成 ${chapters} 章大纲`, '写入 chapter-list.md'], `wrote ${join(paths.outline, 'chapter-list.md')}`);
}

async function runWrite(parsed: ParsedArgs, cwd: string, provider: LlmProvider): Promise<string> {
  const root = await projectRoot(parsed, cwd);
  await ensureInitialized(root);
  const chapterNumber = Number(stringOption(parsed, 'chapter') || '1');
  const title = stringOption(parsed, 'title') || `Chapter ${chapterNumber}`;
  const context = await readProjectContext(root);
  const text = await provider.generate([
    { role: 'system', content: '你是小说正文写作助手，输出完整章节正文，保持设定一致，避免总结式大纲口吻。' },
    { role: 'user', content: `章节：${chapterNumber}\n标题：${title}\n\n上下文：\n${context}` },
  ]);
  const file = join(getProjectPaths(root).chapters, `ch${chapterNumber.toString().padStart(3, '0')}.md`);
  await writeProjectFile(file, `# ${title}\n\n${text.trim()}\n`, { overwrite: parsed.options.overwrite === true });
  const state = await loadState(root);
  const existing = state.chapters.find((chapter) => chapter.number === chapterNumber);
  if (existing) {
    existing.title = title;
    existing.file = basename(file);
  } else {
    state.chapters.push({ number: chapterNumber, title, file: basename(file) });
    state.chapters.sort((a, b) => a.number - b.number);
  }
  await saveState(root, state);
  return progress(['读取当前上下文', `生成第 ${chapterNumber} 章`, '更新章节状态'], `wrote ${file}`);
}

async function runSummary(parsed: ParsedArgs, cwd: string, provider: LlmProvider): Promise<string> {
  const root = await projectRoot(parsed, cwd);
  await ensureInitialized(root);
  const chapters = await readAllChapters(root);
  const text = await provider.generate([
    { role: 'system', content: '你是小说连续性摘要助手，输出 Markdown，包含已发生事件、人物状态、伏笔、下一章约束。' },
    { role: 'user', content: chapters || '当前还没有章节正文。' },
  ]);
  const file = join(getProjectPaths(root).reviews, 'summary.md');
  await writeProjectFile(file, `# Summary\n\n${text.trim()}\n`, { overwrite: true });
  return progress(['读取全部章节', '生成连续性摘要', '写入 reviews/summary.md'], `wrote ${file}`);
}

async function runCheck(parsed: ParsedArgs, cwd: string, provider: LlmProvider): Promise<string> {
  const root = await projectRoot(parsed, cwd);
  await ensureInitialized(root);
  const chapterNumber = Number(stringOption(parsed, 'chapter') || '1');
  const file = join(getProjectPaths(root).chapters, `ch${chapterNumber.toString().padStart(3, '0')}.md`);
  const content = existsSync(file) ? await readFile(file, 'utf8') : await readAllChapters(root);
  const text = await provider.generate([
    { role: 'system', content: '你是小说质量检查器，输出 Markdown，检查剧情逻辑、人物一致性、节奏、设定冲突、重复桥段。' },
    { role: 'user', content: content || '当前还没有可检查文本。' },
  ]);
  const review = join(getProjectPaths(root).reviews, `ch${chapterNumber.toString().padStart(3, '0')}.review.md`);
  await writeProjectFile(review, `# Review ${chapterNumber}\n\n${text.trim()}\n`, { overwrite: true });
  return progress([`读取第 ${chapterNumber} 章`, '检查逻辑与设定风险', '写入 review 文件'], `wrote ${review}`);
}

async function runExport(parsed: ParsedArgs, cwd: string): Promise<string> {
  const root = await projectRoot(parsed, cwd);
  await ensureInitialized(root);
  const format = stringOption(parsed, 'format') || 'markdown';
  const output =
    stringOption(parsed, 'output') ||
    join(getProjectPaths(root).exports, format === 'txt' ? 'novel.txt' : format === 'json' ? 'novel.json' : 'novel.md');
  const chapters = await listChapterFiles(root);
  if (format === 'json') {
    const payload = [];
    for (const file of chapters) {
      payload.push({ file: basename(file), content: await readFile(file, 'utf8') });
    }
    await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } else {
    await writeFile(output, await readAllChapters(root), 'utf8');
  }
  return progress(['读取章节列表', `导出 ${format}`, '写入导出文件'], `wrote ${output}`);
}

async function projectRoot(parsed: ParsedArgs, cwd: string): Promise<string> {
  const value = stringOption(parsed, 'project') || parsed.positionals[0] || await getCurrentProject(cwd) || 'projects/demo-novel';
  return resolve(cwd, value);
}

async function runWorkspace(parsed: ParsedArgs, cwd: string): Promise<string> {
  if (parsed.options.clear === true) {
    await clearCurrentProject(cwd);
    return 'workspace cleared';
  }
  const target = stringOption(parsed, 'project') || parsed.positionals[0];
  if (target) {
    const resolved = await setCurrentProject(cwd, target);
    return `workspace current = ${resolved}`;
  }
  const current = await getCurrentProject(cwd);
  return current ? `workspace current = ${resolve(cwd, current)}` : 'workspace current = none';
}

async function ensureInitialized(root: string): Promise<void> {
  if (!existsSync(getProjectPaths(root).state)) {
    await initializeNovelProject(root, { title: basename(root), genre: [] });
  }
}

async function readAllChapters(root: string): Promise<string> {
  const files = await listChapterFiles(root);
  const chunks: string[] = [];
  for (const file of files) {
    chunks.push(await readFile(file, 'utf8'));
  }
  return chunks.join('\n\n');
}

function stringOption(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.options[key];
  return typeof value === 'string' ? value : undefined;
}

function splitList(value: string | undefined): string[] {
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function progress(steps: string[], finalLine: string): string {
  return [...steps.map((step) => `[progress] ${step}`), finalLine].join('\n');
}

function mockWarning(config: LlmRuntimeConfig): string {
  return config.provider === 'mock'
    ? '[warning] 当前使用 Mock 模型，只适合演示和测试；生成文件会包含 MOCK_OUTPUT，请配置真实 LLM_PROVIDER/LLM_API_KEY 后再用于正式写作。'
    : '';
}

function helpText(): string {
  return [
    'NovelAgent CLI (Node, DEPRECATED per refactor spec)',
    'commands: ping, init, workspace, idea, outline, write, summary, check, export',
    'example: npm run cli -- init --project projects/demo-novel --title Demo',
    'current workspace: npm run cli -- workspace --project projects/demo-novel',
    '>>> Use Python LangGraph CLI as primary: python -m novel_agent.cli (or installed novel-agent)',
    'Node backend now serves as thin web/API proxy layer to Python core.',
  ].join('\n');
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runCli()
    .then((message) => {
      console.log(message);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    });
}
