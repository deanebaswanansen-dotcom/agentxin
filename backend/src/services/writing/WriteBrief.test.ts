import { describe, expect, it } from 'vitest';

import type { WriteBriefInput } from '../../types/WriteBrief.js';
import { createWriteBrief, hashWriteBriefValue, renderWriteBrief } from './WriteBrief.js';

function input(): WriteBriefInput {
  return {
    mode: 'novel', projectId: 'project-a', target: { id: 'chapter-7', unitNumber: 7, revision: 3, title: '账本' },
    objective: [{ text: '公开账本', sourceKeys: ['outline:1'] }],
    required: [{ text: '账本仍由林青持有', sourceKeys: ['chapter:5'] }],
    forbidden: [{ text: '不得提前揭露收信人', sourceKeys: ['outline:1'] }],
    authorConstraints: [],
    sources: [
      { key: 'outline:1', kind: 'outline', id: '1', label: '已保存大纲', contentHash: hashWriteBriefValue({ goal: '公开账本', secret: '收信人' }) },
      { key: 'chapter:5', kind: 'chapter', id: '5', label: '第5章：旧账', unitNumber: 5, revision: 2, contentHash: hashWriteBriefValue('林青接过账本') },
    ],
  };
}

describe('shared write brief provenance', () => {
  it('freezes the displayed instructions while unrelated input mutations cannot alter them', () => {
    const original = input();
    const brief = createWriteBrief(original);
    original.required[0]!.text = '原始输入后来被改写';
    original.sources.reverse();
    expect(renderWriteBrief(brief)).toContain('账本仍由林青持有（依据：第5章：旧账）');
    expect(renderWriteBrief(brief)).not.toContain('原始输入后来被改写');
    expect(createWriteBrief(brief)).toEqual(brief);
    expect(renderWriteBrief(brief)).not.toContain(brief.sourceFingerprint);
  });

  it('keeps dependency identity separate from target CAS and detects changed or added sources', () => {
    const original = createWriteBrief(input());
    const withNewRevision = createWriteBrief({ ...input(), target: { ...input().target, revision: 4 } });
    expect(withNewRevision.sourceFingerprint).toBe(original.sourceFingerprint);
    expect(withNewRevision.fingerprint).not.toBe(original.fingerprint);
    const added = input();
    added.sources.push({ key: 'character:new', kind: 'character', id: 'new', label: '新人物', contentHash: hashWriteBriefValue('不能持有账本') });
    expect(createWriteBrief(added).sourceFingerprint).not.toBe(original.sourceFingerprint);
    expect(createWriteBrief({ ...input(), projectId: 'project-b' }).sourceFingerprint).not.toBe(original.sourceFingerprint);
  });

  it('rejects facts with invented source references instead of displaying them as evidence', () => {
    const invalid = input();
    invalid.required[0]!.sourceKeys = ['chapter:future'];
    expect(() => createWriteBrief(invalid)).toThrow('可定位来源');
  });

  it('rejects malformed wire input and future narrative sources', () => {
    expect(() => createWriteBrief(null as unknown as WriteBriefInput)).toThrow('格式无效');
    const future = input();
    future.sources[1]!.unitNumber = 8;
    expect(() => createWriteBrief(future)).toThrow('后续正文');
    const forged = input();
    forged.sources[0]!.key = 'chapter:1';
    expect(() => createWriteBrief(forged)).toThrow('无效来源');
  });

  it('keeps mandatory instructions while bounding references and distinguishing plans from history', () => {
    const data = input();
    data.sources[0]!.excerpt = '计划在第十章转交账本';
    data.sources[1]!.excerpt = '第五章林青接过账本';
    for (let i = 0; i < 40; i++) data.sources.push({
      key: `character:c${i}`, id: `c${i}`, kind: 'character', label: `人物${i}`,
      contentHash: hashWriteBriefValue(i), excerpt: '设定'.repeat(400),
    });
    const rendered = renderWriteBrief(createWriteBrief(data));
    expect(rendered).toContain('不得提前揭露收信人');
    expect(rendered).toContain('此前正文与交接参考 · 第5章：旧账：第五章林青接过账本');
    expect(rendered.split('来源摘录（节选）\n')[1]!.length).toBeLessThanOrEqual(6000);
    const small = input();
    small.sources[0]!.excerpt = '计划在第十章转交账本';
    expect(renderWriteBrief(createWriteBrief(small))).toContain('剧情安排（尚未发生的部分不是事实）');
  });
});
