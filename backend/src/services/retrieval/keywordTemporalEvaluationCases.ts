import type { AcceptedMemoryEntry, AcceptedMemoryInput } from '../../types/SourceMemory.js';
import { createFrozenMemoryProjection, hashSourceMemoryBlocks } from '../memory/sourceMemoryContract.js';

/** One continuing story with deliberately overlapping names and changing state. */
export function temporalEvaluationFixture() {
  function unit(id: string, unitNumber: number, title: string, text: string,
    entry?: Omit<AcceptedMemoryEntry, 'evidence'>, revision = 1): AcceptedMemoryInput {
    const blocks = [{ id: `body-${id}`, text }];
    return { schemaVersion: 1, source: { clientId: 'local', projectId: 'project', mode: 'novel', resourceId: id,
      unitNumber, revision, acceptanceId: `${id}-r${revision}`, contentHash: hashSourceMemoryBlocks(blocks) }, title,
    acceptedAt: '2026-09-15T00:00:00.000Z', blocks, entries: entry ? [{ ...entry,
      evidence: [{ blockId: blocks[0]!.id, start: text.indexOf(entry.text), end: text.indexOf(entry.text) + entry.text.length, quote: entry.text }] }] : [] };
  }
  const first = unit('chapter-01', 1, '第一章 北岸巡夜',
    '队长林青守在北岸码头。临行前，他答应等风季过去，替小澄修好那架断弦木琴。',
    { id: 'captain-location-1', kind: 'state', entity: 'person-linqing-captain', key: 'location', action: 'set', value: '北岸码头', text: '队长林青守在北岸码头。' });
  const doctor = unit('chapter-02', 2, '第二章 诊室灯火', '医师林青留在南巷诊室。她将药箱交给学徒，再三嘱咐不要与北岸那位同名队长弄混。',
    { id: 'doctor-location-2', kind: 'state', entity: 'person-linqing-doctor', key: 'location', action: 'set', value: '南巷诊室', text: '医师林青留在南巷诊室。' });
  const promise = unit('chapter-03', 3, '第三章 巷口约定', '石匠在巷口向孩子们许诺：等城门重新开放，就在学堂后院种三棵杏树。');
  const planted = unit('chapter-04', 4, '第四章 银铃悬案', '钟楼银铃失窃，守钟人决定查清银铃的去向。',
    { id: 'silver-bell-open', kind: 'thread', entity: 'thread-silver-bell', key: 'thread', action: 'open', value: 'planted', text: '钟楼银铃失窃，守钟人决定查清银铃的去向。' });
  const holder = unit('chapter-05', 5, '第五章 仓库托付', '蓝铜钥匙由甲保管。甲把钥匙系在腰带上，答应在交接前寸步不离。',
    { id: 'key-holder-5', kind: 'state', entity: 'prop:key-blue', key: 'holder', action: 'set', value: '甲', text: '蓝铜钥匙由甲保管。' });
  const withdrawn = unit('chapter-06', 6, '第六章 目击旧稿', '目击者说赤隼密令藏在红船船底。',
    { id: 'witness-old', kind: 'fact', text: '目击者说赤隼密令藏在红船船底。' });
  const corrected = unit('chapter-06', 6, '第六章 目击修订', '目击者确认账册在蓝船驾驶舱，之前的红船口供已经撤回。',
    { id: 'witness-corrected', kind: 'fact', text: '目击者确认账册在蓝船驾驶舱，之前的红船口供已经撤回。' }, 2);
  const middle = unit('chapter-07', 7, '第七章 大雨滞城', '雨把城门外的道路冲断。小澄抱着木琴坐在台阶上，没人谈起钟楼。');
  const moved = unit('chapter-08', 8, '第八章 西门换防', '队长林青改驻西门岗楼。南巷诊室的医师林青没有随队转移。',
    { id: 'captain-location-8', kind: 'state', entity: 'person-linqing-captain', key: 'location', action: 'set', value: '西门岗楼', text: '队长林青改驻西门岗楼。' });
  const distraction = unit('chapter-09', 9, '第九章 铜铃误认', '商贩在桥头展示一只普通铜铃，守钟人摇头说那不是遗失的银铃。');
  const transferred = unit('chapter-10', 10, '第十章 正式交接', '甲将蓝铜钥匙交给乙，从现在起由乙保管。乙签下仓库交接簿。',
    { id: 'key-holder-10', kind: 'state', entity: 'prop:key-blue', key: 'holder', action: 'set', value: '乙', text: '甲将蓝铜钥匙交给乙，从现在起由乙保管。' });
  const resolved = unit('chapter-11', 11, '第十一章 银铃归位', '失窃的银铃已找回并挂回钟楼，银铃悬案就此结案。',
    { id: 'silver-bell-close', kind: 'thread', entity: 'thread-silver-bell', key: 'thread', action: 'close', value: 'resolved', text: '失窃的银铃已找回并挂回钟楼，银铃悬案就此结案。' });
  const payoff = unit('chapter-12', 12, '第十二章 木琴重响', '队长带回修好的木琴，小澄试着弹出一小段旋律。后院的杏树还没有种下。');
  const future = unit('chapter-13', 13, '第十三章 尚未来到', '玄鲸密钥藏在冰原石窟。');
  const projection = createFrozenMemoryProjection({ clientId: 'local', projectId: 'project', mode: 'novel', revision: 2,
    acceptances: [first, doctor, promise, planted, holder, corrected, middle, moved, distraction, transferred, resolved, payoff, future] });
  return { projection, withdrawn, aliases: { 'person-linqing-captain': ['林青', '老槐'], 'person-linqing-doctor': ['林青', '白棠'] } };
}

