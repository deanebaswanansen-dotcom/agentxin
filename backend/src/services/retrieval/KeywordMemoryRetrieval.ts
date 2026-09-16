import { performance } from 'node:perf_hooks';
import type { FrozenMemoryProjection, SourceMemoryMode, SourceMemoryView } from '../../types/SourceMemory.js';
import type { StoryMemorySearchHit, StoryMemorySearchResult } from '../../types/StoryMemoryWorkspace.js';
import type { StoryControlCollection } from '../../types/StoryControl.js';
import { activeStoryControls } from '../story/StoryControls.js';
import { buildStoryThreads } from '../memory/StoryThreads.js';
import { ServiceError } from '../ServiceError.js';
import { validateFrozenMemoryProjection } from '../memory/sourceMemoryContract.js';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const stopWords = new Set(['什么', '哪里', '如何', '为何', '为什么', '哪个', '哪些', '怎么', '是谁', '是否', '一个', '这个', '那个']);

/** Chinese words retain phrase precision; overlapping bigrams recover segmentation differences. */
export function keywordTerms(text: string): Map<string, number> {
  const normalized = text.normalize('NFKC').toLowerCase();
  const terms = new Map<string, number>();
  for (const part of segmenter.segment(normalized)) {
    const word = part.segment.trim();
    if (part.isWordLike && !stopWords.has(word) && (word.length > 1 || /^[a-z0-9]$/u.test(word))) terms.set(word, 2);
  }
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = [...run];
    for (let index = 0; index + 1 < chars.length; index += 1) {
      const gram = chars[index]! + chars[index + 1]!;
      if (!stopWords.has(gram) && !terms.has(gram)) terms.set(gram, 1);
    }
  }
  return terms;
}

export interface KeywordMemorySearchInput {
  projection?: FrozenMemoryProjection;
  view: SourceMemoryView;
  query: string;
  clientId: string;
  projectId: string;
  mode: SourceMemoryMode;
  beforeUnit: number;
  topK?: number;
  maxContextChars?: number;
  maxScanChars?: number;
  controls?: StoryControlCollection;
  /** Scoped canonical IDs/names; lookup metadata is never treated as quoted evidence. */
  entityAliases?: Record<string, readonly string[]>;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw ServiceError.validation('检索预算参数无效。');
  return value;
}

