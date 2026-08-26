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
  | 'SCENE_HEADING_INFERRED'
  | 'SCENE_EPISODE_NUMBER_REPAIRED'
  | 'SCENE_ORDINAL_REPAIRED'
  | 'UNPARSED_LINE_PRESERVED'
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
const SCENE_HEADING_SPACED = /^(\d+)\s*[-－—]\s*(\d+)\s+(.+?)\s+(日|夜|晨|清晨|黄昏|傍晚)\s+(内|外)$/u;
const SCENE_HEADING_PAREN = /^(\d+)\s*[-－—]\s*(\d+)\s+(.+?)\s*[（(]\s*(日|夜|晨|清晨|黄昏|傍晚)\s*[/／]?\s*(内|外)\s*[）)]$/u;
const PRODUCTION_SCENE_HEADING = /^(\d+)\s*[-－—]\s*(\d+)\s+(日|夜|晨|清晨|黄昏|傍晚)\s+(内|外)\s+(.+)$/u;
const PRODUCTION_SCENE_HEADING_SLASH = /^(\d+)\s*[-－—]\s*(\d+)\s+(日|夜|晨|清晨|黄昏|傍晚)\s*[/／]\s*(内|外)\s+(.+)$/u;
const NUMBERED_SCENE_HEADING = /^第\s*(?:(\d+)\s*[-－—]\s*)?(\d+)\s*场\s*[：:]?\s*(.+?)\s+(日|夜|晨|清晨|黄昏|傍晚)\s*[/／]\s*(内|外)$/u;
const EPISODE_HEADING = /^第\s*(?:\d+|[零〇一二三四五六七八九十百千]+)\s*集(?:\s*[：:]?.*)?$/u;
const CHARACTER_LINE = /^人物\s*[：:]\s*(.*)$/u;
const CAPTION_LINE = /^(?:【\s*)?字幕\s*[：:]\s*(.*?)(?:\s*】)?$/u;
const FLASHBACK_LINE = /^【\s*(闪回|闪回结束|闪出)\s*】$/u;
const QUOTED_SCREEN_TEXT_LINE = /^(?:[“"])(.+?)(?:[”"])$/u;
const SHOT_ACTION_LINE = /^((?:【\s*(?:特写|近景|中景|远景|全景|空镜|俯拍|仰拍|航拍|跟拍|推镜|拉镜|摇镜|慢镜头|定格|蒙太奇|画面|镜头)\s*】.*|(?:特写|近景|中景|远景|全景|空镜|俯拍|仰拍|航拍|跟拍|推镜|拉镜|摇镜|慢镜头|定格|蒙太奇|画面|镜头)\s*[：:].+))$/u;
const ACTION_LINE = /^[△▲]\s*(.*)$/u;
const DIALOGUE_LINE = /^([^：:（）()]+?)(?:[（(]([^）)]*)[）)])?\s*[：:]\s*(.+)$/u;
const DEFAULT_SCENE_LOCATION = '未指定地点';

function dialogueSpeaker(value: string): { name: string; suffixMode?: 'OS' | 'VO' } {
  const match = /^(.*?)(OS|VO)$/iu.exec(value.trim());
  if (!match?.[1] || !match[2]) return { name: value.trim() };
  return { name: match[1].trim(), suffixMode: match[2].toUpperCase() as 'OS' | 'VO' };
}

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

interface ParsedSceneHeading {
  episodeNumber: number;
  originalOrdinal: number;
  location: string;
  timeOfDay: ScriptTimeOfDay;
  interiorExterior: ScriptInteriorExterior;
}

