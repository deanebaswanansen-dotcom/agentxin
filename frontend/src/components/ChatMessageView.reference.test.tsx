import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ReferenceResultMessage } from './chat/types.js';
import { ChatMessageView } from './ChatMessageView.js';

const message: ReferenceResultMessage = {
  id: 'result-1',
  role: 'assistant',
  kind: 'reference-result',
  message: '已完成内容拆解。',
  reference: {
    id: 'reference-1',
    title: '雾京夜渡',
    depth: 'standard',
    status: 'ready',
    chapterCount: 15,
    wordCount: 29935,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  },
  profile: {
    oneLineSummary: '顾停舟围绕无名渡灯追查临渊城被抹去的真相。',
    genreGuess: '东方奇幻悬疑',
    coreConflict: '顾停舟追查真相，与试图维持旧秩序的势力对抗。',
    mainPlotAbstract: '空灯出现后，顾停舟逐步揭开临渊城与无名者的秘密。',
    characters: [{
      name: '顾停舟',
      role: '主角',
      identity: '司灯署修灯匠',
      goal: '查明七三一号空灯的来源',
      motivation: '不愿无名死者被继续抹去',
      traits: ['执拗', '冷静'],
      arc: '从只修灯到主动追查制度真相',
      keyActions: ['检查空灯', '进入旧港'],
    }],
    relationships: [{
      from: '顾停舟',
      to: '罗敬',
      relation: '师徒与上下级',
      evolution: '从信任逐渐走向立场冲突',
    }],
    chapterCharacterOutfits: [{
      chapter: '第一章 空灯',
      characters: [{
        name: '顾停舟',
        outfit: '深灰色短褂，袖口沾着灯灰',
        evidence: '他掸去深灰短褂袖口的灯灰',
        certainty: 'explicit',
      }],
    }],
    conflicts: [{
      type: 'core',
      parties: ['顾停舟', '司灯署旧秩序'],
      description: '是否应揭开被制度抹去的死者真相。',
      stakes: '临渊城所有人的名字与记忆',
      progression: '空灯疑点逐渐升级为全城危机',
    }],
    payoffs: [{
      title: '空灯身份揭晓',
      setup: '七三一号灯的铭牌被反复磨去',
      trigger: '顾停舟进入灰档库',
      payoff: '他确认无名者被系统性抹去',
      impact: '个人调查升级为制度对抗',
      chapter: '第五章',
    }],
    worldbuilding: {
      premise: '死者记忆会被收进渡灯，雾会夺走人的名字。',
      rules: ['被雾叫出全名会失去影子'],
      factions: ['司灯署'],
      locations: ['临渊城', '白烬江'],
      systems: ['渡灯制度'],
      history: [],
      terminology: ['渡灯', '空灯'],
    },
    plotOutline: [{
      stage: '谜案开端',
      chapters: '第一至三章',
      summary: '顾停舟发现七三一号空灯并开始追查。',
      turningPoint: '无影者出现。',
    }],
    foreshadowing: [{
      setup: '空灯底部的编号七三一',
      payoff: '对应灰档库中被删除的记录',
      status: 'resolved',
    }],
    reversals: [{
      setup: '罗敬阻止顾停舟调查',
      reversal: '罗敬其实一直暗中保护证据',
      effect: '师徒冲突被重新解释',
      chapter: '第十二章',
    }],
    themes: ['名字与存在', '记忆与权力'],
    characterMethods: ['行动塑造'],
    worldbuildingDelivery: ['规则进入冲突'],
    style: {
      avgSentenceLength: 18,
      avgChapterWords: 1996,
      dialogueRatio: 0.23,
      descriptionRatio: 0.41,
      rhythmLabel: '中快',
      notes: ['平均章长约 1996 字'],
    },
    pacing: {
      avgChapterWords: 1996,
      shortChapterRatio: 0.2,
      longChapterRatio: 0.2,
      estimatedSmallConflictEveryN: 1,
      estimatedMajorPayoffEveryN: 4,
      notes: ['平均章长约 1996 字'],
    },
    transferableMethods: [],
    strengths: [],
    risks: [],
    doNotCopy: [],
    markdownReport: '# 小说内容拆解：雾京夜渡',
  },
};

describe('ChatMessageView reference breakdown', () => {
  it('shows original-story characters, conflicts, payoffs, worldbuilding, and outline as the primary result', () => {
    render(<ChatMessageView message={message} streaming={false} />);

    expect(screen.getByText('小说内容拆解')).toBeInTheDocument();
    expect(screen.getAllByText('顾停舟').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('冲突')).toBeInTheDocument();
    expect(screen.getByText('爽点与兑现')).toBeInTheDocument();
    expect(screen.getByText('世界观')).toBeInTheDocument();
    expect(screen.getByText('剧情大纲')).toBeInTheDocument();
    expect(screen.getByText('分章人物服装')).toBeInTheDocument();
    expect(screen.getByText(/已整理 1 章/)).toBeInTheDocument();
    expect(screen.getByText(/七三一号灯的铭牌/)).toBeInTheDocument();
    expect(screen.getByText('可选：只提炼写作方法到原创项目')).toBeInTheDocument();
  });
});
