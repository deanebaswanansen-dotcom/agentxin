import type { DataStore } from '../../store/DataStore.js';
import type {
  AgentArtifact,
  Id,
  ImportNovelFile,
  ImportNovelRequest,
  ImportNovelResult,
} from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';
import { stripReasoningArtifacts } from '../text/reasoningSanitizer.js';

const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const MAX_FILES = 200;
const MAX_CHAPTERS = 120;
const MAX_CHARACTERS = 12;
const MAX_CONTENT_CHARS = 1_200_000;

interface NormalizedFile {
  path: string;
  content: string;
}

interface ChapterDraft {
  title: string;
  content: string;
}

interface CharacterDraft {
  name: string;
  description: string;
}

export class NovelImportService {
  constructor(private readonly store: DataStore) {}

  async organizeIntoProject(
    projectId: Id,
    request: ImportNovelRequest,
  ): Promise<ImportNovelResult> {
    const project = await this.store.getProject(projectId);
    if (!project) {
      throw ServiceError.notFound(`项目不存在：${projectId}`);
    }

    const files = normalizeFiles(request.files);
    if (files.length === 0) {
      throw ServiceError.validation('没有可整理的 Markdown 或 TXT 文件。');
    }

    const sourceName = cleanTitle(
      request.sourceName ?? inferSourceName(files[0]?.path ?? project.name),
      project.name,
    );
    const combined = files
      .map((file) => `# ${file.path}\n\n${file.content}`)
      .join('\n\n---\n\n')
      .slice(0, MAX_CONTENT_CHARS);

    const artifacts: AgentArtifact[] = [{ kind: 'project', id: projectId, title: project.name }];

    const worldContent = buildWorldContent(combined, sourceName);
    const world = await this.store.createWorldSetting(
      projectId,
      `导入整理：${sourceName}世界观`,
      worldContent,
    );
    artifacts.push({ kind: 'world', id: world.id, title: world.title });

    const characterDrafts = inferCharacters(combined);
    for (const draft of characterDrafts) {
      const character = await this.store.createCharacter(
        projectId,
        draft.name,
        draft.description,
      );
      artifacts.push({ kind: 'character', id: character.id, title: character.name });
    }

    const outlineContent = buildOutlineContent(files, combined, sourceName);
    const outline = await this.store.createOutline(
      projectId,
      `导入整理：${sourceName}大纲`,
      outlineContent,
    );
    artifacts.push({ kind: 'outline', id: outline.id, title: outline.title });

    const chapters = inferChapters(files, sourceName).slice(0, MAX_CHAPTERS);
    let firstChapterId: Id | undefined;
    for (const draft of chapters) {
      const chapter = await this.store.createChapter(projectId, draft.title);
      await this.store.updateChapterContent(chapter.id, draft.content);
      firstChapterId ??= chapter.id;
      artifacts.push({ kind: 'chapter', id: chapter.id, title: chapter.title });
    }

    return {
      projectId,
      sourceName,
      filesImported: files.length,
      chaptersCreated: chapters.length,
      charactersCreated: characterDrafts.length,
      worldSettingsCreated: 1,
      outlinesCreated: 1,
      firstChapterId,
      summary: `已整理 ${files.length} 个文件，生成 ${chapters.length} 个章节、${characterDrafts.length} 个人物条目、世界观和大纲。`,
      artifacts,
    };
  }
}

function normalizeFiles(files: ImportNovelFile[] | undefined): NormalizedFile[] {
  if (!Array.isArray(files)) {
    throw ServiceError.validation('files 必须为数组。');
  }
  if (files.length > MAX_FILES) {
    throw ServiceError.validation(`单次最多导入 ${MAX_FILES} 个文本文件。`);
  }

  const normalized: NormalizedFile[] = [];
  for (const file of files) {
    if (
      typeof file !== 'object' ||
      file === null ||
      typeof file.path !== 'string' ||
      typeof file.content !== 'string'
    ) {
      throw ServiceError.validation('每个导入文件都必须包含 path 和 content 字符串。');
    }
    const path = file.path.trim();
    const ext = extensionOf(path).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      continue;
    }
    const content = stripReasoningArtifacts(file.content);
    if (path.length > 0 && content.length > 0) {
      normalized.push({ path, content });
    }
  }
  return normalized.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN', { numeric: true }));
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot) : '';
}

function inferSourceName(path: string): string {
  const file = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  return file.replace(/\.[^.]+$/, '') || '导入小说';
}

function cleanTitle(value: string, fallback: string): string {
  const compact = stripReasoningArtifacts(value).replace(/\s+/g, ' ').trim();
  return Array.from(compact || fallback || '导入小说').slice(0, 32).join('');
}

