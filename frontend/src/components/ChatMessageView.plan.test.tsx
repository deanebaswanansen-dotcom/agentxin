import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PlanTurnMessage } from './chat/types.js';
import { ChatMessageView } from './ChatMessageView.js';

describe('ChatMessageView plan card', () => {
  it('requires every displayed planning question before normal submission', () => {
    const onPlanSubmit = vi.fn();
    const message: PlanTurnMessage = {
      id: 'plan-asking',
      role: 'assistant',
      kind: 'plan-turn',
      status: 'asking',
      round: 1,
      message: '请确认高影响参数。',
      questions: [
        {
          id: 'target_total_words',
          question: '全书目标总字数？',
          impactScore: 8,
          options: [{ id: 'total_100k', label: '约 10 万字' }],
        },
        {
          id: 'target_words_per_chapter',
          question: '每章目标字数？',
          impactScore: 8,
          options: [{ id: 'wpc_2500', label: '约 2500 字' }],
        },
      ],
    };

    render(<ChatMessageView message={message} streaming={false} onPlanSubmit={onPlanSubmit} />);

    const submit = screen.getByRole('button', { name: '回答全部问题，继续策划' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '约 10 万字' }));
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '约 2500 字' }));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onPlanSubmit).toHaveBeenCalledWith(
      'plan-asking',
      expect.arrayContaining([
        expect.objectContaining({ questionId: 'target_total_words' }),
        expect.objectContaining({ questionId: 'target_words_per_chapter' }),
      ]),
      false,
    );
  });

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

  it('shows the Agent self-checklist before its questions or final plan', () => {
    const message: PlanTurnMessage = {
      id: 'plan-checklist',
      role: 'assistant',
      kind: 'plan-turn',
      status: 'asking',
      round: 1,
      message: '先确认校园故事真正的分叉点。',
      planningChecklist: {
        confirmedFacts: ['题材是校园故事'],
        unresolvedDecisions: ['校园冲突类型'],
        safeDefaults: ['学校名称'],
        hardConstraints: ['不改成玄幻'],
      },
      questions: [],
    };

    render(<ChatMessageView message={message} streaming={false} />);

    expect(screen.getByText('Agent 自检清单')).toBeInTheDocument();
    expect(screen.getByText('校园冲突类型')).toBeInTheDocument();
    expect(screen.getByText('不改成玄幻')).toBeInTheDocument();
  });
});