/** No network, vector approximation or unsourced legacy memory is consulted. */
export function searchAcceptedMemory(input: KeywordMemorySearchInput): StoryMemorySearchResult {
  const start = performance.now();
  const topK = bounded(input.topK, 5, 1, 20), maxContextChars = bounded(input.maxContextChars, 6000, 200, 20_000);
  const maxScanChars = bounded(input.maxScanChars, 400_000, 1000, 2_000_000);
  if (typeof input.query !== 'string' || input.query.length > 200 || !Number.isSafeInteger(input.beforeUnit) || input.beforeUnit < 1)
    throw ServiceError.validation('检索词最多200字，beforeUnit必须为正整数。');
  const query = input.query.trim();
  if (input.view.projectId !== input.projectId || input.view.mode !== input.mode || input.view.beforeUnit !== input.beforeUnit)
    throw ServiceError.conflict('检索视图与当前项目或时间边界不匹配。');
  const result: StoryMemorySearchResult = { query, method: 'keyword_zh_words_bigrams', hits: [], authorMatches: [], statistics: {
    elapsedMs: 0, eligibleSources: 0, scannedCandidates: 0, scannedChars: 0, matchedCandidates: 0,
    returnedChars: 0, topK, maxContextChars, maxScanChars, scanBudgetExhausted: false, outputBudgetExhausted: false,
  } };
  const finish = () => { result.statistics.elapsedMs = performance.now() - start; return result; };
  if (input.projection) {
    validateFrozenMemoryProjection(input.projection);
    if (input.projection.clientId !== input.clientId || input.projection.projectId !== input.projectId || input.projection.mode !== input.mode ||
        input.projection.revision !== input.view.projectionRevision) throw ServiceError.conflict('检索接受来源已过期或不属于当前客户端。');
  }
  // Filter before tokenization, ranking, counts and excerpts. Future input cannot affect scoring.
  const sources = (input.projection?.acceptances ?? []).filter((acceptance) => acceptance.source.unitNumber < input.beforeUnit);
  result.statistics.eligibleSources = sources.length;
  const sourceById = new Map(sources.map((acceptance) => [acceptance.source.acceptanceId, acceptance]));
  const queryTerms = keywordTerms(query);
  if (!query || queryTerms.size === 0) return finish();
  const candidates: Array<{ hit: StoryMemorySearchHit; terms: Map<string, number>; metadata: string[] }> = [];
  function add(hit: StoryMemorySearchHit, metadata: string[]): void {
    const chars = hit.text.length + metadata.join(' ').length;
    if (result.statistics.scannedChars + chars > maxScanChars) { result.statistics.scanBudgetExhausted = true; return; }
    result.statistics.scannedChars += chars; result.statistics.scannedCandidates += 1;
    candidates.push({ hit, terms: keywordTerms(`${hit.text} ${metadata.join(' ')}`), metadata });
  }
  for (const entry of [...input.view.entries, ...input.view.unverifiedReferences]) {
    const acceptance = sourceById.get(entry.source.acceptanceId);
    if (!acceptance || entry.status === 'stale' || entry.status === 'superseded' || entry.source.contentHash !== acceptance.source.contentHash ||
        entry.source.clientId !== input.clientId || entry.source.projectId !== input.projectId || entry.source.mode !== input.mode ||
        entry.source.resourceId !== acceptance.source.resourceId || entry.source.revision !== acceptance.source.revision ||
        entry.source.unitNumber !== acceptance.source.unitNumber) continue;
    add({ id: `entry:${entry.source.acceptanceId}:${entry.id}`, kind: entry.kind, text: entry.text, title: acceptance.title,
      source: structuredClone(entry.source), evidence: structuredClone(entry.evidence), evidenceStatus: entry.evidenceStatus,
      ...(entry.evidenceReason ? { evidenceReason: entry.evidenceReason } : {}), score: 0, matchedTerms: [], explanation: '' },
    [entry.id, entry.entity ?? '', entry.key ?? '', acceptance.title, ...(entry.entity ? input.entityAliases?.[entry.entity] ?? [] : [])]);
  }
  // Keep exact positions in the original UTF-16 block, including line breaks and emoji.
  for (const acceptance of sources) for (const block of acceptance.blocks) {
    for (let offset = 0; offset < block.text.length; offset += 1100) {
      const end = Math.min(block.text.length, offset + 1200);
      const text = block.text.slice(offset, end);
      if (!text.trim()) continue;
      add({ id: `body:${acceptance.source.acceptanceId}:${block.id}:${offset}`, kind: 'body', title: acceptance.title, text,
        source: structuredClone(acceptance.source), evidence: [{ blockId: block.id, start: offset, end, quote: text }],
        evidenceStatus: 'matched', score: 0, matchedTerms: [], explanation: '' }, [acceptance.title, acceptance.source.resourceId, block.id, block.sceneId ?? '']);
    }
  }
  const frequencies = new Map<string, number>();
  for (const term of queryTerms.keys()) frequencies.set(term, candidates.filter((candidate) => candidate.terms.has(term)).length);
  for (const candidate of candidates) {
    let score = 0;
    for (const [term, weight] of queryTerms) if (candidate.terms.has(term)) {
      const idf = Math.log(1 + (candidates.length - (frequencies.get(term) ?? 0) + 0.5) / ((frequencies.get(term) ?? 0) + 0.5));
      score += weight * idf; candidate.hit.matchedTerms.push(term);
    }
    const metadataMatches = candidate.metadata.filter((value) => value && (value.toLowerCase() === query.toLowerCase() ||
      [...keywordTerms(value).keys()].some((term) => queryTerms.has(term))));
    const exactId = candidate.metadata.some((value) => value === query);
    if (exactId) score += 20;
    if (!score) continue;
    const phrase = candidate.hit.text.normalize('NFKC').toLowerCase().includes(query.normalize('NFKC').toLowerCase());
    candidate.hit.score = score / (1 + Math.log(1 + candidate.hit.text.length / 180) * 0.15) + (phrase ? 3 : 0);
    if (metadataMatches.length) candidate.hit.matchedMetadata = metadataMatches;
    candidate.hit.explanation = `${phrase ? '完整词句命中；' : ''}命中关键词：${candidate.hit.matchedTerms.join('、')}。${metadataMatches.length ? `ID/名称等元数据命中：${metadataMatches.join('、')}（不作正文证据）。` : ''}${candidate.hit.kind === 'body' ? '已接受正文历史片段，引文位置匹配，不代表当前状态。' : candidate.hit.evidenceStatus === 'matched' ? '当前有效条目，引文位置匹配。' : '证据不足，仅供核对。'}`;
  }
  const ranked = candidates.map((candidate) => candidate.hit).filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || b.source.unitNumber - a.source.unitNumber || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const authors: NonNullable<StoryMemorySearchResult['authorMatches']> = [];
  const effectiveThreadControlIds = new Set(buildStoryThreads(input.view, input.controls ?? { schemaVersion: 1, revision: 0, items: [] },
    input.beforeUnit, sources.map((acceptance) => acceptance.source)).flatMap((thread) => thread.controlId ? [thread.controlId] : []));
  for (const control of activeStoryControls(input.controls, input.beforeUnit)) {
    if (control.kind === 'thread' && !effectiveThreadControlIds.has(control.id)) continue;
    if (control.source && (control.source.clientId !== input.clientId || control.source.projectId !== input.projectId || control.source.mode !== input.mode || control.source.unitNumber >= input.beforeUnit)) continue;
    const metadata = [control.id, control.thread?.threadId ?? '', control.thread?.title ?? ''].join(' ');
    if (result.statistics.scannedChars + control.text.length + metadata.length > maxScanChars) { result.statistics.scanBudgetExhausted = true; continue; }
    result.statistics.scannedChars += control.text.length + metadata.length; result.statistics.scannedCandidates += 1;
    const terms = keywordTerms(`${control.text} ${metadata}`), matchedTerms = [...queryTerms.keys()].filter((term) => terms.has(term));
    const score = matchedTerms.reduce((sum, term) => sum + (queryTerms.get(term) ?? 0), 0) + (control.id === query || control.thread?.threadId === query ? 20 : 0);
    if (score <= 0) continue;
    authors.push({ controlId: control.id, revision: control.revision, kind: control.kind, text: control.text, origin: 'author', score, matchedTerms,
      explanation: `作者主动记录命中：${matchedTerms.join('、')}；不是正文接受来源或正文证据。` });
  }
  const combined = [...ranked.map((hit) => ({ kind: 'accepted' as const, value: hit })), ...authors.map((author) => ({ kind: 'author' as const, value: author }))]
    .sort((a, b) => b.value.score - a.value.score);
  result.statistics.matchedCandidates = combined.length;
  for (const item of combined) {
    if (result.hits.length + result.authorMatches!.length >= topK) break;
    // Count both visible excerpts and quoted evidence. The same text repeated in the wire payload costs twice.
    const chars = item.value.text.length + (item.kind === 'accepted' ? item.value.evidence.reduce((total, evidence) => total + evidence.quote.length, 0) : 0);
    if (result.statistics.returnedChars + chars > maxContextChars) { result.statistics.outputBudgetExhausted = true; continue; }
    if (item.kind === 'accepted') result.hits.push(item.value); else result.authorMatches!.push(item.value);
    result.statistics.returnedChars += chars;
  }
  return finish();
}

export function renderRetrievedMemory(result: StoryMemorySearchResult, maxChars = 6000): string {
  const lines = result.hits.map((hit) => `- [${hit.kind === 'body' ? '历史正文' : hit.evidenceStatus === 'matched' ? '引文匹配' : '未核实参考'} / ${hit.title} / 单元${hit.source.unitNumber}] ${hit.text}`);
  return lines.join('\n').slice(0, Math.max(0, maxChars));
}
