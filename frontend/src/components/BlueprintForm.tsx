/**
 * 章节蓝图生成表单（任务 12.2，需求 14.2）。
 *
 * 提供两个输入入口：
 *  - 章节需求文本（多行 textarea）。
 *  - 目标字数（数字输入，100–100000）。
 *
 * 校验与按钮可用性（需求 14.2）：当章节需求文本为空，或目标字数不是 100 至
 * 100000 之间的整数时，禁用「生成蓝图」按钮。提交时通过 `onGenerate` 上抛
 * 规整后的 {@link GenerateBlueprintBody}，由父组件（{@link ChapterBlueprintPanel}）
 * 发起后端调用。
 *
 * 本组件为纯受控表单，不直接依赖任何客户端，便于复用与测试。
 */
import { useCallback, useState } from 'react';
import type { GenerateBlueprintBody } from '../types/index.js';
import './components.css';

/** 目标字数允许的闭区间下界（需求 1.3、14.2）。 */
export const MIN_TARGET_WORDS = 100;
/** 目标字数允许的闭区间上界（需求 1.3、14.2）。 */
export const MAX_TARGET_WORDS = 100000;

export interface BlueprintFormProps {
  /** 提交生成请求（需求 14.2）；父组件据此调用后端生成蓝图。 */
  onGenerate: (body: GenerateBlueprintBody) => void;
  /** 生成进行中时禁用整个表单。 */
  disabled?: boolean;
  /** 目标字数输入的初始值（默认 3000）。 */
  initialTargetWords?: number;
  /** 章节需求文本的初始值（默认空）。 */
  initialRequirement?: string;
}

/** 判断目标字数是否为 100–100000 之间的整数（需求 14.2）。 */
export function isTargetWordsValid(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_TARGET_WORDS && value <= MAX_TARGET_WORDS;
}

/**
 * 章节需求 + 目标字数输入表单。文本为空或字数越界时禁用生成按钮（需求 14.2）。
 */
export function BlueprintForm({
  onGenerate,
  disabled = false,
  initialTargetWords = 3000,
  initialRequirement = '',
}: BlueprintFormProps): JSX.Element {
  const [requirement, setRequirement] = useState(initialRequirement);
  const [targetWordsInput, setTargetWordsInput] = useState(String(initialTargetWords));

  const parsedTarget = Number(targetWordsInput);
  const targetValid = targetWordsInput.trim().length > 0 && isTargetWordsValid(parsedTarget);
  const requirementValid = requirement.trim().length > 0;
  const canGenerate = requirementValid && targetValid && !disabled;

  const handleGenerate = useCallback(() => {
    if (!canGenerate) return;
    onGenerate({ requirement, targetWords: parsedTarget });
  }, [canGenerate, onGenerate, requirement, parsedTarget]);

  return (
    <div aria-label="生成章节蓝图">
      <h3 className="nwa-panel__title">生成章节蓝图</h3>

      <label className="nwa-field">
        <span className="nwa-field__label">章节需求</span>
        <textarea
          className="nwa-textarea"
          aria-label="章节需求"
          rows={5}
          placeholder="输入章节大纲、剧情要求与节奏要求（支持标准模板或一句话简述）…"
          value={requirement}
          disabled={disabled}
          onChange={(e) => setRequirement(e.target.value)}
        />
      </label>

      <label className="nwa-field">
        <span className="nwa-field__label">目标字数</span>
        <input
          className="nwa-input"
          type="number"
          inputMode="numeric"
          min={MIN_TARGET_WORDS}
          max={MAX_TARGET_WORDS}
          step={100}
          aria-label="目标字数"
          placeholder={`${MIN_TARGET_WORDS}–${MAX_TARGET_WORDS}`}
          value={targetWordsInput}
          disabled={disabled}
          onChange={(e) => setTargetWordsInput(e.target.value)}
        />
        {!targetValid && targetWordsInput.trim().length > 0 ? (
          <span className="nwa-field__hint nwa-muted">
            目标字数需为 {MIN_TARGET_WORDS}–{MAX_TARGET_WORDS} 之间的整数。
          </span>
        ) : null}
      </label>

      <div className="nwa-row">
        <span className="nwa-grow" />
        <button
          type="button"
          className="nwa-button"
          disabled={!canGenerate}
          onClick={handleGenerate}
        >
          {disabled ? '生成中…' : '生成蓝图'}
        </button>
      </div>
    </div>
  );
}

export default BlueprintForm;
