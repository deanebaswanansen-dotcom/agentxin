import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { PlanTurnMessage } from './chat/types.js';
import { ChatMessageView } from './ChatMessageView.js';

describe('ChatMessageView plan card', () => {
  it('renders the reusable structured Story Plan', () => {
    const message: PlanTurnMessage = {
      id: 'plan-1',
      role: 'assistant',
      kind: 'plan-turn',
      status: 'ready',
      round: 2,
      message: '方案已锁定。',
      brief: '执行 brief',
      planSummary: {
        title: '灰烬王冠',
        genre: '西方玄幻',
        storyPlan: {
          metadata: { title: '灰烬王冠', genre: '西方玄幻', targetLength: 30000 },
          premise: { oneSentence: '流亡骑士寻找吞噬记忆的王冠。', coreConflict: '记忆与权力冲突。' },
          protagonist: {
            identity: '流亡骑士',
            personality: ['克制'],
            motivation: '找回故乡真相',
            goal: '封印王冠',
            weakness: '拒绝信任同伴',
            growthArc: '从独行到承担共同命运',
          },
          world: {
            overview: '旧帝国覆灭后的阿斯塔大陆。',
            regions: [], countries: [], races: [], religions: [], factions: [], history: [],
          },
          powerSystem: {
            rules: ['施法消耗记忆'], levels: [], limitations: [], specialCases: [],
          },
          characters: [],
          factions: [],
          mainPlot: { beginning: '接下遗迹任务', development: '遭到教会追杀', climax: '争夺王冠', ending: '封印王冠' },
          subplots: [], characterArcs: [], volumes: [],
          foreshadowing: ['养父遗留的断剑'], mysteries: [],
          constraints: { mustInclude: [], mustAvoid: [] },
        },
      },
    };

    render(<ChatMessageView message={message} streaming={false} />);

    expect(screen.getByText('结构化 Story Plan')).toBeInTheDocument();
    expect(screen.getByText('记忆与权力冲突。')).toBeInTheDocument();
    expect(screen.getByText('旧帝国覆灭后的阿斯塔大陆。')).toBeInTheDocument();
    expect(screen.getByText('施法消耗记忆')).toBeInTheDocument();
  });
});
