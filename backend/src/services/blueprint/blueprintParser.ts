/**
 * 章节蓝图解析与序列化（纯逻辑）。
 *
 * 本模块提供两个纯函数（无 IO、无副作用，相同输入恒产生相同输出），是属性
 * 测试的核心对象（design.md「纯函数：蓝图解析 parseBlueprint / 蓝图序列化
 * serializeBlueprint」）：
 *
 * - {@link serializeBlueprint}：将 {@link BlueprintCore} 序列化为 JSON 文本
 *   （需求 3.2）。仅写出蓝图 schema 内的字段，字段顺序稳定。
 * - {@link parseBlueprintFromText}：从可能夹带额外说明文字的模型输出中提取
 *   首个「平衡的」JSON 对象并解析为 {@link BlueprintCore}（需求 3.1）。
 *     - 无法定位 / 解析合法 JSON → 抛出 {@link ServiceError.validation}
 *       （描述解析失败，需求 3.4）。
 *     - 缺少需求 2.3 的任一章节级字段或需求 2.4 的任一场景级字段（含基本类型
 *       不符）→ 抛出 {@link ServiceError.validation}（描述缺失字段，需求 3.5）。
 *
 * 二者构成往返保证（需求 3.3）：对任意合法蓝图 `core`，
 * `parseBlueprintFromText(serializeBlueprint(core))` 必成功，且产出对象的所有
 * 章节级与场景级字段值与 `core` 逐一相等。为此 {@link serializeBlueprint} 使用
 * 稳定字段集的 `JSON.stringify`，而 {@link parseBlueprintFromText} 仅保留 schema
 * 内字段（丢弃任何多余字段）。
 *
 * 职责边界（务必遵守）：
 * - 本模块只做「字段存在性 / 基本类型」校验，不做任何「结构合理性」校验——
 *   场景数量、字数偏差比例、scene_id 唯一性、字数正整数等结构规则是
 *   `validateBlueprint`（见同目录 blueprintValidator.ts）的职责，不在此重复。
 */

import type { BlueprintCore, Scene } from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';

/**
 * 章节级字符串字段名清单（需求 2.3）。这些字段必须存在且为 `string`。
 * `target_words`（number）、数组字段与 `scenes` 单独校验。
 */
const CHAPTER_STRING_FIELDS = [
  'chapter_id',
  'title',
  'main_goal',
  'tone',
  'pacing',
  'emotional_curve',
  'ending_hook',
] as const;

/**
 * 章节级字符串数组字段名清单（需求 2.3）。这些字段必须为 `string[]`。
 */
const CHAPTER_STRING_ARRAY_FIELDS = [
  'required_plot_points',
  'forbidden_points',
] as const;

/**
 * 场景级字符串字段名清单（需求 2.4）。这些字段必须存在且为 `string`。
 * `target_words`（number）与数组字段单独校验。
 */
const SCENE_STRING_FIELDS = [
  'scene_id',
  'name',
  'location',
  'purpose',
  'emotion',
  'pacing',
  'ending_state',
] as const;

/**
 * 场景级字符串数组字段名清单（需求 2.4）。这些字段必须为 `string[]`。
 */
const SCENE_STRING_ARRAY_FIELDS = ['characters', 'must_include'] as const;

/** 是否为「普通对象」（非 null、非数组的对象）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 是否为字符串数组（数组且每个元素均为 `string`）。 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * 从文本中提取「首个 `{` 到与之平衡的 `}`」之间的子串（含两端花括号）。
 *
 * 扫描策略（需求 3.1）：
 * - 从首个 `{` 起逐字符扫描，用计数器追踪花括号嵌套深度，深度归零处即为
 *   与首个 `{` 平衡的 `}`。
 * - 正确跳过字符串字面量内部的花括号：遇到未转义的 `"` 进入 / 退出字符串状态，
 *   字符串内的 `{`/`}` 不计入深度。
 * - 正确处理转义符：字符串内 `\` 之后的一个字符（含 `\"`）整体跳过。
 *
 * @returns 平衡的 JSON 对象子串；若不存在 `{` 或找不到与之平衡的 `}` 则返回
 *   `undefined`。
 */
function extractFirstBalancedJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      // 字符串字面量内部：仅关心转义与闭合引号，其余字符（含花括号）忽略。
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  // 扫描至文本末仍未闭合：不存在与首个 '{' 平衡的 '}'。
  return undefined;
}

/**
 * 收集单个场景对象的字段缺失 / 类型非法项（需求 2.4 / 3.5）。
 *
 * @param value 待校验的场景候选值（来自 JSON.parse 结果）。
 * @param index 场景在 `scenes` 数组中的下标，用于错误信息定位。
 * @param errors 错误项收集器，逐条追加 `scenes[i].field` 形式的描述。
 */
