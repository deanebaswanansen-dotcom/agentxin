/**
 * 字数统计与字数检查报告构建（纯逻辑）。
 *
 * 本模块提供两个纯函数（无 IO、无副作用，相同输入恒产生相同输出），是属性
 * 测试的核心对象（design.md「纯函数：字数统计 countActualWords 与报告构建
 * buildWordCountReport」）：
 *
 * - {@link countActualWords}：实际字数 = 去除全部空白字符后剩余字符数
 *   （术语表 ActualWordCount，需求 9.1）。
 * - {@link buildWordCountReport}：由蓝图核心结构 + 各场景正文映射构建字数检查
 *   报告的场景级与整章级统计（需求 9.1–9.3）。元数据（chapterId / generatedAt）
 *   由编排层注入，故本纯函数返回去除这两个字段的 {@link WordCountReport}。
 */

import type {
  BlueprintCore,
  SceneWordCount,
  WordCountReport,
} from '../../types/index.js';
import { mergeScenes } from './mergeScenes.js';

/**
 * 触发扩写建议的「不足比例」阈值（需求 9.3）。
 *
 * 不足比例 =（target_words − 实际字数）÷ target_words。判定为「达到或超过」：
 * 比例 ≥ 0.15 即触发扩写建议；实际字数达到或超过目标时不足比例为非正数，
 * 不触发。
 */
const EXPANSION_SHORTFALL_THRESHOLD = 0.15;

/**
 * 统计一段正文的实际字数（需求 9.1）。
 *
 * 实际字数 = 去除全部空白字符（含空格、制表符、换行、全角空白等所有 Unicode
 * 空白，由 `/\s/gu` 匹配）后剩余的字符数。以 `Array.from` 按 Unicode 码点计数，
 * 从而正确处理多字节字符与 emoji（如 "👨‍👩‍👧" 等以码点而非 UTF-16 码元计数）。
 *
 * 纯函数：仅依据入参产生输出，不读取 / 修改任何外部状态。
 */
export function countActualWords(text: string): number {
  const withoutWhitespace = text.replace(/\s/gu, '');
  return Array.from(withoutWhitespace).length;
}

/**
 * 由蓝图核心结构与各场景正文映射构建字数检查报告（需求 9.1–9.3）。
 *
 * 计算规则：
 * - 场景级（逐个 `core.scenes`）：
 *   - `actualWords`：该场景正文的实际字数；映射中无该场景正文时计为 0（需求 9.1）。
 *   - `delta`：`actualWords − targetWords`（需求 9.2）。
 *   - `needsExpansion`：不足比例（target − actual）/ target ≥ 0.15 时为 true（需求 9.3）。
 *   - `suggestedExpansion`：`needsExpansion` 时为 `max(0, target − actual)`，否则 0（需求 9.3）。
 * - 整章级：
 *   - `chapterActualWords`：所有场景正文按 scene_id 升序合并后的实际字数。
 *     （因合并分隔符为空白且统计时被剔除，其值等于各场景实际字数之和。）
 *   - `chapterTargetWords`：章节蓝图 target_words。
 *   - `chapterDelta`：`chapterActualWords − chapterTargetWords`（需求 9.2）。
 *
 * 元数据（`chapterId` / `generatedAt`）由编排层注入，故本纯函数返回去除这两个
 * 字段的报告结构。
 *
 * 纯函数：仅依据入参产生输出，不读取 / 修改任何外部状态。
 *
 * @param core 章节蓝图核心结构（提供场景列表与目标字数）。
 * @param draftsBySceneId scene_id → 场景正文 的映射；缺失的场景视为无正文（计 0）。
 */
export function buildWordCountReport(
  core: BlueprintCore,
  draftsBySceneId: ReadonlyMap<string, string>,
): Omit<WordCountReport, 'chapterId' | 'generatedAt'> {
  const scenes: SceneWordCount[] = core.scenes.map((scene) => {
    const content = draftsBySceneId.get(scene.scene_id);
    const targetWords = scene.target_words;
    // 无已持久化正文的场景，实际字数计为 0（需求 9.1）。
    const actualWords = content === undefined ? 0 : countActualWords(content);
    const delta = actualWords - targetWords;

    // 不足比例 =（target − actual）/ target；target 为正整数（由蓝图校验保证），
    // 此处对 target ≤ 0 做兜底以避免除零产生 NaN。
    const shortfallRatio =
      targetWords > 0 ? (targetWords - actualWords) / targetWords : 0;
    const needsExpansion = shortfallRatio >= EXPANSION_SHORTFALL_THRESHOLD;
    const suggestedExpansion = needsExpansion
      ? Math.max(0, targetWords - actualWords)
      : 0;

    return {
      sceneId: scene.scene_id,
      targetWords,
      actualWords,
      delta,
      needsExpansion,
      suggestedExpansion,
    };
  });

  // 整章实际字数 = 各场景正文按 scene_id 升序合并后的实际字数（需求 9.1）。
  const mergedContent = mergeScenes(
    core.scenes.map((scene) => ({
      scene_id: scene.scene_id,
      content: draftsBySceneId.get(scene.scene_id) ?? '',
    })),
  );
  const chapterActualWords = countActualWords(mergedContent);
  const chapterTargetWords = core.target_words;
  const chapterDelta = chapterActualWords - chapterTargetWords;

  return {
    scenes,
    chapterTargetWords,
    chapterActualWords,
    chapterDelta,
  };
}
