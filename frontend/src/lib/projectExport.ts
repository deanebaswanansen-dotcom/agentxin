import type { Chapter, Character, Outline, WorldSetting } from '../types/index.js';

export type ProjectExportFormat = 'markdown' | 'txt';

type ExportChapter = Pick<Chapter, 'title' | 'content' | 'position'>;

export interface ProjectExportResources {
  characters?: Array<Pick<Character, 'name' | 'description'>>;
  worldSettings?: Array<Pick<WorldSetting, 'title' | 'content'>>;
  outlines?: Array<Pick<Outline, 'title' | 'content' | 'position'>>;
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function orderedChapters(chapters: ExportChapter[]): ExportChapter[] {
  return [...chapters].sort((a, b) => a.position - b.position);
}

export function sanitizeDownloadName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_')
    .trim()
    .replace(/[ .]+$/g, '');
  if (cleaned.length === 0) return 'novel';
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(cleaned)
    ? `_${cleaned}`
    : cleaned;
}

/**
 * Keep object URLs alive long enough for Chromium to finish acquiring them.
 * Revoking synchronously after `click()` can leave downloads stuck as
 * `.crdownload`, especially for generated DOCX blobs.
 */
export const DOWNLOAD_URL_REVOKE_DELAY_MS = 60_000;

export function downloadBlobFile(
  blob: Blob,
  filename: string,
  revokeDelayMs = DOWNLOAD_URL_REVOKE_DELAY_MS,
): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('当前环境不支持浏览器文件下载。');
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = sanitizeDownloadName(filename);
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);

  try {
    anchor.click();
  } catch (error) {
    anchor.remove();
    URL.revokeObjectURL(url);
    throw error;
  }

  globalThis.setTimeout(() => anchor.remove(), 0);
  globalThis.setTimeout(() => URL.revokeObjectURL(url), Math.max(0, revokeDelayMs));
}

export function buildProjectTextExport(
  projectName: string,
  chapters: ExportChapter[],
  format: ProjectExportFormat,
  resources: ProjectExportResources = {},
): string {
  const ordered = orderedChapters(chapters);
  if (format === 'txt') {
    return [
      projectName,
      '',
      '【项目资料】',
      '',
      ...buildPlainResourceSections(resources),
      '【正文】',
      '',
      ...ordered.flatMap((chapter, index) => [
        `第 ${index + 1} 章 ${chapter.title}`,
        '',
        chapter.content.trim(),
        '',
      ]),
    ].join('\n');
  }
  return [
    `# ${projectName}`,
    '',
    '## 项目资料',
    '',
    ...buildMarkdownResourceSections(resources),
    '## 正文',
    '',
    ...ordered.flatMap((chapter, index) => [
      `## 第 ${index + 1} 章 ${chapter.title}`,
      '',
      chapter.content.trim(),
      '',
    ]),
  ].join('\n');
}

function buildPlainResourceSections(resources: ProjectExportResources): string[] {
  return [
    '【人物】',
    '',
    ...(resources.characters ?? []).flatMap((item) => [
      `人物：${item.name}`,
      item.description.trim() || '（无描述）',
      '',
    ]),
    '【世界观】',
    '',
    ...(resources.worldSettings ?? []).flatMap((item) => [
      `世界观：${item.title}`,
      item.content.trim() || '（无内容）',
      '',
    ]),
    '【大纲】',
    '',
    ...[...(resources.outlines ?? [])]
      .sort((a, b) => a.position - b.position)
      .flatMap((item) => [`大纲：${item.title}`, item.content.trim() || '（无内容）', '']),
  ];
}