function collectSceneFieldErrors(
  value: unknown,
  index: number,
  errors: string[],
): void {
  const prefix = `scenes[${index}]`;

  if (!isPlainObject(value)) {
    errors.push(`${prefix}（应为对象）`);
    return;
  }

  for (const field of SCENE_STRING_FIELDS) {
    if (typeof value[field] !== 'string') {
      errors.push(`${prefix}.${field}`);
    }
  }

  if (typeof value.target_words !== 'number') {
    errors.push(`${prefix}.target_words`);
  }

  for (const field of SCENE_STRING_ARRAY_FIELDS) {
    if (!isStringArray(value[field])) {
      errors.push(`${prefix}.${field}`);
    }
  }
}

/**
 * 将一个已通过字段校验的场景候选对象重建为 {@link Scene}。
 *
 * 仅拷贝 schema 内字段（丢弃任何多余字段），保证序列化-解析往返后场景字段值
 * 与原对象逐一相等（需求 3.3）。调用前必须已通过 {@link collectSceneFieldErrors}
 * 校验，故此处可安全断言字段类型。
 */
function reconstructScene(value: Record<string, unknown>): Scene {
  return {
    scene_id: value.scene_id as string,
    name: value.name as string,
    target_words: value.target_words as number,
    location: value.location as string,
    characters: value.characters as string[],
    purpose: value.purpose as string,
    emotion: value.emotion as string,
    pacing: value.pacing as string,
    must_include: value.must_include as string[],
    ending_state: value.ending_state as string,
  };
}

/**
 * 将章节蓝图核心结构序列化为 JSON 文本（需求 3.2）。
 *
 * 纯函数：仅依据入参产生输出，不读取 / 修改任何外部状态。
 *
 * 实现要点：以稳定字段顺序重建一个仅含 schema 字段的普通对象再
 * `JSON.stringify`，从而丢弃任何多余字段并保证与 {@link parseBlueprintFromText}
 * 构成精确往返（需求 3.3）。
 */
export function serializeBlueprint(core: BlueprintCore): string {
  const normalized = {
    chapter_id: core.chapter_id,
    title: core.title,
    target_words: core.target_words,
    main_goal: core.main_goal,
    tone: core.tone,
    pacing: core.pacing,
    required_plot_points: core.required_plot_points,
    forbidden_points: core.forbidden_points,
    emotional_curve: core.emotional_curve,
    scenes: core.scenes.map((scene) => ({
      scene_id: scene.scene_id,
      name: scene.name,
      target_words: scene.target_words,
      location: scene.location,
      characters: scene.characters,
      purpose: scene.purpose,
      emotion: scene.emotion,
      pacing: scene.pacing,
      must_include: scene.must_include,
      ending_state: scene.ending_state,
    })),
    ending_hook: core.ending_hook,
  };

  return JSON.stringify(normalized, null, 2);
}

/**
 * 从可能夹带额外说明文字的文本中提取并解析章节蓝图（需求 3.1）。
 *
 * 纯函数：仅依据入参产生输出，不读取 / 修改任何外部状态。
 *
 * 流程：
 * 1. 用 {@link extractFirstBalancedJsonObject} 取出首个平衡 JSON 对象子串；
 *    取不到 → 抛出 VALIDATION_ERROR（需求 3.4）。
 * 2. `JSON.parse` 该子串；解析抛错或顶层非对象 → 抛出 VALIDATION_ERROR
 *    （需求 3.4）。
 * 3. 校验需求 2.3 / 2.4 的章节级与场景级字段「存在性 + 基本类型」；存在缺失 /
 *    类型非法 → 抛出 VALIDATION_ERROR 并列出问题字段（需求 3.5）。
 * 4. 仅保留 schema 内字段重建 {@link BlueprintCore} 返回（保证往返一致，需求 3.3）。
 *
 * 注意：本函数不做结构合理性校验（场景数 / 字数偏差 / scene_id 唯一性 /
 * 正整数等由 `validateBlueprint` 负责）。
 *
 * @throws {ServiceError} 错误码 `VALIDATION_ERROR`：无法定位 / 解析合法 JSON
 *   （需求 3.4），或缺少必需字段 / 字段类型非法（需求 3.5）。
 */
