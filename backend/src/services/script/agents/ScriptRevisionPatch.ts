import { randomUUID } from 'node:crypto';

import type { ScriptBlock, ScriptEpisode } from '../domain.js';
import type { ScriptGateIssue } from '../quality/ScriptQualityGates.js';
import {
  defineStructuredContract,
  type StructuredDecodeIssue,
} from './StructuredContract.js';

export type ScriptRevisionBlockInput =
  | { type: 'caption'; text: string }
  | { type: 'action'; text: string }
  | {
      type: 'dialogue';
      characterId?: string;
      speaker: string;
      delivery?: string;
      mode?: 'normal' | 'os' | 'vo';
      text: string;
    };

export type ScriptRevisionOperation =
  | { op: 'replaceBlockText'; sceneId: string; blockId: string; text: string }
  | {
      op: 'insertBlockAfter';
      sceneId: string;
      afterBlockId: string;
      block: ScriptRevisionBlockInput;
    }
  | { op: 'appendBlock'; sceneId: string; block: ScriptRevisionBlockInput }
  | { op: 'updateSceneCharacters'; sceneId: string; characterIds: string[] };

export interface ScriptRevisionPatch {
  operations: ScriptRevisionOperation[];
}

export interface AppliedScriptRevisionPatch {
  episode: ScriptEpisode;
  touchedSceneIds: string[];
  touchedBlockIds: string[];
  insertedBlockIds: string[];
}

export interface ScriptRevisionPatchPolicyOptions {
  /** The canonical character registry for this run. Empty is valid; missing is not. */
  registeredCharacterIds: Iterable<string>;
}

export type ScriptRevisionPatchPolicyRule =
  | {
      issueCode: string;
      target: 'blockText';
      sceneId: string;
      blockId: string;
    }
  | {
      issueCode: string;
      target: 'sceneAppend' | 'sceneCharacters';
      sceneId: string;
    }
  | {
      issueCode: 'TOO_SHORT';
      target: 'shortExpansion';
      sceneId: string;
      allowedAfterBlockIds: string[];
    }
  | {
      issueCode: 'TOO_LONG';
      target: 'longReduction';
      allowedBlocks: Array<{ sceneId: string; blockId: string }>;
    };

/**
 * A capability tied to one exact episode revision. It deliberately contains
 * only targets justified by the blocking gate report, never a broad scene list.
 */
export interface ScriptRevisionPatchPolicy {
  episodeId: string;
  episodeRevision: number;
  outlineId: string;
  registeredCharacterIds: string[];
  rules: ScriptRevisionPatchPolicyRule[];
}

export class ScriptRevisionPatchError extends Error {
  readonly code = 'INVALID_SCRIPT_REVISION_PATCH';

  constructor(message: string) {
    super(message);
    this.name = 'ScriptRevisionPatchError';
  }
}

const BLOCK_TEXT_CODES = new Set([
  'EMPTY_BLOCK_TEXT',
  'CAPTION_STRUCTURE_POLLUTION',
  'ACTION_STRUCTURE_POLLUTION',
  'DIALOGUE_STRUCTURE_POLLUTION',
]);

const SCENE_CHARACTER_CODES = new Set([
  'DUPLICATE_SCENE_CHARACTER',
  'UNKNOWN_CHARACTER_REFERENCE',
  'SPEAKER_NOT_IN_SCENE',
]);

function normalizedPath(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/\[\d+\]/gu, '')
    .replace(/^episode\./u, '')
    .replace(/^scenes\./u, '');
}

function cannotAutoRepair(issue: Pick<ScriptGateIssue, 'code' | 'path' | 'sceneId' | 'blockId'>, reason: string): never {
  const location = [
    issue.sceneId ? `sceneId=${issue.sceneId}` : '',
    issue.blockId ? `blockId=${issue.blockId}` : '',
    issue.path ? `path=${issue.path}` : '',
  ].filter(Boolean).join(', ');
  throw new ScriptRevisionPatchError(
    `阻断问题 ${issue.code}${location ? `（${location}）` : ''} 无法安全自动修复：${reason}`,
  );
}