function buildMarkdownResourceSections(resources: ProjectExportResources): string[] {
  return [
    '### 人物',
    '',
    ...(resources.characters ?? []).flatMap((item) => [
      `#### ${item.name}`,
      '',
      item.description.trim() || '（无描述）',
      '',
    ]),
    '### 世界观',
    '',
    ...(resources.worldSettings ?? []).flatMap((item) => [
      `#### ${item.title}`,
      '',
      item.content.trim() || '（无内容）',
      '',
    ]),
    '### 大纲',
    '',
    ...[...(resources.outlines ?? [])]
      .sort((a, b) => a.position - b.position)
      .flatMap((item) => [`#### ${item.title}`, '', item.content.trim() || '（无内容）', '']),
  ];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function textRun(text: string, opts: { bold?: boolean; size?: number } = {}): string {
  const runProps = opts.bold || opts.size
    ? `<w:rPr>${opts.bold ? '<w:b/>' : ''}${opts.size ? `<w:sz w:val="${opts.size}"/>` : ''}</w:rPr>`
    : '';
  return `<w:r>${runProps}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function paragraph(content = '', opts: { bold?: boolean; size?: number; align?: 'center' } = {}): string {
  const paragraphProps = opts.align ? `<w:pPr><w:jc w:val="${opts.align}"/></w:pPr>` : '';
  return `<w:p>${paragraphProps}${content.length === 0 ? '' : textRun(content, opts)}</w:p>`;
}

function pageBreak(): string {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function screenplayCharacterNames(lines: readonly string[]): string[] {
  const names: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('人物：')) continue;
    const matches = line.slice('人物：'.length).matchAll(
      /([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z·]{0,15})(?:（[^）]*）)?(?=\s|$)/gu,
    );
    for (const match of matches) if (match[1]) names.push(match[1]);
  }
  return [...new Set(names)];
}

function screenplayActionParagraph(line: string, characterNames: readonly string[]): string {
  const tokens = [
    '【[^】]+】',
    ...[...characterNames].sort((left, right) => right.length - left.length).map(escapedRegExp),
  ];
  const characterNameSet = new Set(characterNames);
  const matcher = new RegExp(`(${tokens.join('|')})`, 'gu');
  const runs = line.split(matcher).filter(Boolean).map((part) => textRun(part, {
    bold: /^【[^】]+】$/u.test(part) || characterNameSet.has(part),
  })).join('');
  return `<w:p>${runs}</w:p>`;
}

function contentParagraphs(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length === 0) return paragraph('');
  const characterNames = screenplayCharacterNames(lines);
  return lines.map((line) => (
    line.startsWith('△')
      ? screenplayActionParagraph(line, characterNames)
      : paragraph(line)
  )).join('');
}

function buildDocumentXml(
  projectName: string,
  chapters: ExportChapter[],
  resources: ProjectExportResources,
): string {
  const resourceXml = [
    paragraph('项目资料', { bold: true, size: 32 }),
    paragraph('人物', { bold: true, size: 28 }),
    ...(resources.characters ?? []).flatMap((item) => [
      paragraph(item.name, { bold: true, size: 24 }),
      contentParagraphs(item.description.trim() || '（无描述）'),
    ]),
    paragraph('世界观', { bold: true, size: 28 }),
    ...(resources.worldSettings ?? []).flatMap((item) => [
      paragraph(item.title, { bold: true, size: 24 }),
      contentParagraphs(item.content.trim() || '（无内容）'),
    ]),
    paragraph('大纲', { bold: true, size: 28 }),
    ...[...(resources.outlines ?? [])]
      .sort((a, b) => a.position - b.position)
      .flatMap((item) => [
        paragraph(item.title, { bold: true, size: 24 }),
        contentParagraphs(item.content.trim() || '（无内容）'),
      ]),
  ].join('');
  const chapterXml = orderedChapters(chapters)
    .map((chapter, index) => {
      const title = paragraph(`第 ${index + 1} 章 ${chapter.title}`, { bold: true, size: 28 });
      const body = contentParagraphs(chapter.content.trim() || '（空章节）');
      return `${index > 0 ? pageBreak() : ''}${title}${body}`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraph(projectName, { bold: true, size: 36, align: 'center' })}
    ${resourceXml}
    ${pageBreak()}
    ${paragraph('正文', { bold: true, size: 32 })}
    ${chapterXml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

const textEncoder = new TextEncoder();
let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable !== null) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, value, true);
  return bytes;
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, value >>> 0, true);
  return bytes;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function createStoredZip(entries: ZipEntry[]): Uint8Array {
  const fileParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.name);
    const crc = crc32(entry.data);
    const localHeader = concatBytes([
      uint32(0x04034b50),
      uint16(20),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(crc),
      uint32(entry.data.length),
      uint32(entry.data.length),
      uint16(nameBytes.length),
      uint16(0),
      nameBytes,
    ]);

    fileParts.push(localHeader, entry.data);

    centralParts.push(
      concatBytes([
        uint32(0x02014b50),
        uint16(20),
        uint16(20),
        uint16(0),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(crc),
        uint32(entry.data.length),
        uint32(entry.data.length),
        uint16(nameBytes.length),
        uint16(0),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(0),
        uint32(offset),
        nameBytes,
      ]),
    );

    offset += localHeader.length + entry.data.length;
  }

  const central = concatBytes(centralParts);
  const end = concatBytes([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(entries.length),
    uint16(entries.length),
    uint32(central.length),
    uint32(offset),
    uint16(0),
  ]);

  return concatBytes([...fileParts, central, end]);
}

function xmlEntry(name: string, xml: string): ZipEntry {
  return { name, data: textEncoder.encode(xml) };
}

export function buildProjectDocxBlob(
  projectName: string,
  chapters: ExportChapter[],
  resources: ProjectExportResources = {},
): Blob {
  const now = new Date().toISOString();
  const entries = [
    xmlEntry(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
    ),
    xmlEntry(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    ),
    xmlEntry('word/document.xml', buildDocumentXml(projectName, chapters, resources)),
    xmlEntry(
      'docProps/core.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(projectName)}</dc:title>
  <dc:creator>Novel Agent</dc:creator>
  <cp:lastModifiedBy>Novel Agent</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`,
    ),
    xmlEntry(
      'docProps/app.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Novel Agent</Application>
</Properties>`,
    ),
  ];

  return new Blob([createStoredZip(entries)], { type: DOCX_MIME });
}
