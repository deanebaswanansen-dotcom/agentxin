/**
 * 文本采用逻辑（纯函数）。
 *
 * 当用户在对话会话中确认"采用"某段生成文本时，前端需要将该文本应用到章节
 * 编辑器的目标位置（需求 6.4）。本函数将该应用过程实现为一个无副作用的纯
 * 函数，便于独立做属性测试（设计文档 Property 21）。
 *
 * 语义（与 Property 21 一致）：
 * - insert 模式：在 `original` 的 `position` 索引处嵌入 `generated`，其余字符
 *   按原顺序保留。结果等于 `original.slice(0, position) + generated +
 *   original.slice(position)`。
 * - replace 模式：以 `generated` 替换半开区间 `[start, end)`，区间外的字符按
 *   原顺序保留。结果等于 `original.slice(0, start) + generated +
 *   original.slice(end)`。
 *
 * 边界处理：为保证函数为全函数（对任意输入都返回确定结果）且不依赖
 * `String.prototype.slice` 对负索引"从末尾计数"的特殊行为，本函数对位置参数
 * 进行钳制（clamp）：
 * - insert：`position` 钳制到 `[0, original.length]`。
 * - replace：`start` 钳制到 `[0, original.length]`；`end` 钳制到
 *   `[start, original.length]`（保证区间非逆序且不越界）。
 *
 * 该函数不修改任何入参，也不产生其他副作用。
 */

export type AdoptionTarget =
  | { mode: 'insert'; position: number }
  | { mode: 'replace'; start: number; end: number };

/**
 * 将数值钳制到闭区间 `[min, max]`；非有限数（NaN/Infinity）按 `min` 处理。
 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  // 向下取整，避免小数索引带来的歧义。
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function applyAdoption(
  original: string,
  generated: string,
  target: AdoptionTarget,
): string {
  const length = original.length;

  if (target.mode === 'insert') {
    const position = clamp(target.position, 0, length);
    return original.slice(0, position) + generated + original.slice(position);
  }

  // replace 模式：替换半开区间 [start, end)。
  const start = clamp(target.start, 0, length);
  const end = clamp(target.end, start, length);
  return original.slice(0, start) + generated + original.slice(end);
}

export default applyAdoption;