/**
 * 尝试修复 LLM 产出的「准 JSON」中最常见的不合法之处，便于二次解析。
 *
 * 大模型即便在 JSON 输出模式下，偶尔仍会在字符串值内部直接写入裸换行 / 回车 /
 * 制表符（JSON 规范要求转义为 `\n` / `\r` / `\t`），或在对象 / 数组末尾多写一个
 * 逗号。本函数只做两类保守、确定性的修复，不改变任何合法 JSON 的语义：
 *
 * 1. 字符串字面量内部的裸控制字符（U+0000–U+001F）转义为合法形式：换行→`\n`、
 *    回车→`\r`、制表→`\t`，其余控制字符→`\uXXXX`。逐字符扫描并跟踪「是否在字符串
 *    内」与转义状态，保证只动字符串内部、不误伤结构字符。
 * 2. 去除对象 `}` / 数组 `]` 之前的尾随逗号（仅在字符串外）。
 *
 * @returns 修复后的文本；对本就合法的 JSON 而言为等价文本。
 */
export function repairLooseJson(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const code = ch.charCodeAt(0);

    if (inString) {
      if (escaped) {
        // 上一个字符是反斜杠：原样保留这个被转义的字符。
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      // 字符串内部的裸控制字符 → 转义为合法 JSON 形式（修复 1）。
      if (code <= 0x1f) {
        if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        else out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += ch;
      continue;
    }

    // 字符串外部。
    if (ch === '"') {
      out += ch;
      inString = true;
      continue;
    }
    // 去除 } 或 ] 之前的尾随逗号（修复 2）：回溯跳过已写出的空白后若为逗号则删除。
    if (ch === '}' || ch === ']') {
      let j = out.length - 1;
      while (j >= 0 && (out[j] === ' ' || out[j] === '\n' || out[j] === '\r' || out[j] === '\t')) {
        j -= 1;
      }
      if (j >= 0 && out[j] === ',') {
        out = out.slice(0, j) + out.slice(j + 1);
      }
    }
    out += ch;
  }

  return out;
}

export function parseBlueprintFromText(text: string): BlueprintCore {
  const jsonText = extractFirstBalancedJsonObject(text);
  if (jsonText === undefined) {
    throw ServiceError.validation(
      '蓝图解析失败：未能在文本中定位到平衡的 JSON 对象（缺少 “{” 或与之匹配的 “}”）',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (firstError) {
    // 二次尝试：修复 LLM 常见的不合法之处（字符串内裸控制字符、尾随逗号）后再解析。
    // 模型即便在 JSON 模式下偶尔仍产出此类问题，修复可显著提升成功率而不改变合法语义。
    try {
      parsed = JSON.parse(repairLooseJson(jsonText));
    } catch {
      const reason =
        firstError instanceof Error ? firstError.message : String(firstError);
      throw ServiceError.validation(
        `蓝图解析失败：提取到的片段不是合法 JSON（${reason}）`,
      );
    }
  }

  if (!isPlainObject(parsed)) {
    throw ServiceError.validation('蓝图解析失败：JSON 顶层不是对象');
  }

  const errors: string[] = [];

  // —— 章节级字段（需求 2.3）：存在性 + 基本类型 ——
  for (const field of CHAPTER_STRING_FIELDS) {
    if (typeof parsed[field] !== 'string') {
      errors.push(field);
    }
  }
  if (typeof parsed.target_words !== 'number') {
    errors.push('target_words');
  }
  for (const field of CHAPTER_STRING_ARRAY_FIELDS) {
    if (!isStringArray(parsed[field])) {
      errors.push(field);
    }
  }

  // —— 场景级字段（需求 2.4）：scenes 必须为数组，逐个场景校验 ——
  const rawScenes = parsed.scenes;
  if (!Array.isArray(rawScenes)) {
    errors.push('scenes');
  } else {
    rawScenes.forEach((scene, index) => {
      collectSceneFieldErrors(scene, index, errors);
    });
  }

  if (errors.length > 0) {
    throw ServiceError.validation(
      `蓝图缺少必需字段或字段类型非法：${errors.join('、')}`,
    );
  }

  // 校验通过：仅保留 schema 内字段重建，丢弃多余字段（保证往返一致，需求 3.3）。
  return {
    chapter_id: parsed.chapter_id as string,
    title: parsed.title as string,
    target_words: parsed.target_words as number,
    main_goal: parsed.main_goal as string,
    tone: parsed.tone as string,
    pacing: parsed.pacing as string,
    required_plot_points: parsed.required_plot_points as string[],
    forbidden_points: parsed.forbidden_points as string[],
    emotional_curve: parsed.emotional_curve as string,
    scenes: (rawScenes as Record<string, unknown>[]).map(reconstructScene),
    ending_hook: parsed.ending_hook as string,
  };
}
