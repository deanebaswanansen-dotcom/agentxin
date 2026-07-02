/**
 * 场景排序与章节合并（纯逻辑）。
 *
 * 本模块提供两个纯函数（无 IO、无副作用，相同输入恒产生相同输出），是属性
 * 测试的核心对象（design.md「纯函数：场景排序与章节合并 compareSceneId /
 * mergeScenes」）：
 *
 * - {@link compareSceneId}：定义 scene_id 的「升序」全序比较口径，供按场景顺序
 *   生成 / 合并使用（需求 7.1）。
 * - {@link mergeScenes}：将各场景正文按 scene_id 升序以双换行拼接为整章正文
 *   （需求 7.3, 8.2）。
 *
 * 职责边界：本模块只做「排序 + 拼接」，不读取存储、不判断是否存在未写作场景
 * （后者由编排层 ChapterMerger 负责，见 design.md）。
 */

/** 场景之间的拼接分隔符：双换行（需求 8.2）。 */
const SCENE_SEPARATOR = '\n\n';

/**
 * scene_id 升序比较函数（需求 7.1, 8.2）。
 *
 * 排序口径：采用「自然 / 数值感知」的本地化比较（`localeCompare` 的
 * `numeric: true`）。其效果是把字符串中连续的数字按其数值大小而非逐字符的
 * 字典序比较，从而符合人的直觉：
 * - `"scene-2"` 排在 `"scene-10"` 之前（数值 2 < 10），而非字典序下的
 *   `"scene-10" < "scene-2"`。
 * - 非数字部分仍按本地化字典序比较（如 `"a-1"` 在 `"b-1"` 之前）。
 *
 * 该比较是一个全序：返回负数表示 `a` 在前，正数表示 `b` 在前，0 表示等价。
 * 结合 `Array.prototype.sort` 的稳定性，等价元素保持输入顺序（稳定排序）。
 *
 * 纯函数：仅依据入参产生输出，不读取 / 修改任何外部状态。
 */
export function compareSceneId(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'variant' });
}

/**
 * 按 scene_id 升序将各场景正文拼接为整章正文（需求 7.3, 8.2）。
 *
 * - 入参为 `{ scene_id, content }` 列表（顺序任意）；本函数先以
 *   {@link compareSceneId} 做稳定升序排序，再以双换行 `\n\n` 连接各场景 content。
 * - 空列表返回空字符串。
 *
 * 纯函数：仅依据入参产生输出，不读取存储、不修改入参数组（先复制再排序）。
 */
export function mergeScenes(
  orderedDrafts: ReadonlyArray<{ scene_id: string; content: string }>,
): string {
  return [...orderedDrafts]
    .sort((a, b) => compareSceneId(a.scene_id, b.scene_id))
    .map((draft) => draft.content)
    .join(SCENE_SEPARATOR);
}