function extractMarkdownSections(text: string, keywords: string[]): string[] {
  const headings = Array.from(text.matchAll(/^(#{1,6})\s+(.+)$/gm));
  const sections: string[] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i]!;
    const title = heading[2].trim();
    if (!keywords.some((keyword) => title.includes(keyword))) {
      continue;
    }
    const start = heading.index ?? 0;
    const end = headings[i + 1]?.index ?? text.length;
    sections.push(text.slice(start, end).trim());
  }
  return sections;
}

function buildWorldContent(text: string, sourceName: string): string {
  const sections = extractMarkdownSections(text, [
    '世界观',
    '背景',
    '设定',
    '规则',
    '势力',
    '地点',
    '时间线',
  ]);
  if (sections.length > 0) {
    return stripReasoningArtifacts(sections.slice(0, 5).join('\n\n'));
  }

  const seed = text.replace(/^# .+$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 1600);
  return [
    `# ${sourceName}世界观整理`,
    '',
    '## 自动摘要',
    seed || '导入文本暂未提供足够的世界观信息。',
    '',
    '## 待补全',
    '- 核心规则',
    '- 主要地点',
    '- 势力关系',
    '- 时间线',
  ].join('\n');
}

function inferCharacters(text: string): CharacterDraft[] {
  const sections = extractMarkdownSections(text, ['人物', '角色', '主角', '配角']);
  const source = sections.length > 0 ? sections.join('\n') : text;
  const byName = new Map<string, string>();

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s+/, '');
    const match = line.match(/^(.{2,16}?)(?:\s*[：:,-]\s+|\s*[：:]\s*)(.{4,})$/u);
    if (!match) continue;
    const name = sanitizeName(match[1]);
    const desc = match[2].trim();
    if (name && !isNonCharacterHeading(name) && desc.length > 0) {
      byName.set(name, desc);
    }
  }

  if (byName.size === 0) {
    const counts = new Map<string, number>();
    for (const match of text.matchAll(/([一-龥]{2,4})(?:说|问|道|喊|想|看|笑|沉默)/g)) {
      const name = sanitizeName(match[1]);
      if (name && !isNonCharacterHeading(name)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_CHARACTERS)
      .forEach(([name, count]) => {
        byName.set(name, `从导入正文自动识别；出现 ${count} 次，需继续补充身份、动机、关系和口吻。`);
      });
  }

  if (byName.size === 0) {
    byName.set('主要人物线索', '导入文本未稳定拆分出人物名单；请在此条目中补充主角、配角、动机和关系。');
  }

  return [...byName.entries()].slice(0, MAX_CHARACTERS).map(([name, description]) => ({
    name,
    description,
  }));
}

function sanitizeName(value: string): string {
  const cleaned = value
    .replace(/^[#*\s《「『【\[]+/, '')
    .replace(/[》」』】\]]+$/, '')
    .trim();
  if (cleaned.length < 2 || cleaned.length > 16) return '';
  return cleaned;
}

function isNonCharacterHeading(value: string): boolean {
  return /^(世界观|人物|角色|大纲|章节|背景|设定|时间线|正文|导入整理)/.test(value);
}

function buildOutlineContent(files: NormalizedFile[], text: string, sourceName: string): string {
  const chapterTitles = inferChapterTitles(text);
  const lines = chapterTitles.length > 0
    ? chapterTitles.map((title, index) => `${index + 1}. ${title}`)
    : files.map((file, index) => `${index + 1}. ${inferSourceName(file.path)}`);

  return [
    `# ${sourceName}大纲整理`,
    '',
    '## 章节目录',
    ...lines,
    '',
    '## 导入来源',
    ...files.map((file) => `- ${file.path}`),
  ].join('\n');
}

function inferChapters(files: NormalizedFile[], sourceName: string): ChapterDraft[] {
  if (files.length === 1) {
    const split = splitChapters(files[0]!.content);
    if (split.length > 1) {
      return split;
    }
  }

  return files.map((file, index) => ({
    title: cleanTitle(inferSourceName(file.path), `${sourceName} ${index + 1}`),
    content: stripReasoningArtifacts(file.content),
  }));
}

function inferChapterTitles(text: string): string[] {
  return Array.from(text.matchAll(/^(?:#{1,4}\s*)?(第[零〇一二三四五六七八九十百千万\d]+[章节卷幕回][^\n]*)$/gmu))
    .map((match) => match[1].trim())
    .slice(0, MAX_CHAPTERS);
}

function splitChapters(text: string): ChapterDraft[] {
  const matches = Array.from(
    text.matchAll(/^(?:#{1,4}\s*)?(第[零〇一二三四五六七八九十百千万\d]+[章节卷幕回][^\n]*)$/gmu),
  );
  if (matches.length === 0) return [];

  const chapters: ChapterDraft[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const start = match.index ?? 0;
    const nextStart = matches[i + 1]?.index ?? text.length;
    const raw = text.slice(start, nextStart);
    const title = cleanTitle(match[1], `章节 ${i + 1}`);
    const content = raw.replace(match[0], '').trim();
    if (content.length > 0) {
      chapters.push({ title, content: stripReasoningArtifacts(content) });
    }
  }
  return chapters;
}
