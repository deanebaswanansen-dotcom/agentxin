import type { NovelPlanAnswer, NovelPlanQuestion } from '../types/index.js';

export function formatPlanQuestionsForHistory(
  message: string,
  questions: NovelPlanQuestion[] | undefined,
): string {
  const lines = [message.trim()].filter(Boolean);
  for (const question of questions ?? []) {
    lines.push(
      `PLAN_QUESTION[${question.id}] score=${question.impactScore ?? '-'}: ${question.question}`,
    );
  }
  return lines.join('\n');
}

export function formatPlanAnswersForHistory(
  answers: NovelPlanAnswer[],
  questions: NovelPlanQuestion[],
): string {
  return answers
    .map((answer) => {
      const question = questions.find((item) => item.id === answer.questionId);
      const labels = answer.selectedOptionIds
        .map((id) => question?.options.find((option) => option.id === id)?.label ?? id)
        .join('、');
      const custom = answer.customText?.trim();
      const parts = [labels || null, custom ? `补充：${custom}` : null].filter(Boolean);
      const optionIds = answer.selectedOptionIds.join(',') || '-';
      return `- ${answer.questionId}: ${optionIds} | ${question?.question ?? answer.questionId} → ${parts.join('；') || '（跳过）'}`;
    })
    .join('\n');
}
