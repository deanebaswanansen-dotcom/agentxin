import { describe, expect, it } from 'vitest';
import type { AcceptedMemoryInput, FrozenMemoryProjection } from '../../types/SourceMemory.js';
import type { StoryControlCollection } from '../../types/StoryControl.js';
import { createFrozenMemoryProjection, hashSourceMemoryBlocks, projectSourceMemory } from '../memory/sourceMemoryContract.js';
import { searchAcceptedMemory } from './KeywordMemoryRetrieval.js';
import { KEYWORD_EVALUATION_CASES } from './keywordEvaluationCases.js';
import { KEYWORD_TEMPORAL_EVALUATION_CASES, temporalEvaluationFixture } from './keywordTemporalEvaluationCases.js';

function acceptance(id: string, unitNumber: number, text: string, clientId = 'local', entries = false): AcceptedMemoryInput {
  const blocks = [{ id: `block-${id}`, text }];
  return { schemaVersion: 1, source: { clientId, projectId: 'project', mode: 'novel', resourceId: id, unitNumber, revision: 1,
    acceptanceId: `accepted-${id}`, contentHash: hashSourceMemoryBlocks(blocks) }, title: id, blocks,
  acceptedAt: '2026-09-15T00:00:00.000Z', entries: entries ? [{ id: 'fact', kind: 'fact', text,
    evidence: [{ blockId: blocks[0]!.id, start: 0, end: text.length, quote: text }] }] : [] };
}
function frozen(acceptances: AcceptedMemoryInput[], clientId = 'local', revision = 1) {
  return createFrozenMemoryProjection({ clientId, projectId: 'project', mode: 'novel', revision, acceptances });
}
function search(projection: FrozenMemoryProjection, query: string, beforeUnit = 100) {
  return searchAcceptedMemory({ projection, view: projectSourceMemory(projection, beforeUnit), query, beforeUnit,
    clientId: 'local', projectId: 'project', mode: 'novel' });
}

