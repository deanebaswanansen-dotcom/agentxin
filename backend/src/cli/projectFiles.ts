import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export interface NovelProjectPaths {
  root: string;
  bible: string;
  outline: string;
  chapters: string;
  reviews: string;
  exports: string;
  state: string;
}

export interface NovelState {
  title: string;
  genre: string[];
  createdAt: string;
  updatedAt: string;
  chapters: Array<{ number: number; title: string; file: string }>;
}

export function getProjectPaths(projectRoot: string): NovelProjectPaths {
  const root = resolve(projectRoot);
  return {
    root,
    bible: join(root, 'bible'),
    outline: join(root, 'outline'),
    chapters: join(root, 'chapters'),
    reviews: join(root, 'reviews'),
    exports: join(root, 'exports'),
    state: join(root, 'state.json'),
  };
}

export async function initializeNovelProject(
  projectRoot: string,
  input: { title: string; genre: string[] },
): Promise<NovelProjectPaths> {
  const paths = getProjectPaths(projectRoot);
  for (const dir of [paths.root, paths.bible, paths.outline, paths.chapters, paths.reviews, paths.exports]) {
    await mkdir(dir, { recursive: true });
  }
  const now = new Date().toISOString();
  const state: NovelState = {
    title: input.title,
    genre: input.genre,
    createdAt: now,
    updatedAt: now,
    chapters: [],
  };
  if (!existsSync(paths.state)) {
    await writeJson(paths.state, state);
  }
  await writeIfMissing(join(paths.bible, 'premise.md'), `# ${input.title}\n\n`);
  await writeIfMissing(join(paths.bible, 'world.md'), '# World\n\n');
  await writeIfMissing(join(paths.bible, 'characters.md'), '# Characters\n\n');
  await writeIfMissing(join(paths.bible, 'rules.md'), '# Rules\n\n');
  await writeIfMissing(join(paths.bible, 'timeline.md'), '# Timeline\n\n');
  await writeIfMissing(join(paths.bible, 'foreshadowing.md'), '# Foreshadowing\n\n');
  await writeIfMissing(join(paths.outline, 'chapter-list.md'), '# Chapter List\n\n');
  await writeIfMissing(join(paths.outline, 'volume-01.md'), '# Volume 01\n\n');
  return paths;
}

export async function loadState(projectRoot: string): Promise<NovelState> {
  const paths = getProjectPaths(projectRoot);
  const raw = await readFile(paths.state, 'utf8');
  return JSON.parse(raw) as NovelState;
}

export async function saveState(projectRoot: string, state: NovelState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeJson(getProjectPaths(projectRoot).state, state);
}

export async function writeProjectFile(
  file: string,
  content: string,
  options?: { overwrite?: boolean },
): Promise<void> {
  if (existsSync(file) && options?.overwrite !== true) {
    throw new Error(`文件已存在，使用 --overwrite 才能覆盖：${file}`);
  }
  await mkdir(resolve(file, '..'), { recursive: true });
  await writeFile(file, content, 'utf8');
}

export async function readProjectContext(projectRoot: string): Promise<string> {
  const paths = getProjectPaths(projectRoot);
  const files = [
    join(paths.bible, 'premise.md'),
    join(paths.bible, 'world.md'),
    join(paths.bible, 'characters.md'),
    join(paths.bible, 'rules.md'),
    join(paths.outline, 'chapter-list.md'),
  ];
  const chunks: string[] = [];
  for (const file of files) {
    if (existsSync(file)) {
      chunks.push(`## ${basename(file)}\n${await readFile(file, 'utf8')}`);
    }
  }
  return chunks.join('\n\n');
}

export async function listChapterFiles(projectRoot: string): Promise<string[]> {
  const dir = getProjectPaths(projectRoot).chapters;
  if (!existsSync(dir)) {
    return [];
  }
  const names = await readdir(dir);
  const files: string[] = [];
  for (const name of names.sort()) {
    const file = join(dir, name);
    if ((await stat(file)).isFile() && /\.(md|txt)$/i.test(name)) {
      files.push(file);
    }
  }
  return files;
}

async function writeIfMissing(file: string, content: string): Promise<void> {
  if (!existsSync(file)) {
    await writeFile(file, content, 'utf8');
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
