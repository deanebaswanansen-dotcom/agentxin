import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LlmRuntimeConfig {
  provider: 'mock' | 'openai-compatible';
  baseUrl: string;
  apiKey: string;
  modelName: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export function loadDotEnv(cwd = process.cwd()): void {
  for (const file of [resolve(cwd, '..', '.env'), resolve(cwd, '.env'), resolve(cwd, '.env.local')]) {
    if (!existsSync(file)) {
      continue;
    }
    const content = readFileSync(file, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) {
        continue;
      }
      const eq = trimmed.indexOf('=');
      if (eq <= 0) {
        continue;
      }
      const key = trimmed.slice(0, eq).trim();
      const value = unquote(trimmed.slice(eq + 1).trim());
      process.env[key] ??= value;
    }
  }
}

export function readLlmRuntimeConfig(env: NodeJS.ProcessEnv = process.env): LlmRuntimeConfig {
  const rawProvider = (env.LLM_PROVIDER ?? 'mock').trim().toLowerCase();
  const provider = rawProvider === 'mock' ? 'mock' : 'openai-compatible';
  return {
    provider,
    baseUrl: env.LLM_BASE_URL?.trim() ?? '',
    apiKey: env.LLM_API_KEY?.trim() ?? '',
    modelName: env.LLM_MODEL?.trim() ?? '',
    temperature: parseNumber(env.LLM_TEMPERATURE, 0.8),
    maxTokens: parseInteger(env.LLM_MAX_TOKENS, 4096),
    timeoutMs: parseInteger(env.LLM_TIMEOUT_MS, 120000),
  };
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = parseNumber(value, fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
