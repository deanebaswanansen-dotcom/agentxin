import { randomUUID } from 'node:crypto';

import type {
  ScriptContinuityState,
  ScriptEpisode,
  ScriptEpisodeOutline,
  ScriptPlan,
  ScriptReviewCategory,
  ScriptReviewIssue,
  ScriptReviewSource,
} from '../domain.js';

export type ScriptGateSeverity = 'hard' | 'soft';

export interface ScriptGateIssue {
  code: string;
  severity: ScriptGateSeverity;
  /** Omitted findings are deterministic for backwards compatibility. */
  source?: ScriptReviewSource;
  message: string;
  sceneId?: string;
  blockId?: string;
  path?: string;
}

export interface ScriptEvaluatedGateIssue extends ScriptGateIssue {
  source: ScriptReviewSource;
  /** Whether this exact finding is allowed to block the completed transition. */
  blocking: boolean;
}

export interface ScriptGateOptions {
  expectedEpisodeNumber?: number;
  existingEpisodeNumbers?: readonly number[];
  registeredCharacterIds?: ReadonlySet<string>;
  registeredCharacterNames?: ReadonlySet<string>;
  temporarySpeakers?: ReadonlySet<string>;
  characterNamesById?: ReadonlyMap<string, string>;
  outline?: ScriptEpisodeOutline;
  previousEpisode?: ScriptEpisode;
  continuity?: ScriptContinuityState;
  reviewIssues?: readonly ScriptGateIssue[];
}

export interface ScriptGateReport {
  hardFailed: boolean;
  issues: ScriptEvaluatedGateIssue[];
  blockingIssues: ScriptEvaluatedGateIssue[];
  advisoryIssues: ScriptEvaluatedGateIssue[];
  visibleChars: number;
  dialogueDensityPercent: number;
}

