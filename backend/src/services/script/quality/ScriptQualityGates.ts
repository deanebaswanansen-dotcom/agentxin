import type { ScriptEpisode, ScriptEpisodeOutline, ScriptPlan } from '../domain.js';

export type ScriptGateSeverity = 'hard' | 'soft';

export interface ScriptGateIssue {
  code: string;
  severity: ScriptGateSeverity;
  message: string;
  sceneId?: string;
  path?: string;
}

export interface ScriptGateOptions {
  expectedEpisodeNumber?: number;
  existingEpisodeNumbers?: readonly number[];
  registeredCharacterIds?: ReadonlySet<string>;
  registeredCharacterNames?: ReadonlySet<string>;
  temporarySpeakers?: ReadonlySet<string>;
  outline?: ScriptEpisodeOutline;
  reviewIssues?: readonly ScriptGateIssue[];
}

export interface ScriptGateReport {
  hardFailed: boolean;
  issues: ScriptGateIssue[];
  visibleChars: number;
  dialogueDensityPercent: number;
}

function normalizeDialogue(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]/gu, '');
}

function levenshteinSimilarity(left: string, right: string): number {
  if (left === right) return left.length === 0 ? 0 : 1;
  if (left.length === 0 || right.length === 0) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        (current[column - 1] ?? 0) + 1,
        (previous[column] ?? 0) + 1,
        (previous[column - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return 1 - (previous[right.length] ?? right.length) / Math.max(left.length, right.length);
}

export function validateScriptEpisode(
  episode: ScriptEpisode,
  plan: ScriptPlan,
  _options: ScriptGateOptions = {},
): ScriptGateReport {
  const issues: ScriptGateIssue[] = [];
  const blockTexts = episode.scenes.flatMap((scene) => scene.blocks.map((block) => block.text));
  const dialogueBlocks = episode.scenes.flatMap((scene) =>
    scene.blocks
      .filter((block) => block.type === 'dialogue')
      .map((block) => ({ sceneId: scene.id, text: block.text })),
  );
  const combinedText = blockTexts.join('\n');
  const visibleChars = blockTexts.join('').replace(/\s/gu, '').length;
  const dialogueChars = dialogueBlocks.reduce(
    (total, block) => total + block.text.replace(/\s/gu, '').length,
    0,
  );
  const dialogueDensityPercent = visibleChars === 0 ? 0 : Math.round((dialogueChars / visibleChars) * 100);
  const addHard = (code: string, message: string, path?: string, sceneId?: string): void => {
    issues.push({ code, severity: 'hard', message, path, sceneId });
  };
  if (
    _options.expectedEpisodeNumber !== undefined &&
    episode.episodeNumber !== _options.expectedEpisodeNumber
  ) {
    addHard(
      'EPISODE_NUMBER_MISMATCH',
      `模型返回第 ${episode.episodeNumber} 集，当前请求为第 ${_options.expectedEpisodeNumber} 集。`,
      'episodeNumber',
    );
  }
  if (_options.existingEpisodeNumbers?.includes(episode.episodeNumber)) {
    addHard('DUPLICATE_EPISODE_NUMBER', '同一项目已存在相同集号。', 'episodeNumber');
  }
  if (episode.scenes.length === 0) {
    addHard('NO_SCENES', '正文没有场景。', 'scenes');
  }
  if (episode.scenes.length > plan.maxScenesPerEpisode) {
    addHard(
      'TOO_MANY_SCENES',
      `场景数 ${episode.scenes.length} 超过上限 ${plan.maxScenesPerEpisode}。`,
      'scenes',
    );
  }
  const ordinals = new Set<number>();
  for (const scene of episode.scenes) {
    if (ordinals.has(scene.ordinal)) {
      addHard('DUPLICATE_SCENE_ORDINAL', `场号 ${scene.ordinal} 重复。`, 'ordinal', scene.id);
    }
    ordinals.add(scene.ordinal);
    if (!scene.location.trim()) addHard('MISSING_LOCATION', '场景缺少地点。', 'location', scene.id);
    if (!['day', 'night', 'dawn', 'dusk'].includes(scene.timeOfDay)) {
      addHard('MISSING_TIME', '场景缺少有效时间。', 'timeOfDay', scene.id);
    }
    if (!['interior', 'exterior'].includes(scene.interiorExterior)) {
      addHard('MISSING_INTERIOR_EXTERIOR', '场景缺少内外景。', 'interiorExterior', scene.id);
    }
    for (const block of scene.blocks) {
      if (block.type !== 'dialogue') continue;
      const speaker = block.speaker.trim();
      if (!speaker) {
        addHard('MISSING_SPEAKER', '对白缺少说话人。', 'speaker', scene.id);
        continue;
      }
      const knownById = Boolean(block.characterId && _options.registeredCharacterIds?.has(block.characterId));
      const knownByName = _options.registeredCharacterNames?.has(speaker) ?? false;
      const temporary = _options.temporarySpeakers?.has(speaker) ?? false;
      const registryProvided = Boolean(
        _options.registeredCharacterIds || _options.registeredCharacterNames || _options.temporarySpeakers,
      );
      if (registryProvided && !knownById && !knownByName && !temporary) {
        addHard('UNKNOWN_SPEAKER', `说话人「${speaker}」未登记。`, 'speaker', scene.id);
      }
    }
  }
  if (episode.scenes.length > 0 && visibleChars < Math.ceil(plan.targetCharsPerEpisode * 0.85)) {
    issues.push({
      code: 'TOO_SHORT',
      severity: 'hard',
      message: `可见字符 ${visibleChars}，低于目标的 85%。`,
      path: 'scenes',
    });
  }
  if (visibleChars > Math.floor(plan.targetCharsPerEpisode * 1.15)) {
    issues.push({
      code: 'TOO_LONG',
      severity: 'hard',
      message: `可见字符 ${visibleChars}，超过目标的 115%。`,
      path: 'scenes',
    });
  }
  if (/(?:```(?:json)?|<\/?(?:think|thinking|reasoning|analysis)>|\b(?:system|assistant)\s*prompt\b)/iu.test(combinedText)) {
    addHard('MODEL_ARTIFACT', '正文混入模型推理、JSON 围栏或系统提示。', 'scenes');
  }
  const forbidden = [...plan.forbiddenElements, ...(_options.outline?.forbiddenFacts ?? [])]
    .map((value) => value.trim())
    .filter(Boolean);
  const matchedForbidden = forbidden.find((value) => combinedText.includes(value));
  if (matchedForbidden) {
    addHard('FORBIDDEN_ELEMENT', `正文包含禁止内容：${matchedForbidden}`, 'scenes');
  }
  if (_options.outline && !_options.outline.conflict.trim()) {
    addHard('MISSING_KEY_EVENT', '本集关键冲突为空。', 'outline.conflict');
  }
  if (_options.outline && !_options.outline.endingHook.trim()) {
    addHard('MISSING_ENDING_HOOK', '本集结尾卡点为空。', 'outline.endingHook');
  }
  for (let leftIndex = 0; leftIndex < dialogueBlocks.length; leftIndex += 1) {
    const left = dialogueBlocks[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < dialogueBlocks.length; rightIndex += 1) {
      const right = dialogueBlocks[rightIndex];
      if (!right) continue;
      const leftText = normalizeDialogue(left.text);
      const rightText = normalizeDialogue(right.text);
      if (leftText.length >= 4 && levenshteinSimilarity(leftText, rightText) > 0.92) {
        issues.push({
          code: 'DUPLICATE_DIALOGUE',
          severity: 'soft',
          message: '两句对白高度重复。',
          sceneId: right.sceneId,
          path: 'blocks',
        });
      }
    }
  }
  if (Math.abs(dialogueDensityPercent - plan.dialogueDensityPercent) > 15) {
    issues.push({
      code: 'DIALOGUE_DENSITY',
      severity: 'soft',
      message: `对白密度 ${dialogueDensityPercent}% 与策划值 ${plan.dialogueDensityPercent}% 偏差超过 15 个百分点。`,
      path: 'scenes',
    });
  }
  if (_options.reviewIssues) issues.push(..._options.reviewIssues.map((issue) => ({ ...issue })));
  return {
    hardFailed: issues.some((issue) => issue.severity === 'hard'),
    issues,
    visibleChars,
    dialogueDensityPercent,
  };
}
