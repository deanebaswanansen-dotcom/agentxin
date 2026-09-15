import { ScriptModelOutputError } from './structuredOutput.js';
import type { StructuredGenerationError } from './generateStructured.js';

/** Model-only validation. Manual draft saves keep the canonical editing contract. */
export function modelStoryText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || /^(?:\{|\[)/u.test(text) || /```|<!doctype\b|<\/?(?:html|head|body|script)\b/iu.test(text)) return undefined;
  if (/当前草稿\s*[:：]|"(?:title|logline|coreConflict)"\s*:/u.test(text)) return undefined;
  return text;
}

/** Only the structured layer's sanitized provider category is safe to forward. */
export function scriptPlanningFailureMessage(kind: '选题' | '策划', error: StructuredGenerationError): string {
  const providerIssues = error.attempts.flatMap((attempt) => attempt.issues)
    .filter((issue) => issue.code === 'model.provider_error');
  const safeIssues = providerIssues.length ? providerIssues : error.issues.filter((issue) =>
    issue.code.startsWith('json.') || issue.code === 'story.required' ||
    issue.code === 'field.required' || issue.code === 'field.invalid',
  );
  const reason = [...new Set(safeIssues.map((issue) => issue.message))].slice(-2).join('；').slice(0, 500);
  return `AI ${kind}未生成有效故事${kind === '选题' ? '方案' : '内容'}，原策划已保留。${reason ? `${reason} ` : ''}请重试或手动编辑策划。`;
}

export function requireModelStoryText(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const text = modelStoryText(input[key]);
    if (text) return text;
  }
  throw new ScriptModelOutputError(`模型结果缺少有效故事字段 ${keys[0]}。`);
}