function matchSceneHeading(line: string, fallbackEpisode: number): ParsedSceneHeading | undefined {
  const productionSlash = PRODUCTION_SCENE_HEADING_SLASH.exec(line);
  if (productionSlash) {
    return {
      episodeNumber: Number(productionSlash[1]),
      originalOrdinal: Number(productionSlash[2]),
      timeOfDay: timeOfDay(productionSlash[3]!),
      interiorExterior: interiorExterior(productionSlash[4]!),
      location: productionSlash[5]!.trim(),
    };
  }
  const production = PRODUCTION_SCENE_HEADING.exec(line);
  if (production) {
    return {
      episodeNumber: Number(production[1]),
      originalOrdinal: Number(production[2]),
      timeOfDay: timeOfDay(production[3]!),
      interiorExterior: interiorExterior(production[4]!),
      location: production[5]!.trim(),
    };
  }
  const slash = SCENE_HEADING.exec(line);
  if (slash) {
    return {
      episodeNumber: Number(slash[1]),
      originalOrdinal: Number(slash[2]),
      location: slash[3]!.trim(),
      timeOfDay: timeOfDay(slash[4]!),
      interiorExterior: interiorExterior(slash[5]!),
    };
  }
  const spaced = SCENE_HEADING_SPACED.exec(line);
  if (spaced) {
    return {
      episodeNumber: Number(spaced[1]),
      originalOrdinal: Number(spaced[2]),
      location: spaced[3]!.trim(),
      timeOfDay: timeOfDay(spaced[4]!),
      interiorExterior: interiorExterior(spaced[5]!),
    };
  }
  const paren = SCENE_HEADING_PAREN.exec(line);
  if (paren) {
    return {
      episodeNumber: Number(paren[1]),
      originalOrdinal: Number(paren[2]),
      location: paren[3]!.trim(),
      timeOfDay: timeOfDay(paren[4]!),
      interiorExterior: interiorExterior(paren[5]!),
    };
  }
  const numbered = NUMBERED_SCENE_HEADING.exec(line);
  if (numbered) {
    return {
      episodeNumber: numbered[1] ? Number(numbered[1]) : fallbackEpisode,
      originalOrdinal: Number(numbered[2]),
      location: numbered[3]!.trim(),
      timeOfDay: timeOfDay(numbered[4]!),
      interiorExterior: interiorExterior(numbered[5]!),
    };
  }
  return undefined;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function castLabels(value: string): string[] {
  const labels: string[] = [];
  let current = '';
  let parenthesesDepth = 0;
  for (const character of value) {
    if (character === '（' || character === '(') parenthesesDepth += 1;
    if (character === '）' || character === ')') parenthesesDepth = Math.max(0, parenthesesDepth - 1);
    if (parenthesesDepth === 0 && /[、，,；;\s]/u.test(character)) {
      if (current.trim()) labels.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) labels.push(current.trim());
  return labels;
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
  const usedSceneOrdinals = new Set<number>();
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

  const createInferredScene = (lineNumber: number, source: string): ScriptScene => {
    let ordinal = scenes.length + 1;
    while (usedSceneOrdinals.has(ordinal)) ordinal += 1;
    usedSceneOrdinals.add(ordinal);
    const scene: ScriptScene = {
      id: options.createId(),
      ordinal,
      location: DEFAULT_SCENE_LOCATION,
      timeOfDay: 'day',
      interiorExterior: 'interior',
      characterIds: [],
      blocks: [],
    };
    scenes.push(scene);
    warn(
      lineNumber,
      'SCENE_HEADING_INFERRED',
      `未找到可用场景头，已自动归入第 ${ordinal} 场。`,
      source,
    );
    return scene;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index]!.trim();
    if (!line || EPISODE_HEADING.test(line)) continue;
    if (/^```/u.test(line)) {
      warn(lineNumber, 'UNPARSED_LINE', '已忽略正文中的 Markdown 围栏。', line);
      continue;
    }

    const heading = matchSceneHeading(line, options.episodeNumber);
    if (heading) {
      if (heading.episodeNumber !== options.episodeNumber) {
        warn(
          lineNumber,
          'SCENE_EPISODE_NUMBER_REPAIRED',
          `场景头集号 ${heading.episodeNumber} 不属于当前第 ${options.episodeNumber} 集，已按当前集号继续解析。`,
          line,
        );
      }
      let ordinal = heading.originalOrdinal;
      while (usedSceneOrdinals.has(ordinal)) ordinal += 1;
      if (ordinal !== heading.originalOrdinal) {
        warn(
          lineNumber,
          'SCENE_ORDINAL_REPAIRED',
          `重复场号 ${heading.originalOrdinal} 已顺延为 ${ordinal}。`,
          line,
        );
      }
      usedSceneOrdinals.add(ordinal);
      currentScene = {
        id: options.createId(),
        ordinal,
        location: heading.location,
        timeOfDay: heading.timeOfDay,
        interiorExterior: heading.interiorExterior,
        characterIds: [],
        blocks: [],
      };
      scenes.push(currentScene);
      continue;
    }

    if (!currentScene) {
      currentScene = createInferredScene(lineNumber, line);
    }

    const characterLine = CHARACTER_LINE.exec(line);
    if (characterLine) {
      const names = castLabels(characterLine[1]!);
      const ids: string[] = [];
      for (const name of names) {
        const lookupName = name.replace(/[（(][^）)]*[）)]$/u, '').trim();
        const character = characterByName.get(normalizedName(lookupName));
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

    const flashback = FLASHBACK_LINE.exec(line);
    if (flashback) {
      currentScene.blocks.push({
        id: options.createId(),
        type: 'caption',
        text: flashback[1]!,
      });
      continue;
    }

    const quotedScreenText = QUOTED_SCREEN_TEXT_LINE.exec(line);
    if (quotedScreenText) {
      currentScene.blocks.push({
        id: options.createId(),
        type: 'caption',
        text: quotedScreenText[1]!.trim(),
      });
      continue;
    }

    const shotAction = SHOT_ACTION_LINE.exec(line);
    if (shotAction) {
      currentScene.blocks.push({
        id: options.createId(),
        type: 'action',
        text: shotAction[1]!.trim(),
      });
      continue;
    }

    const action = ACTION_LINE.exec(line);
    if (action) {
      const actionText = action[1]!.trim();
      const embeddedDialogue = DIALOGUE_LINE.exec(actionText);
      const embeddedSpeaker = embeddedDialogue ? dialogueSpeaker(embeddedDialogue[1]!) : undefined;
      const embeddedCharacter = embeddedDialogue
        ? characterByName.get(normalizedName(embeddedSpeaker!.name))
        : undefined;
      if (embeddedDialogue && embeddedCharacter) {
        const mode = dialogueMode(embeddedDialogue[2] ?? embeddedSpeaker?.suffixMode);
        currentScene.blocks.push({
          id: options.createId(),
          type: 'dialogue',
          characterId: embeddedCharacter.id,
          speaker: embeddedCharacter.name,
          ...mode,
          text: embeddedDialogue[3]!.trim(),
        });
        if (
          mode.mode !== 'os' &&
          mode.mode !== 'vo' &&
          !currentScene.characterIds.includes(embeddedCharacter.id)
        ) {
          warn(
            lineNumber,
            'DIALOGUE_CHARACTER_NOT_IN_SCENE',
            `普通对白人物「${embeddedCharacter.name}」不在场景人物表。`,
            line,
          );
        }
        continue;
      }
      currentScene.blocks.push({
        id: options.createId(),
        type: 'action',
        text: actionText,
      });
      continue;
    }

    const dialogue = DIALOGUE_LINE.exec(line);
    if (dialogue) {
      const parsedSpeaker = dialogueSpeaker(dialogue[1]!);
      const speaker = parsedSpeaker.name;
      const character = characterByName.get(normalizedName(speaker));
      const mode = dialogueMode(dialogue[2] ?? parsedSpeaker.suffixMode);
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

    currentScene.blocks.push({
      id: options.createId(),
      type: 'action',
      text: line,
    });
    warn(
      lineNumber,
      'UNPARSED_LINE_PRESERVED',
      '未识别为标准格式，已按动作正文保留。',
      line,
    );
  }

  const nonEmptyScenes = scenes.filter((scene) => {
    if (scene.blocks.length === 0) {
      warn(0, 'EMPTY_SCENE', `第 ${scene.ordinal} 场没有正文。`, `${options.episodeNumber}-${scene.ordinal}`);
      return false;
    }
    return true;
  });
  nonEmptyScenes.forEach((scene, index) => {
    if (scene.ordinal !== index + 1) {
      warn(
        0,
        'SCENE_ORDINAL_REPAIRED',
        `移除空场后，场号 ${scene.ordinal} 已顺延为 ${index + 1}。`,
        `${options.episodeNumber}-${scene.ordinal}`,
      );
      scene.ordinal = index + 1;
    }
  });

  if (nonEmptyScenes.length === 0) return { warnings, unparsedLines };
  return {
    episode: {
      episodeNumber: options.episodeNumber,
      title: options.title,
      outlineId: options.outlineId,
      status: 'reviewing',
      targetChars: options.targetChars,
      scenes: nonEmptyScenes,
      summary: '',
      newFacts: [],
      openedThreads: [],
      closedThreads: [],
    },
    warnings,
    unparsedLines,
  };
}