describe('Chinese accepted-source keyword retrieval', () => {
  it('matches verified entity/property/thread metadata and aliases without pretending they are quotes', () => {
    const input = acceptance('identity', 1, '他答应守住这里。', 'local', true);
    input.entries[0] = { ...input.entries[0]!, kind: 'state', id: 'prop:jade-004:holder', entity: 'character-001', key: 'promise-007', value: '守住这里', action: 'set' };
    const projection = frozen([input]), view = projectSourceMemory(projection, 2);
    for (const query of ['character-001', 'prop:jade-004:holder', 'promise-007', '阿宁']) {
      const result = searchAcceptedMemory({ projection, view, query, beforeUnit: 2, clientId: 'local', projectId: 'project', mode: 'novel', entityAliases: { 'character-001': ['阿宁', '顾宁'] } });
      const hit = result.hits.find((candidate) => candidate.kind === 'state')!;
      expect(hit).toBeDefined(); expect(hit.matchedMetadata!.length).toBeGreaterThan(0);
      expect(hit.explanation).toContain('不作正文证据');
      expect(hit.evidence[0]!.quote).toBe('他答应守住这里。');
    }
  });

  it('returns active author matches separately without fabricating accepted provenance', () => {
    const controls: StoryControlCollection = { schemaVersion: 1, revision: 1, items: [
      { id: 'author-tone', revision: 1, kind: 'preference', text: '审讯对白必须保持克制', enabled: true, importance: 'required', fromUnit: 1, createdAt: '', updatedAt: '' },
      { id: 'future', revision: 1, kind: 'preference', text: '审讯对白很暴躁', enabled: true, importance: 'required', fromUnit: 5, createdAt: '', updatedAt: '' },
    ] };
    const projection = frozen([]), view = projectSourceMemory(projection, 2);
    const result = searchAcceptedMemory({ view, controls, query: '审讯对白', beforeUnit: 2, clientId: 'local', projectId: 'project', mode: 'novel' });
    expect(result.hits).toEqual([]);
    expect(result.authorMatches).toMatchObject([{ controlId: 'author-tone', origin: 'author' }]);
    expect(result.authorMatches![0]).not.toHaveProperty('source');
    expect(result.authorMatches![0]).not.toHaveProperty('evidence');
    expect(result.statistics.returnedChars).toBe(controls.items[0]!.text.length);
  });

  it('evaluates 30 fixed expected-source cases with real Top5, zero-recall, quote and timing measurements', () => {
    const projection = frozen(KEYWORD_EVALUATION_CASES.map(([id, , text], index) => acceptance(id, index + 1, text, 'local', index % 2 === 0)));
    let top5 = 0, zeroRecall = 0, badCitation = 0, scannedChars = 0, elapsedMs = 0;
    for (const [id, query] of KEYWORD_EVALUATION_CASES) {
      const result = search(projection, query);
      if (result.hits.some((hit) => hit.source.resourceId === id)) top5 += 1;
      else zeroRecall += 1;
      for (const hit of result.hits) for (const evidence of hit.evidence) {
        const block = projection.acceptances.find((input) => input.source.acceptanceId === hit.source.acceptanceId)!.blocks.find((item) => item.id === evidence.blockId)!;
        if (block.text.slice(evidence.start, evidence.end) !== evidence.quote) badCitation += 1;
      }
      scannedChars += result.statistics.scannedChars; elapsedMs += result.statistics.elapsedMs;
      expect(result.statistics.returnedChars).toBeLessThanOrEqual(result.statistics.maxContextChars);
    }
    const metrics = { cases: KEYWORD_EVALUATION_CASES.length, top5, top5Rate: top5 / KEYWORD_EVALUATION_CASES.length, zeroRecall, badCitation, scannedChars, elapsedMs };
    console.info('KEYWORD_RETRIEVAL_EVALUATION', JSON.stringify(metrics));
    expect(top5).toBe(30); expect(zeroRecall).toBe(0); expect(badCitation).toBe(0);
    expect(elapsedMs).toBeGreaterThan(0); expect(scannedChars).toBeGreaterThan(0);
  });

  it('never ranks future, withdrawn or foreign sources', () => {
    const old = acceptance('withdrawn', 1, '胶卷藏在旧仓库。', 'local', true);
    const current = acceptance('current', 2, '胶卷藏在新书房。');
    const future = acceptance('future', 10, '胶卷藏在明天的新地址。');
    const projection = frozen([current, future], 'local', 2);
    const view = projectSourceMemory(projection, 3);
    const staleView = projectSourceMemory(frozen([old]), 3);
    view.entries.push(...staleView.entries.map((entry) => ({ ...entry, status: 'stale' as const })));
    const result = searchAcceptedMemory({ projection, view, query: '胶卷', beforeUnit: 3, clientId: 'local', projectId: 'project', mode: 'novel' });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((hit) => hit.source.resourceId === 'current')).toBe(true);
    expect(result.statistics.eligibleSources).toBe(1);
    expect(search(projection, '明天', 3).hits).toEqual([]);
    const foreign = frozen([acceptance('foreign', 1, '胶卷', 'a'.repeat(64))], 'a'.repeat(64));
    expect(() => search(foreign, '胶卷')).toThrow();
    const withoutFuture = search(frozen([current], 'local', 2), '胶卷', 3);
    expect(result.hits).toEqual(withoutFuture.hits);
    expect(result.statistics.scannedChars).toBe(withoutFuture.statistics.scannedChars);
  });

  it('evaluates fixed multi-unit identity, promise, transfer, closure, withdrawal and isolation expectations', () => {
    const { projection, withdrawn, aliases } = temporalEvaluationFixture();
    let positiveCases = 0, top5 = 0, zeroRecall = 0, expectedEmpty = 0, scopeRejections = 0;
    let futureHits = 0, withdrawnHits = 0, foreignHits = 0, supersededStateHits = 0, badCitation = 0, scannedChars = 0, elapsedMs = 0;
    const categories: Record<string, number> = {};
    for (const item of KEYWORD_TEMPORAL_EVALUATION_CASES) {
      categories[item.category] = (categories[item.category] ?? 0) + 1;
      const view = projectSourceMemory(projection, item.beforeUnit);
      const activeIds = new Set(view.entries.filter((entry) => entry.kind === 'state' || entry.kind === 'thread')
        .map((entry) => `entry:${entry.source.acceptanceId}:${entry.id}`));
      // Simulate an obsolete cache entry alongside the current authoritative set.
      view.entries.push(...projectSourceMemory(frozen([withdrawn]), item.beforeUnit).entries.map((entry) => ({ ...entry, status: 'stale' as const })));
      const run = () => searchAcceptedMemory({ projection, view, query: item.query, beforeUnit: item.beforeUnit,
        clientId: item.rejectScope === 'client' ? 'b'.repeat(64) : 'local', projectId: item.rejectScope === 'project' ? 'another-project' : 'project',
        mode: 'novel', topK: 5, entityAliases: aliases });
      if (item.rejectScope) { expect(run, item.id).toThrow(); scopeRejections += 1; continue; }
      const result = run();
      if (item.expectedSource) {
        positiveCases += 1;
        const found = result.hits.some((hit) => hit.source.resourceId === item.expectedSource && hit.kind === item.expectedKind &&
          (!item.expectedText || hit.text.includes(item.expectedText)) && (!item.expectedAcceptance || hit.source.acceptanceId === item.expectedAcceptance));
        if (found) top5 += 1; else zeroRecall += 1;
        expect(found, `${item.id}: ${result.hits.map((hit) => `${hit.kind}/${hit.source.resourceId}`).join(', ')}`).toBe(true);
      } else { expect(result.hits, item.id).toEqual([]); expectedEmpty += 1; }
      for (const hit of result.hits) {
        if (hit.source.unitNumber >= item.beforeUnit) futureHits += 1;
        if (!projection.acceptances.some((acceptance) => acceptance.source.acceptanceId === hit.source.acceptanceId)) withdrawnHits += 1;
        if (hit.source.clientId !== 'local' || hit.source.projectId !== 'project') foreignHits += 1;
        if ((hit.kind === 'state' || hit.kind === 'thread') && !activeIds.has(hit.id)) supersededStateHits += 1;
        for (const evidence of hit.evidence) {
          const block = projection.acceptances.find((acceptance) => acceptance.source.acceptanceId === hit.source.acceptanceId)!
            .blocks.find((candidate) => candidate.id === evidence.blockId);
          if (!block || block.text.slice(evidence.start, evidence.end) !== evidence.quote) badCitation += 1;
        }
      }
      expect(result.statistics.topK).toBe(5);
      expect(result.statistics.returnedChars).toBeLessThanOrEqual(result.statistics.maxContextChars);
      scannedChars += result.statistics.scannedChars; elapsedMs += result.statistics.elapsedMs;
    }
    console.info('KEYWORD_TEMPORAL_EVALUATION', JSON.stringify({ cases: KEYWORD_TEMPORAL_EVALUATION_CASES.length, categories,
      positiveCases, top5, top5Rate: top5 / positiveCases, zeroRecall, expectedEmpty, scopeRejections,
      futureHits, withdrawnHits, foreignHits, supersededStateHits, badCitation, scannedChars, elapsedMs }));
    expect(top5).toBe(16); expect(zeroRecall).toBe(0); expect(expectedEmpty).toBe(2); expect(scopeRejections).toBe(2);
    expect({ futureHits, withdrawnHits, foreignHits, supersededStateHits, badCitation }).toEqual({ futureHits: 0, withdrawnHits: 0, foreignHits: 0, supersededStateHits: 0, badCitation: 0 });
  });

  it('labels superseded body excerpts as historical while state results use current effective events', () => {
    const a = acceptance('a', 1, '钥匙归甲持有。', 'local', true), b = acceptance('b', 2, '钥匙归乙持有。', 'local', true);
    for (const item of [a, b]) item.entries[0] = { ...item.entries[0]!, kind: 'state', entity: 'key', key: 'holder', value: item.source.resourceId, action: 'set' };
    const result = search(frozen([a, b]), '钥匙', 3);
    expect(result.hits.filter((hit) => hit.kind === 'state').map((hit) => hit.source.resourceId)).toEqual(['b']);
    expect(result.hits.find((hit) => hit.kind === 'body' && hit.source.resourceId === 'a')!.explanation).toContain('不代表当前状态');
  });

  it('retains unverified references and exact UTF-16 body positions separately', () => {
    const input = acceptance('emoji', 1, '🔑红伞藏在门口。', 'local', true);
    input.entries[0]!.evidence = [];
    const result = search(frozen([input]), '红伞');
    expect(result.hits.some((hit) => hit.kind === 'fact' && hit.evidenceStatus === 'unverified' && hit.evidence.length === 0)).toBe(true);
    expect(result.hits.find((hit) => hit.kind === 'body')!.evidence[0]).toMatchObject({ start: 0, end: input.blocks[0]!.text.length, quote: '🔑红伞藏在门口。' });
  });

  it('records actual scan/output budgets and returns an empty result for absent keywords', () => {
    const input = acceptance('large', 1, '红伞在这里。'.repeat(500));
    const projection = frozen([input]), view = projectSourceMemory(projection, 2);
    const result = searchAcceptedMemory({ projection, view, query: '红伞', beforeUnit: 2, clientId: 'local', projectId: 'project', mode: 'novel', maxScanChars: 1500, maxContextChars: 200 });
    expect(result.statistics.scanBudgetExhausted).toBe(true);
    expect(result.statistics.outputBudgetExhausted).toBe(true);
    expect(result.statistics.scannedChars).toBeLessThanOrEqual(1500);
    expect(result.statistics.returnedChars).toBeLessThanOrEqual(200);
    expect(search(projection, '航天发动机').hits).toEqual([]);
  });
});
