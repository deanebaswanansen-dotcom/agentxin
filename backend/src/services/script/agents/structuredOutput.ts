import { repairLooseJson } from '../../blueprint/blueprintParser.js';
import { stripReasoningArtifacts } from '../../text/reasoningSanitizer.js';

export class ScriptModelOutputError extends Error {
  readonly code = 'SCRIPT_MODEL_OUTPUT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'ScriptModelOutputError';
  }
}

export interface StructuredModelParseResult {
  value: Record<string, unknown>;
  mode: 'direct' | 'local_repair';
}

function extractBalancedObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

export function parseStructuredModelOutputWithDiagnostics(raw: string): StructuredModelParseResult {
  const sanitized = stripReasoningArtifacts(raw)
    .replace(/^\s*```(?:json)?\s*$/gim, '')
    .trim();
  const objectText = extractBalancedObject(sanitized);
  if (!objectText) {
    throw new ScriptModelOutputError('模型未返回完整的 JSON 对象。');
  }

  let parsed: unknown;
  let mode: StructuredModelParseResult['mode'] = 'direct';
  try {
    parsed = JSON.parse(objectText);
  } catch {
    try {
      parsed = JSON.parse(repairLooseJson(objectText));
      mode = 'local_repair';
    } catch {
      throw new ScriptModelOutputError('模型返回的 JSON 无法解析。');
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ScriptModelOutputError('模型返回的 JSON 顶层必须是对象。');
  }
  return { value: parsed as Record<string, unknown>, mode };
}

export function parseStructuredModelOutput(raw: string): Record<string, unknown> {
  return parseStructuredModelOutputWithDiagnostics(raw).value;
}

