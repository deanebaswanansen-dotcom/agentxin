import type { MemoryEvidence } from '../types/storyMemory.js';

/** Translate the server's frozen paragraph-local UTF-16 offsets into editor offsets. */
export function locateNovelMemoryEvidence(content: string, evidence: MemoryEvidence): { start: number; end: number } | undefined {
  if (!Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) || evidence.start < 0 || evidence.end <= evidence.start) return undefined;
  const paragraph = /^paragraph-([1-9]\d*)$/u.exec(evidence.blockId);
  let block: string | undefined; let offset = 0;
  if (paragraph) {
    const blocks = content.split(/(?<=\n)/u);
    const index = Number(paragraph[1]) - 1;
    block = blocks[index];
    for (let before = 0; before < index && before < blocks.length; before += 1) offset += blocks[before].length;
  } else if (evidence.blockId === 'body') block = content;
  if (block === undefined || block.slice(evidence.start, evidence.end) !== evidence.quote || evidence.end > block.length) return undefined;
  return { start: offset + evidence.start, end: offset + evidence.end };
}
