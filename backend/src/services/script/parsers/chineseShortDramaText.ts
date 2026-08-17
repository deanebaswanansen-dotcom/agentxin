import type {
  ScriptBlock,
  ScriptCharacter,
  ScriptEpisodeInput,
  ScriptInteriorExterior,
  ScriptScene,
  ScriptTimeOfDay,
} from '../domain.js';

export type ScriptTextParseWarningCode =
  | 'TEXT_BEFORE_FIRST_SCENE'
  | 'UNPARSED_LINE'
  | 'UNKNOWN_SCENE_CHARACTER'
  | 'UNKNOWN_DIALOGUE_CHARACTER'
  | 'DIALOGUE_CHARACTER_NOT_IN_SCENE'
  | 'EMPTY_SCENE';

export interface ScriptTextParseWarning {
  line: number;
  code: ScriptTextParseWarningCode;
  message: string;
  text: string;
}

export interface ScriptTextParserOptions {
  projectId: string;
  episodeNumber: number;
  title: string;
  outlineId: string;
  targetChars: number;
  characters: readonly ScriptCharacter[];
  createId: () => string;
}

export interface ScriptTextParseResult {
  episode?: ScriptEpisodeInput;
  warnings: ScriptTextParseWarning[];
  unparsedLines: Array<{ line: number; text: string }>;
}

const SCENE_HEADING = /^(\d+)\s*[-－—]\s*(\d+)\s+(.+?)\s+(日|夜|晨|清晨|黄昏|傍晚)\s*[/／]\s*(内|外)$/u;
const EPISODE_HEADING = /^第\s*(?:\d+|[零〇一二三四五六七八九十百千]+)\s*集(?:\s*[：:]?.*)?$/u;
const CHARACTER_LINE = /^人物\s*[：:]\s*(.*)$/u;
const CAPTION_LINE = /^【\s*字幕\s*[：:]\s*(.*?)\s*】$/u;
const ACTION_LINE = /^[△▲]\s*(.*)$/u;
const DIALOGUE_LINE = /^([^：:（）()]+?)(?:[（(]([^）)]*)[）)])?\s*[：:]\s*(.+)$/u;

function normalizedName(value: string): string {
  return value.normalize('NFKC').replace(/[\s·•]/gu, '').toLocaleLowerCase('zh-CN');
}

function timeOfDay(label: string): ScriptTimeOfDay {
  if (label === '夜') return 'night';
  if (label === '晨' || label === '清晨') return 'dawn';
  if (label === '黄昏' || label === '傍晚') return 'dusk';
  return 'day';
}

