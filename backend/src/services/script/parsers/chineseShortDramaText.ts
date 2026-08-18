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
  | 'SCENE_EPISODE_NUMBER_REPAIRED'
  | 'SCENE_ORDINAL_REPAIRED'
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
const PRODUCTION_SCENE_HEADING = /^(\d+)\s*[-－—]\s*(\d+)\s+(日|夜|晨|清晨|黄昏|傍晚)\s+(内|外)\s+(.+)$/u;
const NUMBERED_SCENE_HEADING = /^第\s*(?:(\d+)\s*[-－—]\s*)?(\d+)\s*场\s*[：:]?\s*(.+?)\s+(日|夜|晨|清晨|黄昏|傍晚)\s*[/／]\s*(内|外)$/u;
const EPISODE_HEADING = /^第\s*(?:\d+|[零〇一二三四五六七八九十百千]+)\s*集(?:\s*[：:]?.*)?$/u;
const CHARACTER_LINE = /^人物\s*[：:]\s*(.*)$/u;
const CAPTION_LINE = /^(?:【\s*)?字幕\s*[：:]\s*(.*?)(?:\s*】)?$/u;
const FLASHBACK_LINE = /^【\s*(闪回|闪回结束|闪出)\s*】$/u;
const QUOTED_SCREEN_TEXT_LINE = /^(?:[“"])(.+?)(?:[”"])$/u;
const SHOT_ACTION_LINE = /^((?:【\s*(?:特写|近景|中景|远景|全景|空镜|俯拍|仰拍|航拍|跟拍|推镜|拉镜|摇镜|慢镜头|定格|蒙太奇|画面|镜头)\s*】.*|(?:特写|近景|中景|远景|全景|空镜|俯拍|仰拍|航拍|跟拍|推镜|拉镜|摇镜|慢镜头|定格|蒙太奇|画面|镜头)\s*[：:].+))$/u;
const ACTION_LINE = /^[△▲]\s*(.*)$/u;
const DIALOGUE_LINE = /^([^：:（）()]+?)(?:[（(]([^）)]*)[）)])?\s*[：:]\s*(.+)$/u;

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

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index]!.trim();
    if (!line || EPISODE_HEADING.test(line)) continue;
    if (/^```/u.test(line)) {
      warn(lineNumber, 'UNPARSED_LINE', '正文包含 Markdown 围栏。', line, true);
      continue;
    }

    const productionHeading = PRODUCTION_SCENE_HEADING.exec(line);
    const heading = SCENE_HEADING.exec(line);
    const numberedHeading = NUMBERED_SCENE_HEADING.exec(line);
    if (productionHeading || heading || numberedHeading) {
      const headingEpisode = productionHeading
        ? Number(productionHeading[1])
        : heading
        ? Number(heading[1])
        : numberedHeading![1]
          ? Number(numberedHeading![1])
          : options.episodeNumber;
      if (headingEpisode !== options.episodeNumber) {
        warn(
          lineNumber,
          'SCENE_EPISODE_NUMBER_REPAIRED',
          `场景头集号 ${headingEpisode} 已按当前第 ${options.episodeNumber} 集修正。`,
          line,
        );
      }
      const originalOrdinal = Number(
        productionHeading ? productionHeading[2] : heading ? heading[2] : numberedHeading![2],
      );
      let ordinal = originalOrdinal;
      while (usedSceneOrdinals.has(ordinal)) ordinal += 1;
      if (ordinal !== originalOrdinal) {
        warn(
          lineNumber,
          'SCENE_ORDINAL_REPAIRED',
          `重复场号 ${originalOrdinal} 已顺延为 ${ordinal}。`,
          line,
        );
      }
      usedSceneOrdinals.add(ordinal);
      currentScene = {
        id: options.createId(),
        ordinal,
        location: (productionHeading ? productionHeading[5] : heading ? heading[3] : numberedHeading![3])!.trim(),
        timeOfDay: timeOfDay((productionHeading ? productionHeading[3] : heading ? heading[4] : numberedHeading![4])!),
        interiorExterior: interiorExterior((productionHeading ? productionHeading[4] : heading ? heading[5] : numberedHeading![5])!),
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
