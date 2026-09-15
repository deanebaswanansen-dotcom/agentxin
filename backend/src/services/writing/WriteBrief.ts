import { createHash } from 'node:crypto';

import type { WriteBrief, WriteBriefInput, WriteBriefSourceKind } from '../../types/WriteBrief.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => [key, canonical(record[key])]));
}

export function hashWriteBriefValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'null', 'utf8').digest('hex');
}

export function writeBriefSourceKey(kind: WriteBriefSourceKind, id: string): string {
  return `${kind}:${id}`;
}

/** Both adapters use this factory so displayed instructions and saved provenance agree. */
export function createWriteBrief(input: WriteBriefInput): WriteBrief {
  const kinds = new Set(['plan', 'outline', 'character', 'world', 'chapter', 'episode', 'continuity', 'author_constraints', 'blueprint', 'collection', 'request']);
  if (!input || (input.mode !== 'novel' && input.mode !== 'short_drama') ||
      typeof input.projectId !== 'string' || !input.target ||
      typeof input.target.id !== 'string' || typeof input.target.title !== 'string' ||
      ![input.objective, input.required, input.forbidden, input.authorConstraints, input.sources].every(Array.isArray)) {
    throw new Error('写前依据格式无效。');
  }
  const snapshot = structuredClone({
    mode: input.mode, projectId: input.projectId, target: input.target,
    objective: input.objective, required: input.required, forbidden: input.forbidden,
    authorConstraints: input.authorConstraints, sources: input.sources,
    ...(input.memoryContext ? { memoryContext: input.memoryContext } : {}),
  });
  if (snapshot.memoryContext) {
    const { text, statistics } = snapshot.memoryContext;
    if (typeof text !== 'string' || !statistics || typeof statistics.truncated !== 'boolean' ||
        !['maxChars', 'usedChars', 'estimatedTokens', 'requiredChars', 'sourceChars', 'authorChars', 'threadChars', 'retrievalChars', 'omittedItems']
          .every((key) => Number.isSafeInteger(statistics[key as keyof typeof statistics]) && Number(statistics[key as keyof typeof statistics]) >= 0) ||
        statistics.maxChars > 16000 || statistics.usedChars !== text.length || text.length > statistics.maxChars) {
      throw new Error('写前记忆预算或内容无效。');
    }
  }
  snapshot.sources.sort((a, b) => a.key.localeCompare(b.key));
  const sourceKeys = new Set<string>();
  for (const source of snapshot.sources) {
    if (!source || !kinds.has(source.kind) || typeof source.id !== 'string' || !source.id ||
        source.key !== writeBriefSourceKey(source.kind, source.id) || typeof source.label !== 'string' || !source.label.trim() ||
        typeof source.contentHash !== 'string' || !/^[a-f\d]{64}$/u.test(source.contentHash) ||
        (source.excerpt !== undefined && typeof source.excerpt !== 'string') ||
        (source.revision !== undefined && (!Number.isInteger(source.revision) || source.revision < 0)) ||
        (source.unitNumber !== undefined && (!Number.isInteger(source.unitNumber) || source.unitNumber < 1))) {
      throw new Error('写前依据包含无效来源。');
    }
    if (['chapter', 'episode', 'continuity'].includes(source.kind) &&
        source.unitNumber !== undefined && source.unitNumber >= snapshot.target.unitNumber) {
      throw new Error('写前依据不能把本章或后续正文作为已发生事实。');
    }
    if (sourceKeys.has(source.key)) throw new Error('写前依据包含重复来源标识。');
    sourceKeys.add(source.key);
  }
  if (!snapshot.projectId || !snapshot.target.id || !Number.isInteger(snapshot.target.unitNumber) || snapshot.target.unitNumber < 1 ||
      !Number.isInteger(snapshot.target.revision) || snapshot.target.revision < 0 || !snapshot.objective.length) {
    throw new Error('写前依据缺少目标或正文版本。');
  }
  for (const items of [snapshot.objective, snapshot.required, snapshot.forbidden, snapshot.authorConstraints]) {
    for (const item of items) {
      if (!item || typeof item.text !== 'string' || !item.text.trim() || !Array.isArray(item.sourceKeys) ||
          !item.sourceKeys.length || item.sourceKeys.some((key) => !sourceKeys.has(key))) {
        throw new Error('写前依据的条目缺少可定位来源。');
      }
      item.sourceKeys = [...new Set(item.sourceKeys)].sort();
    }
  }
  const sourceFingerprint = hashWriteBriefValue({
    schemaVersion: 1, mode: snapshot.mode, projectId: snapshot.projectId,
    targetId: snapshot.target.id, unitNumber: snapshot.target.unitNumber,
    sources: snapshot.sources,
  });
  const value = { schemaVersion: 1 as const, ...snapshot, sourceFingerprint };
  return { ...value, fingerprint: hashWriteBriefValue(value) };
}

/** Render the same frozen instructions without exposing storage hashes to the model. */
export function renderWriteBrief(brief: WriteBrief): string {
  const unit = brief.mode === 'novel' ? '章' : '集';
  const sections = [
    ['本次目标', brief.objective], ['必须承接', brief.required],
    ['明确禁项', brief.forbidden], ['作者约束', brief.authorConstraints],
  ] as const;
  const sources = new Map(brief.sources.map((source) => [source.key, source.label]));
  const historyKinds = new Set(['chapter', 'episode', 'continuity']);
  const referenceKinds = new Set(['character', 'world', 'outline', 'plan']);
  const references = brief.sources.filter((source) => source.excerpt?.trim() &&
    (!brief.memoryContext || !historyKinds.has(source.kind)) &&
    (historyKinds.has(source.kind) || referenceKinds.has(source.kind)))
    .sort((a, b) => Number(historyKinds.has(b.kind)) - Number(historyKinds.has(a.kind)) ||
      (b.unitNumber ?? 0) - (a.unitNumber ?? 0) || a.key.localeCompare(b.key));
  // Sources remain fully versioned; supporting excerpts have a fixed budget.
  // Required instructions above are never silently truncated by this budget.
  let remaining = 6000;
  const excerpts: string[] = [];
  for (const source of references) {
    const category = historyKinds.has(source.kind) ? '此前正文与交接参考' :
      source.kind === 'outline' || source.kind === 'plan' ? '剧情安排（尚未发生的部分不是事实）' : '设定参考';
    const prefix = `- ${category} · ${source.label}：`;
    const body = source.excerpt!.slice(0, Math.min(500, remaining - prefix.length - 1));
    if (remaining <= prefix.length + 1 || !body) break;
    const line = prefix + body;
    excerpts.push(line);
    remaining -= line.length + 1;
  }
  return [
    `第${brief.target.unitNumber}${unit}写前任务书：${brief.target.title}`,
    `已发生的事实仅来自第${brief.target.unitNumber}${unit}之前的有效内容；大纲中的后续安排不等于已经发生。`,
    ...sections.flatMap(([label, items]) => items.length ? [label, ...items.map((item) =>
      `- ${item.text}（依据：${item.sourceKeys.map((key) => sources.get(key)).join('、')}）`,
    )] : []),
    ...(brief.memoryContext?.text ? ['故事记忆与历史证据', brief.memoryContext.text] : []),
    ...(excerpts.length ? ['来源摘录（节选）', ...excerpts] : []),
  ].join('\n');
}