function uniquePolicyRules(rules: readonly ScriptRevisionPatchPolicyRule[]): ScriptRevisionPatchPolicyRule[] {
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = JSON.stringify(rule);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Converts a blocking report into a narrow, revision-bound write capability.
 * Throws instead of guessing when an issue has no target expressible by the
 * supported Patch operations.
 */
export function buildScriptRevisionPatchPolicy(
  base: ScriptEpisode,
  blockingIssues: readonly Pick<
    ScriptGateIssue,
    'code' | 'severity' | 'path' | 'sceneId' | 'blockId'
  >[],
  options: ScriptRevisionPatchPolicyOptions,
): ScriptRevisionPatchPolicy {
  if (blockingIssues.length === 0) {
    throw new ScriptRevisionPatchError('没有阻断问题，拒绝授予自动修订权限。');
  }
  if (!options || options.registeredCharacterIds === undefined) {
    throw new ScriptRevisionPatchError('构造修订策略必须提供已登记人物 ID 白名单。');
  }
  const registeredCharacterIds = [...new Set(
    [...options.registeredCharacterIds].map((id) => id.trim()).filter(Boolean),
  )];
  const rules: ScriptRevisionPatchPolicyRule[] = [];

  for (const issue of blockingIssues) {
    if (issue.severity !== 'hard') {
      cannotAutoRepair(issue, '只有 hard 阻断问题可以授权自动修订');
    }
    if (issue.code === 'TOO_SHORT') {
      const lastScene = base.scenes.at(-1);
      if (!lastScene) cannotAutoRepair(issue, '正文没有可安全扩写的末场');
      const lastBlock = lastScene.blocks.at(-1);
      rules.push({
        issueCode: 'TOO_SHORT',
        target: 'shortExpansion',
        sceneId: lastScene.id,
        allowedAfterBlockIds: lastBlock ? [lastBlock.id] : [],
      });
      continue;
    }
    if (issue.code === 'TOO_LONG') {
      const allowedBlocks = base.scenes.flatMap((scene) => scene.blocks.map((block) => ({
        sceneId: scene.id,
        blockId: block.id,
      })));
      if (allowedBlocks.length === 0) {
        cannotAutoRepair(issue, '正文没有可安全精简的正文块');
      }
      rules.push({
        issueCode: 'TOO_LONG',
        target: 'longReduction',
        allowedBlocks,
      });
      continue;
    }

    const path = normalizedPath(issue.path);
    if (
      issue.sceneId &&
      (SCENE_CHARACTER_CODES.has(issue.code) || /(?:^|\.)characterIds$/u.test(path))
    ) {
      const scene = base.scenes.find((candidate) => candidate.id === issue.sceneId);
      if (!scene) cannotAutoRepair(issue, '定位的场景已不存在');
      rules.push({
        issueCode: issue.code,
        target: 'sceneCharacters',
        sceneId: scene.id,
      });
      continue;
    }
    if (issue.blockId) {
      if (!issue.sceneId) cannotAutoRepair(issue, '正文块问题缺少 sceneId');
      const scene = base.scenes.find((candidate) => candidate.id === issue.sceneId);
      const block = scene?.blocks.find((candidate) => candidate.id === issue.blockId);
      if (!scene || !block) cannotAutoRepair(issue, '定位的场景或正文块已不存在');
      if (!BLOCK_TEXT_CODES.has(issue.code) && !/(?:^|\.)blocks\.text$|^text$/u.test(path)) {
        cannotAutoRepair(issue, '该块级问题不能仅通过替换正文文本修复');
      }
      rules.push({
        issueCode: issue.code,
        target: 'blockText',
        sceneId: scene.id,
        blockId: block.id,
      });
      continue;
    }

    if (issue.sceneId) {
      const scene = base.scenes.find((candidate) => candidate.id === issue.sceneId);
      if (!scene) cannotAutoRepair(issue, '定位的场景已不存在');
      if (issue.code === 'EMPTY_SCENE' || /(?:^|\.)blocks$/u.test(path)) {
        rules.push({
          issueCode: issue.code,
          target: 'sceneAppend',
          sceneId: scene.id,
        });
        continue;
      }
      cannotAutoRepair(issue, '该场景字段不在 Patch 允许修改的 characterIds/blocks 范围内');
    }

    cannotAutoRepair(issue, '问题没有精确场景/正文块定位，且不属于安全扩写');
  }

  return {
    episodeId: base.id,
    episodeRevision: base.revision,
    outlineId: base.outlineId,
    registeredCharacterIds,
    rules: uniquePolicyRules(rules),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(
  value: unknown,
  path: readonly (string | number)[],
  issues: StructuredDecodeIssue[],
): string {
  if (typeof value !== 'string' || !value.trim()) {
    issues.push({ path, code: 'field.required', message: '必须是非空字符串。' });
    return '';
  }
  return value.trim();
}

function decodeBlock(
  value: unknown,
  path: readonly (string | number)[],
  issues: StructuredDecodeIssue[],
): ScriptRevisionBlockInput | undefined {
  const item = record(value);
  if (!item) {
    issues.push({ path, code: 'type.object', message: '正文块必须是对象。' });
    return undefined;
  }
  const type = nonEmptyString(item.type, [...path, 'type'], issues);
  const text = nonEmptyString(item.text, [...path, 'text'], issues);
  if (type === 'caption') return { type, text };
  if (type === 'action') return { type, text };
  if (type !== 'dialogue') {
    issues.push({
      path: [...path, 'type'],
      code: 'enum.block_type',
      message: 'type 只能是 caption、action 或 dialogue。',
    });
    return undefined;
  }
  const speaker = nonEmptyString(item.speaker, [...path, 'speaker'], issues);
  const characterId = typeof item.characterId === 'string' && item.characterId.trim()
    ? item.characterId.trim()
    : undefined;
  const delivery = typeof item.delivery === 'string' && item.delivery.trim()
    ? item.delivery.trim()
    : undefined;
  const mode = item.mode === undefined ? undefined : item.mode;
  if (mode !== undefined && mode !== 'normal' && mode !== 'os' && mode !== 'vo') {
    issues.push({
      path: [...path, 'mode'],
      code: 'enum.dialogue_mode',
      message: 'mode 只能是 normal、os 或 vo。',
    });
  }
  return {
    type: 'dialogue',
    speaker,
    text,
    ...(characterId ? { characterId } : {}),
    ...(delivery ? { delivery } : {}),
    ...(mode === 'normal' || mode === 'os' || mode === 'vo' ? { mode } : {}),
  };
}

export const SCRIPT_REVISION_PATCH_CONTRACT = defineStructuredContract<ScriptRevisionPatch>({
  name: 'ScriptRevisionPatch',
  version: 1,
  instructions: [
    '顶层只包含 operations 数组，必须返回完整 Patch。',
    'Patch 结构支持 op：replaceBlockText、insertBlockAfter、appendBlock、updateSceneCharacters；实际授权仅以本轮精确 revisionPolicy 为准。',
    '禁止删除场景/正文块、替换整集、修改集号、outlineId 或重排场景。',
  ].join('\n'),
  decode(value) {
    const issues: StructuredDecodeIssue[] = [];
    const root = record(value);
    if (!root) {
      return {
        success: false,
        issues: [{ path: [], code: 'type.object', message: 'Patch 顶层必须是对象。' }],
      };
    }
    if (!Array.isArray(root.operations) || root.operations.length === 0) {
      return {
        success: false,
        issues: [{
          path: ['operations'],
          code: 'array.non_empty',
          message: 'operations 必须是非空数组。',
        }],
      };
    }
    if (root.operations.length > 32) {
      issues.push({
        path: ['operations'],
        code: 'array.max',
        message: '单次修订最多允许 32 个操作。',
      });
    }
    const operations: ScriptRevisionOperation[] = [];
    root.operations.forEach((rawOperation, index) => {
      const path = ['operations', index] as const;
      const item = record(rawOperation);
      if (!item) {
        issues.push({ path, code: 'type.object', message: '操作必须是对象。' });
        return;
      }
      const op = nonEmptyString(item.op, [...path, 'op'], issues);
      const sceneId = nonEmptyString(item.sceneId, [...path, 'sceneId'], issues);
      if (op === 'replaceBlockText') {
        operations.push({
          op,
          sceneId,
          blockId: nonEmptyString(item.blockId, [...path, 'blockId'], issues),
          text: nonEmptyString(item.text, [...path, 'text'], issues),
        });
        return;
      }
      if (op === 'insertBlockAfter') {
        const block = decodeBlock(item.block, [...path, 'block'], issues);
        if (block) {
          operations.push({
            op,
            sceneId,
            afterBlockId: nonEmptyString(item.afterBlockId, [...path, 'afterBlockId'], issues),
            block,
          });
        }
        return;
      }
      if (op === 'appendBlock') {
        const block = decodeBlock(item.block, [...path, 'block'], issues);
        if (block) operations.push({ op, sceneId, block });
        return;
      }
      if (op === 'updateSceneCharacters') {
        if (!Array.isArray(item.characterIds)) {
          issues.push({
            path: [...path, 'characterIds'],
            code: 'type.array',
            message: 'characterIds 必须是字符串数组。',
          });
          return;
        }
        const characterIds = item.characterIds.map((id, idIndex) =>
          nonEmptyString(id, [...path, 'characterIds', idIndex], issues));
        if (new Set(characterIds).size !== characterIds.length) {
          issues.push({
            path: [...path, 'characterIds'],
            code: 'array.unique',
            message: 'characterIds 不得重复。',
          });
        }
        operations.push({ op, sceneId, characterIds });
        return;
      }
      issues.push({
        path: [...path, 'op'],
        code: 'enum.operation',
        message: '不允许的修订操作。',
      });
    });
    return issues.length > 0
      ? { success: false, issues }
      : { success: true, value: { operations } };
  },
});

function createBlock(input: ScriptRevisionBlockInput, id: string): ScriptBlock {
  if (input.type === 'caption') return { id, type: input.type, text: input.text };
  if (input.type === 'action') return { id, type: input.type, text: input.text };
  return {
    id,
    type: 'dialogue',
    speaker: input.speaker,
    text: input.text,
    ...(input.characterId ? { characterId: input.characterId } : {}),
    ...(input.delivery ? { delivery: input.delivery } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
  };
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function operationLabel(operation: ScriptRevisionOperation): string {
  if (operation.op === 'replaceBlockText') return `${operation.op}:${operation.sceneId}/${operation.blockId}`;
  if (operation.op === 'insertBlockAfter') {
    return `${operation.op}:${operation.sceneId}/${operation.afterBlockId}`;
  }
  return `${operation.op}:${operation.sceneId}`;
}

/** Validates the complete Patch before any ID is allocated or candidate is mutated. */
export function assertScriptRevisionPatchAllowed(
  base: ScriptEpisode,
  patch: ScriptRevisionPatch,
  policy: ScriptRevisionPatchPolicy,
): void {
  if (
    policy.episodeId !== base.id ||
    policy.episodeRevision !== base.revision ||
    policy.outlineId !== base.outlineId
  ) {
    throw new ScriptRevisionPatchError('修订策略与当前 Episode 版本不匹配，拒绝应用陈旧 Patch。');
  }
  if (policy.rules.length === 0) {
    throw new ScriptRevisionPatchError('修订策略没有授权任何操作。');
  }
  const registeredCharacterIds = new Set(policy.registeredCharacterIds);

  for (const operation of patch.operations) {
    if (operation.op === 'updateSceneCharacters') {
      const unknownId = operation.characterIds.find((id) => !registeredCharacterIds.has(id));
      if (unknownId) {
        throw new ScriptRevisionPatchError(`场景人物更新引用了未登记人物 ID：${unknownId}。`);
      }
    }
    if (
      (operation.op === 'insertBlockAfter' || operation.op === 'appendBlock') &&
      operation.block.type === 'dialogue' &&
      operation.block.characterId &&
      !registeredCharacterIds.has(operation.block.characterId)
    ) {
      throw new ScriptRevisionPatchError(
        `新增对白引用了未登记人物 ID：${operation.block.characterId}。`,
      );
    }

    const authorized = policy.rules.some((rule) => {
      if (operation.op === 'replaceBlockText') {
        return (rule.target === 'blockText' &&
          rule.sceneId === operation.sceneId &&
          rule.blockId === operation.blockId) ||
          (rule.target === 'longReduction' && rule.allowedBlocks.some((target) =>
            target.sceneId === operation.sceneId && target.blockId === operation.blockId));
      }
      if (operation.op === 'updateSceneCharacters') {
        return rule.target === 'sceneCharacters' && rule.sceneId === operation.sceneId;
      }
      if (operation.op === 'appendBlock') {
        return (rule.target === 'sceneAppend' || rule.target === 'shortExpansion') &&
          rule.sceneId === operation.sceneId;
      }
      return rule.target === 'shortExpansion' &&
        rule.sceneId === operation.sceneId &&
        rule.allowedAfterBlockIds.includes(operation.afterBlockId);
    });
    if (!authorized) {
      throw new ScriptRevisionPatchError(
        `操作 ${operationLabel(operation)} 未被当前阻断问题授权。`,
      );
    }
    if (operation.op === 'replaceBlockText') {
      const exactBlockRule = policy.rules.some((rule) => rule.target === 'blockText' &&
        rule.sceneId === operation.sceneId && rule.blockId === operation.blockId);
      const longReductionRule = policy.rules.some((rule) => rule.target === 'longReduction' &&
        rule.allowedBlocks.some((target) =>
          target.sceneId === operation.sceneId && target.blockId === operation.blockId));
      if (longReductionRule && !exactBlockRule) {
        const original = base.scenes
          .find((scene) => scene.id === operation.sceneId)
          ?.blocks.find((block) => block.id === operation.blockId);
        const before = original?.text.replace(/\s/gu, '').length ?? 0;
        const after = operation.text.replace(/\s/gu, '').length;
        if (after >= before) {
          throw new ScriptRevisionPatchError(
            `TOO_LONG 只能缩短现有正文块 ${operation.blockId}，不得等长或扩写。`,
          );
        }
      }
    }
  }
}

/** Proves that every non-targeted original block remains byte-for-byte and order stable. */
export function assertUntouchedScriptBlocks(
  base: ScriptEpisode,
  candidate: ScriptEpisode,
  touchedBlockIds: ReadonlySet<string>,
): void {
  for (const baseScene of base.scenes) {
    const candidateScene = candidate.scenes.find((scene) => scene.id === baseScene.id);
    if (!candidateScene) throw new ScriptRevisionPatchError(`修订删除了场景 ${baseScene.id}。`);
    const baseUntouched = baseScene.blocks.filter((block) => !touchedBlockIds.has(block.id));
    const candidateUntouched = candidateScene.blocks.filter((block) =>
      baseUntouched.some((original) => original.id === block.id));
    if (canonical(baseUntouched) !== canonical(candidateUntouched)) {
      throw new ScriptRevisionPatchError(`修订改变了未命中的正文块或顺序: ${baseScene.id}。`);
    }
  }
}

export function applyScriptRevisionPatch(
  base: ScriptEpisode,
  patch: ScriptRevisionPatch,
  createId: () => string = randomUUID,
  policy?: ScriptRevisionPatchPolicy,
): AppliedScriptRevisionPatch {
  if (patch.operations.length === 0 || patch.operations.length > 32) {
    throw new ScriptRevisionPatchError('修订操作数量必须为 1 到 32。');
  }
  if (policy) assertScriptRevisionPatchAllowed(base, patch, policy);
  const episode = structuredClone(base);
  const existingIds = new Set(episode.scenes.flatMap((scene) => scene.blocks.map((block) => block.id)));
  const touchedSceneIds = new Set<string>();
  const touchedBlockIds = new Set<string>();
  const insertedBlockIds: string[] = [];
  const uniqueTargets = new Set<string>();

  for (const operation of patch.operations) {
    const scene = episode.scenes.find((candidate) => candidate.id === operation.sceneId);
    if (!scene) throw new ScriptRevisionPatchError(`修订引用了不存在的场景 ${operation.sceneId}。`);
    touchedSceneIds.add(scene.id);
    if (operation.op === 'replaceBlockText') {
      const targetKey = `${operation.op}\u0000${operation.blockId}`;
      if (uniqueTargets.has(targetKey)) {
        throw new ScriptRevisionPatchError(`同一正文块被重复替换: ${operation.blockId}。`);
      }
      uniqueTargets.add(targetKey);
      const block = scene.blocks.find((candidate) => candidate.id === operation.blockId);
      if (!block) throw new ScriptRevisionPatchError(`修订引用了不存在的正文块 ${operation.blockId}。`);
      if (!operation.text.trim()) throw new ScriptRevisionPatchError('替换后的正文不能为空。');
      block.text = operation.text.trim();
      touchedBlockIds.add(block.id);
      continue;
    }
    if (operation.op === 'updateSceneCharacters') {
      const targetKey = `${operation.op}\u0000${scene.id}`;
      if (uniqueTargets.has(targetKey)) {
        throw new ScriptRevisionPatchError(`同一场景人物表被重复更新: ${scene.id}。`);
      }
      uniqueTargets.add(targetKey);
      if (operation.characterIds.some((id) => !id.trim())) {
        throw new ScriptRevisionPatchError('场景人物 ID 不能为空。');
      }
      if (new Set(operation.characterIds).size !== operation.characterIds.length) {
        throw new ScriptRevisionPatchError('场景人物 ID 不得重复。');
      }
      scene.characterIds = [...operation.characterIds];
      continue;
    }
    const id = createId();
    if (!id || existingIds.has(id)) throw new ScriptRevisionPatchError(`新正文块 ID 冲突: ${id || '空 ID'}。`);
    existingIds.add(id);
    insertedBlockIds.push(id);
    const block = createBlock(operation.block, id);
    if (operation.op === 'appendBlock') {
      scene.blocks.push(block);
      continue;
    }
    const targetIndex = scene.blocks.findIndex((candidate) => candidate.id === operation.afterBlockId);
    if (targetIndex < 0) {
      throw new ScriptRevisionPatchError(`修订引用了不存在的插入锚点 ${operation.afterBlockId}。`);
    }
    scene.blocks.splice(targetIndex + 1, 0, block);
  }

  assertUntouchedScriptBlocks(base, episode, touchedBlockIds);
  return {
    episode,
    touchedSceneIds: [...touchedSceneIds],
    touchedBlockIds: [...touchedBlockIds],
    insertedBlockIds,
  };
}
