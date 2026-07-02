/**
 * 章节蓝图结构校验（纯逻辑）。
 *
 * 本模块提供两个纯函数（无 IO、无副作用，相同输入恒产生相同输出），是属性
 * 测试的核心对象（design.md「纯函数：蓝图结构校验 validateBlueprint」）：
 *
 * - {@link deviationRatio}：按需求 4.1 计算「所有场景 target_words 之和与章节
 *   target_words 之差的绝对值，除以章节 target_words」得到偏差比例。
 * - {@link validateBlueprint}：按需求 4.2–4.5 校验已解析蓝图的结构规则，任一
 *   规则被违反即抛出 {@link ServiceError.validation}（VALIDATION_ERROR）。
 *
 * 职责边界（务必遵守）：
 * - 本模块只做「结构规则」校验，不做字段存在性校验——后者是
 *   `parseBlueprintFromText` 的职责。调用方可假定传入的是字段齐全的
 *   {@link BlueprintCore}。
 * - 校验顺序刻意将「字数取值合法性（4.5）」放在「偏差比例计算（4.3）」之前，
 *   以保证 {@link deviationRatio} 的分母为正整数，避免除零或 NaN 参与比较
 *   （design.md：「先做字数取值合法性（4.5）再算偏差比例」）。
 */

import type { BlueprintCore } from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';

/** 场景数量允许范围下界（含），需求 4.2。 */
const MIN_SCENE_COUNT = 3;

/** 场景数量允许范围上界（含），需求 4.2。 */
const MAX_SCENE_COUNT = 7;

/**
 * 字数分配偏差比例阈值，需求 4.3。
 *
 * 判定为「严格大于」：偏差比例 > 0.1 才视为不合理；恰好等于 0.1 通过。
 */
const MAX_DEVIATION_RATIO = 0.1;

/**
 * 是否为正整数（严格大于 0 且为整数）。
 *
 * 用于章节与场景 target_words 的取值合法性判定（需求 4.5）。非有限值
 * （NaN/Infinity）与 0、负数、非整数一律视为非法。
 */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * 计算字数分配的偏差比例（需求 4.1）。
 *
 * 偏差比例 = |Σ场景 target_words − 章节 target_words| / 章节 target_words。
 *
 * 纯函数：仅依据入参计算，不读取或修改任何外部状态。
 *
 * 前置条件：`core.target_words` 应为正整数（由 {@link validateBlueprint} 在
 * 调用本函数前以 4.5 规则保证）。独立调用时若 `target_words` 为 0 会得到
 * 非有限结果，调用方需自行保证分母为正。
 */
export function deviationRatio(core: BlueprintCore): number {
  const sceneSum = core.scenes.reduce(
    (sum, scene) => sum + scene.target_words,
    0,
  );
  return Math.abs(sceneSum - core.target_words) / core.target_words;
}

/**
 * 校验章节蓝图的结构规则（需求 4.2–4.5）。
 *
 * 全部规则通过时返回 `void`；任一规则被违反时抛出
 * {@link ServiceError.validation}（错误码 VALIDATION_ERROR），消息指出违规原因。
 *
 * 校验顺序：
 * 1. 字数取值合法性（4.5）——章节及每个场景 target_words 均为正整数；先于偏差
 *    比例计算，避免除零/NaN。
 * 2. 场景数量范围（4.2）——场景数 ∈ [3, 7]。
 * 3. scene_id 唯一性（4.4）——不存在重复的 scene_id。
 * 4. 字数分配偏差（4.3）——偏差比例不得严格大于 0.1。
 */
export function validateBlueprint(core: BlueprintCore): void {
  // —— 规则 4.5：章节与每个场景 target_words 必须为正整数 ——
  // 置于偏差比例计算之前，保证分母（章节 target_words）为正整数。
  if (!isPositiveInteger(core.target_words)) {
    throw ServiceError.validation(
      `字数取值非法：章节 target_words 必须为正整数，当前为 ${core.target_words}`,
    );
  }
  for (const scene of core.scenes) {
    if (!isPositiveInteger(scene.target_words)) {
      throw ServiceError.validation(
        `字数取值非法：场景「${scene.scene_id}」的 target_words 必须为正整数，当前为 ${scene.target_words}`,
      );
    }
  }

  // —— 规则 4.2：场景数量必须在 [3, 7] 范围内 ——
  const sceneCount = core.scenes.length;
  if (sceneCount < MIN_SCENE_COUNT || sceneCount > MAX_SCENE_COUNT) {
    throw ServiceError.validation(
      `场景数量超出允许范围：应为 ${MIN_SCENE_COUNT}–${MAX_SCENE_COUNT} 个场景，当前为 ${sceneCount} 个`,
    );
  }

  // —— 规则 4.4：scene_id 不得重复 ——
  const seen = new Set<string>();
  for (const scene of core.scenes) {
    if (seen.has(scene.scene_id)) {
      throw ServiceError.validation(
        `场景标识符重复：scene_id「${scene.scene_id}」出现多次`,
      );
    }
    seen.add(scene.scene_id);
  }

  // —— 规则 4.3：字数分配偏差比例不得严格大于 0.1 ——
  const ratio = deviationRatio(core);
  if (ratio > MAX_DEVIATION_RATIO) {
    throw ServiceError.validation(
      `场景字数分配不合理：所有场景目标字数之和与章节目标字数的偏差比例为 ${ratio.toFixed(
        4,
      )}，超过允许上限 ${MAX_DEVIATION_RATIO}`,
    );
  }
}