function interiorExterior(label: string): ScriptInteriorExterior {
  return label === '外' ? 'exterior' : 'interior';
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function dialogueMode(value: string | undefined): {
  delivery?: string;
  mode?: 'normal' | 'os' | 'vo';
} {
  const parenthetical = value?.trim();
  if (!parenthetical) return {};
  const normalized = parenthetical.toLocaleLowerCase('en-US');
  if (normalized === 'os' || normalized === '内心' || normalized === '独白') {
    return { mode: 'os' };
  }
  if (normalized === 'vo' || normalized === '画外音' || normalized === '电话音') {
    return { mode: 'vo' };
  }
  return { delivery: parenthetical };
}

/**
 * Parses the human-readable Chinese short-drama format produced by the direct
 * writer. IDs and canonical metadata always come from the server, never from
 * model text. Unknown non-empty lines are retained as warnings instead of being
 * silently discarded.
 */
export function parseChineseShortDramaText(
  rawText: string,
  options: ScriptTextParserOptions,
): ScriptTextParseResult {
  const warnings: ScriptTextParseWarning[] = [];
  const unparsedLines: Array<{ line: number; text: string }> = [];
  const characterByName = new Map<string, ScriptCharacter>();
  for (const character of options.characters) {
    for (const name of [character.name, ...character.aliases]) {
      const key = normalizedName(name);
      if (key && !characterByName.has(key)) characterByName.set(key, character);
    }
  }

  const scenes: ScriptScene[] = [];
  let currentScene: ScriptScene | undefined;
  const lines = rawText.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').split('\n');

  const warn = (
    line: number,
    code: ScriptTextParseWarningCode,
    message: string,
    text: string,
    unparsed = false,
  ): void => {
    warnings.push({ line, code, message, text });
    if (unparsed) unparsedLines.push({ line, text });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index]!.trim();
    if (!line || EPISODE_HEADING.test(line)) continue;
    if (/^```/u.test(line)) {
      warn(lineNumber, 'UNPARSED_LINE', '正文包含 Markdown 围栏。', line, true);
      continue;
    }

    const heading = SCENE_HEADING.exec(line);
    if (heading) {
      const headingEpisode = Number(heading[1]);
      if (headingEpisode !== options.episodeNumber) {
        warn(
          lineNumber,
          'UNPARSED_LINE',
          `场景头集号 ${headingEpisode} 与当前第 ${options.episodeNumber} 集不一致。`,
          line,
          true,
        );
        currentScene = undefined;
        continue;
      }
      currentScene = {
        id: options.createId(),
        ordinal: Number(heading[2]),
        location: heading[3]!.trim(),
        timeOfDay: timeOfDay(heading[4]!),
        interiorExterior: interiorExterior(heading[5]!),
        characterIds: [],
        blocks: [],
      };
      scenes.push(currentScene);
      continue;
    }

    if (!currentScene) {
      warn(lineNumber, 'TEXT_BEFORE_FIRST_SCENE', '首个场景头之前存在无法归属的正文。', line, true);
      continue;
    }

    const characterLine = CHARACTER_LINE.exec(line);
    if (characterLine) {
      const names = characterLine[1]!
        .split(/[、，,；;\s]+/u)
        .map((value) => value.trim())
        .filter(Boolean);
      const ids: string[] = [];
      for (const name of names) {
        const character = characterByName.get(normalizedName(name));
        if (character) ids.push(character.id);
        else warn(lineNumber, 'UNKNOWN_SCENE_CHARACTER', `场景人物「${name}」未登记。`, line);
      }
      currentScene.characterIds = unique(ids);
      continue;
    }

    const caption = CAPTION_LINE.exec(line);
    if (caption) {
      currentScene.blocks.push({
        id: options.createId(),
        type: 'caption',
        text: caption[1]!.trim(),
      });
      continue;
    }

    const action = ACTION_LINE.exec(line);
    if (action) {
      currentScene.blocks.push({
        id: options.createId(),
        type: 'action',
        text: action[1]!.trim(),
      });
      continue;
    }

    const dialogue = DIALOGUE_LINE.exec(line);
    if (dialogue) {
      const speaker = dialogue[1]!.trim();
      const character = characterByName.get(normalizedName(speaker));
      const mode = dialogueMode(dialogue[2]);
      const block: ScriptBlock = {
        id: options.createId(),
        type: 'dialogue',
        ...(character ? { characterId: character.id } : {}),
        speaker: character?.name ?? speaker,
        ...mode,
        text: dialogue[3]!.trim(),
      };
      currentScene.blocks.push(block);
      if (!character) {
        warn(lineNumber, 'UNKNOWN_DIALOGUE_CHARACTER', `对白人物「${speaker}」未登记。`, line);
      } else if (
        mode.mode !== 'os' &&
        mode.mode !== 'vo' &&
        !currentScene.characterIds.includes(character.id)
      ) {
        warn(
          lineNumber,
          'DIALOGUE_CHARACTER_NOT_IN_SCENE',
          `普通对白人物「${character.name}」不在场景人物表。`,
          line,
        );
      }
      continue;
    }

    warn(lineNumber, 'UNPARSED_LINE', '无法识别该剧本行。', line, true);
  }

  for (const scene of scenes) {
    if (scene.blocks.length === 0) {
      warn(0, 'EMPTY_SCENE', `第 ${scene.ordinal} 场没有正文。`, `${options.episodeNumber}-${scene.ordinal}`);
    }
  }

  if (scenes.length === 0) return { warnings, unparsedLines };
  return {
    episode: {
      episodeNumber: options.episodeNumber,
      title: options.title,
      outlineId: options.outlineId,
      status: 'reviewing',
      targetChars: options.targetChars,
      scenes,
      summary: '',
      newFacts: [],
      openedThreads: [],
      closedThreads: [],
    },
    warnings,
    unparsedLines,
  };
}