export function isBlockingScriptReviewIssue(
  issue: Pick<ScriptReviewIssue, 'severity' | 'source' | 'status'>,
): boolean {
  return issue.status === 'open' && issue.severity === 'hard' && issue.source !== 'ai';
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
  if (_options.outline && episode.outlineId !== _options.outline.id) {
    addHard('OUTLINE_ID_MISMATCH', '正文引用的详细大纲与当前集不一致。', 'outlineId');
  }
  if (episode.targetChars !== plan.targetCharsPerEpisode) {
    issues.push({
      code: 'TARGET_CHARS_MISMATCH',
      severity: 'soft',
      message: `正文目标字数 ${episode.targetChars} 与当前策划值 ${plan.targetCharsPerEpisode} 不一致。`,
      path: 'targetChars',
    });
  }
  const ordinals = new Set<number>();
  const sceneIds = new Set<string>();
  const blockIds = new Set<string>();
  for (const scene of episode.scenes) {
    if (sceneIds.has(scene.id)) {
      addHard('DUPLICATE_SCENE_ID', `场景 ID「${scene.id}」重复。`, 'id', scene.id);
    }
    sceneIds.add(scene.id);
    if (ordinals.has(scene.ordinal)) {
      addHard('DUPLICATE_SCENE_ORDINAL', `场号 ${scene.ordinal} 重复。`, 'ordinal', scene.id);
    }
    ordinals.add(scene.ordinal);
    if (new Set(scene.characterIds).size !== scene.characterIds.length) {
      addHard('DUPLICATE_SCENE_CHARACTER', '场景人物列表存在重复人物。', 'characterIds', scene.id);
    }
    if (!scene.location.trim()) addHard('MISSING_LOCATION', '场景缺少地点。', 'location', scene.id);
    if (!['day', 'night', 'dawn', 'dusk'].includes(scene.timeOfDay)) {
      addHard('MISSING_TIME', '场景缺少有效时间。', 'timeOfDay', scene.id);
    }
    if (!['interior', 'exterior'].includes(scene.interiorExterior)) {
      addHard('MISSING_INTERIOR_EXTERIOR', '场景缺少内外景。', 'interiorExterior', scene.id);
    }
    if (_options.registeredCharacterIds) {
      for (const characterId of scene.characterIds) {
        if (!_options.registeredCharacterIds.has(characterId)) {
          addHard(
            'UNKNOWN_CHARACTER_REFERENCE',
            `场景引用了未登记人物 ID「${characterId}」。`,
            'characterIds',
            scene.id,
          );
        }
      }
    }
    if (scene.blocks.length === 0) {
      addHard('EMPTY_SCENE', '场景没有字幕、动作或对白。', 'blocks', scene.id);
    }
    for (const block of scene.blocks) {
      if (blockIds.has(block.id)) {
        issues.push({
          code: 'DUPLICATE_BLOCK_ID',
          severity: 'hard',
          message: `正文块 ID「${block.id}」重复。`,
          sceneId: scene.id,
          blockId: block.id,
          path: 'blocks',
        });
      }
      blockIds.add(block.id);
      if (!block.text.trim()) {
        issues.push({
          code: 'EMPTY_BLOCK_TEXT',
          severity: 'hard',
          message: '正文块内容为空。',
          sceneId: scene.id,
          blockId: block.id,
          path: 'blocks.text',
        });
      }
      const lines = block.text.split(/\r?\n/u).map((line) => line.trim());
      const hasRegisteredSpeakerPrefix = lines.some((line) =>
        [...(_options.registeredCharacterNames ?? [])].some((rawName) => {
          const name = rawName.trim();
          return Boolean(name) && (
            line.startsWith(`${name}：`) ||
            line.startsWith(`${name}:`) ||
            (line.startsWith(`${name}（`) && /）\s*[：:]/u.test(line))
          );
        }),
      );
      const hasActionMarker = lines.some((line) => /^△/u.test(line));
      const hasCaptionWrapper = lines.some((line) => /【\s*字幕\s*[：:]/u.test(line));
      const hasCastPrefix = lines.some((line) => /^(?:人物|角色)\s*[：:]/u.test(line));
      const hasGenericDialoguePrefix = lines.some((line) =>
        /^[^：:\n]{1,20}（[^）\n]{1,16}）\s*[：:]/u.test(line),
      );
      if (block.type === 'caption') {
        if (
          hasRegisteredSpeakerPrefix ||
          hasActionMarker ||
          hasCaptionWrapper ||
          hasCastPrefix ||
          hasGenericDialoguePrefix
        ) {
          issues.push({
            code: 'CAPTION_STRUCTURE_POLLUTION',
            severity: 'hard',
            message: '字幕块混入了字幕包装、动作标记或对白前缀。',
            sceneId: scene.id,
            blockId: block.id,
            path: 'blocks.text',
          });
        }
      }
      if (
        block.type === 'action' && (
          hasRegisteredSpeakerPrefix ||
          hasActionMarker ||
          hasCaptionWrapper ||
          hasCastPrefix ||
          hasGenericDialoguePrefix
        )
      ) {
        issues.push({
          code: 'ACTION_STRUCTURE_POLLUTION',
          severity: 'hard',
          message: '动作块混入了动作标记、字幕包装或对白前缀。',
          sceneId: scene.id,
          blockId: block.id,
          path: 'blocks.text',
        });
      }
      if (block.type !== 'dialogue') continue;
      const speaker = block.speaker.trim();
      const hasRepeatedSpeakerPrefix = Boolean(speaker) && lines.some((line) =>
        line.startsWith(`${speaker}：`) ||
        line.startsWith(`${speaker}:`) ||
        (line.startsWith(`${speaker}（`) && /）\s*[：:]/u.test(line)),
      );
      if (
        hasRegisteredSpeakerPrefix ||
        hasRepeatedSpeakerPrefix ||
        hasActionMarker ||
        hasCaptionWrapper ||
        hasCastPrefix ||
        hasGenericDialoguePrefix
      ) {
        issues.push({
          code: 'DIALOGUE_STRUCTURE_POLLUTION',
          severity: 'hard',
          message: '对白文本混入了动作标记、字幕包装或重复的说话人前缀。',
          sceneId: scene.id,
          blockId: block.id,
          path: 'blocks.text',
        });
      }
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
      if (
        block.characterId &&
        _options.registeredCharacterIds &&
        !_options.registeredCharacterIds.has(block.characterId)
      ) {
        issues.push({
          code: 'UNKNOWN_DIALOGUE_CHARACTER_REFERENCE',
          severity: 'hard',
          message: `对白引用了未登记人物 ID「${block.characterId}」。`,
          sceneId: scene.id,
          blockId: block.id,
          path: 'characterId',
        });
      }
      const speakerCharacterId = block.characterId ?? [...(_options.characterNamesById ?? [])]
        .find(([, name]) => name === speaker)?.[0];
      if (speakerCharacterId && !scene.characterIds.includes(speakerCharacterId)) {
        issues.push({
          code: 'SPEAKER_NOT_IN_SCENE',
          severity: 'hard',
          message: `说话人「${speaker}」未列入本场人物。`,
          sceneId: scene.id,
          blockId: block.id,
          path: 'characterIds',
        });
      }
      const registeredName = block.characterId
        ? _options.characterNamesById?.get(block.characterId)
        : undefined;
      if (registeredName && registeredName !== speaker) {
        issues.push({
          code: 'SPEAKER_CHARACTER_MISMATCH',
          severity: 'hard',
          message: `对白人物 ID 对应「${registeredName}」，但署名为「${speaker}」。`,
          sceneId: scene.id,
          blockId: block.id,
          path: 'speaker',
        });
      }
      const dialogueLength = block.text.replace(/\s/gu, '').length;
      if (dialogueLength > 80) {
        issues.push({
          code: 'LONG_DIALOGUE',
          severity: 'soft',
          message: `单句对白 ${dialogueLength} 个可见字符，超过建议上限 80。`,
          sceneId: scene.id,
          blockId: block.id,
          path: 'blocks.text',
        });
      }
    }
  }
  const sortedOrdinals = [...ordinals].sort((left, right) => left - right);
  if (sortedOrdinals.some((ordinal, index) => ordinal !== index + 1)) {
    addHard('NON_CONTIGUOUS_SCENE_ORDINAL', '场号必须从 1 开始连续且唯一。', 'scenes');
  }
  if (episode.scenes.some((scene, index) => scene.ordinal !== index + 1)) {
    addHard('SCENES_OUT_OF_ORDER', '场景必须按场号升序排列。', 'scenes');
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
  const outlineForbiddenFacts = (_options.outline?.forbiddenFacts ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const outlineForbiddenSet = new Set(outlineForbiddenFacts);
  const forbidden = plan.forbiddenElements
    .map((value) => value.trim())
    .filter((value) => value && !outlineForbiddenSet.has(value));
  const matchedForbidden = forbidden.find((value) => combinedText.includes(value));
  if (matchedForbidden) {
    addHard('FORBIDDEN_ELEMENT', `正文包含禁止内容：${matchedForbidden}`, 'scenes');
  }
  const missingRequired = (_options.outline?.requiredFacts ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .find((value) => !combinedText.includes(value));
  if (missingRequired) {
    issues.push({
      code: 'MISSING_REQUIRED_FACT',
      severity: 'soft',
      message: `正文未找到必须事实的确定性证据，请人工确认：${missingRequired}`,
      path: 'scenes',
    });
  }
  const matchedForbiddenFact = outlineForbiddenFacts.find((value) => combinedText.includes(value));
  if (matchedForbiddenFact) {
    addHard('FORBIDDEN_FACT', `正文包含本集禁用事实：${matchedForbiddenFact}`, 'scenes');
  }
  if (_options.outline && !_options.outline.conflict.trim()) {
    addHard('MISSING_KEY_EVENT', '本集关键冲突为空。', 'outline.conflict');
  }
  if (_options.outline && !_options.outline.endingHook.trim()) {
    addHard('MISSING_ENDING_HOOK', '本集结尾卡点为空。', 'outline.endingHook');
  }
  if (!episode.summary.trim()) {
    issues.push({
      code: 'MISSING_SUMMARY',
      severity: 'soft',
      message: '本集摘要为空，会削弱后续集的连续性上下文。',
      path: 'summary',
    });
  }
  const knownOpenThreads = new Set([
    ...(_options.continuity?.openThreads ?? []),
    ...(_options.previousEpisode?.openedThreads ?? []),
    ...episode.openedThreads,
  ]);
  for (const thread of episode.closedThreads) {
    if (!knownOpenThreads.has(thread)) {
      issues.push({
        code: 'UNKNOWN_CLOSED_THREAD',
        severity: 'soft',
        message: `本集回收了未登记的伏笔「${thread}」。`,
        path: 'closedThreads',
      });
    }
  }
  const reopenedAndClosed = episode.openedThreads.find((thread) => episode.closedThreads.includes(thread));
  if (reopenedAndClosed) {
    issues.push({
      code: 'THREAD_OPENED_AND_CLOSED',
      severity: 'soft',
      message: `伏笔「${reopenedAndClosed}」在同一集开启并回收，请确认节奏。`,
      path: 'openedThreads',
    });
  }
  const existingFacts = new Set([
    ...(_options.continuity?.currentState ?? []),
    ...(_options.previousEpisode?.newFacts ?? []),
  ]);
  const repeatedFact = episode.newFacts.find((fact) => existingFacts.has(fact));
  if (repeatedFact) {
    issues.push({
      code: 'DUPLICATE_CONTINUITY_FACT',
      severity: 'soft',
      message: `新事实「${repeatedFact}」已在连续性资料中登记。`,
      path: 'newFacts',
    });
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
  const evaluatedIssues: ScriptEvaluatedGateIssue[] = issues.map((issue) => {
    const source = issue.source ?? 'deterministic';
    return {
      ...issue,
      source,
      blocking: issue.severity === 'hard' && source !== 'ai',
    };
  });
  const blockingIssues = evaluatedIssues.filter((issue) => issue.blocking);
  return {
    hardFailed: blockingIssues.length > 0,
    issues: evaluatedIssues,
    blockingIssues,
    advisoryIssues: evaluatedIssues.filter((issue) => !issue.blocking),
    visibleChars,
    dialogueDensityPercent,
  };
}

function reviewCategory(code: string): ScriptReviewCategory {
  if (/DIALOGUE|DENSITY/u.test(code)) return 'dialogue';
  if (/CHARACTER|SPEAKER/u.test(code)) return 'character';
  if (/THREAD|CONTINUITY|FACT|WARDROBE/u.test(code)) return 'continuity';
  if (/HOOK/u.test(code)) return 'hook';
  if (/SHORT|LONG|SCENE|TARGET/u.test(code)) return 'pacing';
  return 'format';
}

/** Converts a gate report into safely localized, persisted proofreading findings. */
export function createScriptReviewIssues(
  projectId: string,
  episodeNumber: number,
  source: ScriptReviewSource,
  issues: readonly ScriptGateIssue[],
  now = new Date().toISOString(),
): ScriptReviewIssue[] {
  return issues.map((issue) => ({
    id: randomUUID(),
    projectId,
    episodeNumber,
    ...(issue.sceneId ? { sceneId: issue.sceneId } : {}),
    ...(issue.blockId ? { blockId: issue.blockId } : {}),
    ...(issue.path ? { path: issue.path } : {}),
    code: issue.code,
    severity: issue.severity,
    category: reviewCategory(issue.code),
    message: issue.message,
    status: 'open',
    source,
    createdAt: now,
    updatedAt: now,
  }));
}