interface TemporalEvaluationCase {
  id: string;
  category: 'same_name_id' | 'alias' | 'old_promise' | 'transfer' | 'thread_closure' | 'withdrawal' | 'isolation';
  query: string;
  beforeUnit: number;
  expectedSource?: string;
  expectedKind?: AcceptedMemoryEntry['kind'] | 'body';
  expectedText?: string;
  expectedAcceptance?: string;
  rejectScope?: 'client' | 'project';
}

/** Expected source AND kind are fixed ahead of retrieval; body hits cannot satisfy a state query. */
export const KEYWORD_TEMPORAL_EVALUATION_CASES: readonly TemporalEvaluationCase[] = [
  { id: 'captain-id-before-move', category: 'same_name_id', query: 'person-linqing-captain', beforeUnit: 3, expectedSource: 'chapter-01', expectedKind: 'state' },
  { id: 'doctor-id-same-name', category: 'same_name_id', query: 'person-linqing-doctor', beforeUnit: 3, expectedSource: 'chapter-02', expectedKind: 'state' },
  { id: 'captain-alias', category: 'alias', query: '老槐', beforeUnit: 3, expectedSource: 'chapter-01', expectedKind: 'state' },
  { id: 'doctor-alias', category: 'alias', query: '白棠', beforeUnit: 3, expectedSource: 'chapter-02', expectedKind: 'state' },
  { id: 'captain-name-place', category: 'same_name_id', query: '林青守在哪里的码头？', beforeUnit: 3, expectedSource: 'chapter-01', expectedKind: 'state' },
  { id: 'doctor-name-place', category: 'same_name_id', query: '医师林青留在哪个诊室？', beforeUnit: 3, expectedSource: 'chapter-02', expectedKind: 'state' },
  { id: 'distant-music-promise', category: 'old_promise', query: '数章前谁答应修好断弦木琴？', beforeUnit: 12, expectedSource: 'chapter-01', expectedKind: 'body' },
  { id: 'distant-tree-promise', category: 'old_promise', query: '巷口许诺何时在学堂后院种杏树？', beforeUnit: 12, expectedSource: 'chapter-03', expectedKind: 'body' },
  { id: 'key-before-transfer', category: 'transfer', query: '蓝铜钥匙由谁保管？', beforeUnit: 7, expectedSource: 'chapter-05', expectedKind: 'state', expectedText: '由甲保管' },
  { id: 'key-after-transfer', category: 'transfer', query: '蓝铜钥匙由谁保管？', beforeUnit: 11, expectedSource: 'chapter-10', expectedKind: 'state', expectedText: '由乙保管' },
  { id: 'key-id-before-transfer', category: 'transfer', query: 'prop:key-blue', beforeUnit: 7, expectedSource: 'chapter-05', expectedKind: 'state' },
  { id: 'key-id-after-transfer', category: 'transfer', query: 'prop:key-blue', beforeUnit: 11, expectedSource: 'chapter-10', expectedKind: 'state' },
  { id: 'thread-before-closure', category: 'thread_closure', query: 'thread-silver-bell', beforeUnit: 8, expectedSource: 'chapter-04', expectedKind: 'thread', expectedText: '决定查清' },
  { id: 'thread-after-closure', category: 'thread_closure', query: 'thread-silver-bell', beforeUnit: 12, expectedSource: 'chapter-11', expectedKind: 'thread', expectedText: '就此结案' },
  { id: 'captain-id-after-move', category: 'same_name_id', query: 'person-linqing-captain', beforeUnit: 10, expectedSource: 'chapter-08', expectedKind: 'state' },
  { id: 'corrected-witness', category: 'withdrawal', query: '目击者确认账册在什么船？', beforeUnit: 8, expectedSource: 'chapter-06', expectedKind: 'fact', expectedAcceptance: 'chapter-06-r2' },
  { id: 'withdrawn-unique-secret', category: 'withdrawal', query: '赤隼密令', beforeUnit: 12 },
  { id: 'future-unique-secret', category: 'isolation', query: '玄鲸密钥', beforeUnit: 13 },
  { id: 'foreign-client', category: 'isolation', query: '蓝铜钥匙', beforeUnit: 11, rejectScope: 'client' },
  { id: 'foreign-project', category: 'isolation', query: '蓝铜钥匙', beforeUnit: 11, rejectScope: 'project' },
];
