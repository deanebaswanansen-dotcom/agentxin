/**
 * Model configuration domain service (design: "Services (领域层)" >
 * ModelConfigService).
 *
 * Encapsulates the business rules for the single (singleton) model
 * configuration on top of the persistence-agnostic {@link DataStore}:
 *
 * - save: reject a config whose `baseUrl`, `apiKey` or `modelName` is empty or
 *   whitespace-only with `VALIDATION_ERROR` (Requirement 4.4). Validation runs
 *   BEFORE any write, so a rejected save leaves the previously stored config
 *   unchanged (Requirement 4.4 / Property 16). A valid config is persisted
 *   verbatim (Requirements 4.1, 4.3) and the masked view is returned.
 * - getView: return the SAFE outward-facing {@link ModelConfigView} — `baseUrl`
 *   and `modelName` in the clear, plus a MASKED API key. The raw key is NEVER
 *   included (Requirements 4.2, 5.6 / Property 15). When no config has been
 *   saved yet, an empty view is returned so the frontend can render its form.
 * - getInternalConfig: return the FULL request-scoped {@link ModelConfig}
 *   (including the raw `apiKey`) for server-side use by the writing flow /
 *   ModelProxy. Returns `undefined` when the current request did not include
 *   the volatile browser-held config. This MUST NOT be exposed over any
 *   frontend-facing transport.
 *
 * Validation failures raise a {@link ServiceError} so the transport layer can
 * map them to the unified API error response.
 */
import type { DataStore } from '../../store/DataStore.js';
import type { ModelConfig, ModelConfigView } from '../../types/index.js';
import { ServiceError } from '../ServiceError.js';
import { getRequestModelConfig, hasRequestModelConfigScope } from './requestModelConfig.js';

/** Fixed run of mask characters used to obscure the API key. */
const MASK = '****';
export const DEFAULT_TEMPERATURE = 1;
export const DEFAULT_TOP_P = 1;

export class ModelConfigService {
  constructor(private readonly store: DataStore) {}

  /**
   * Save (create or update) the model configuration (Requirements 4.1, 4.3).
   *
   * Each of `baseUrl`, `apiKey` and `modelName` must contain at least one
   * non-whitespace character; otherwise a `VALIDATION_ERROR` is thrown and the
   * store is left untouched (Requirement 4.4). The config is persisted exactly
   * as provided (no trimming) so an internal read-back round-trips precisely
   * (Property 14). Returns the masked view of the saved config.
   */
  async save(config: ModelConfig): Promise<ModelConfigView> {
    const isMock = config.baseUrl.trim() === 'mock' && config.modelName.trim() === 'mock-model';
    if (!isMock) {
      assertNonEmptyField(config.baseUrl, 'base URL');
      assertNonEmptyField(config.apiKey, 'API Key');
      assertNonEmptyField(config.modelName, '模型名称');
    } else {
      // For mock demo: allow dummy/empty key; force a sentinel value so internal code
      // can detect and short-circuit without network calls.
      if (!config.apiKey || config.apiKey.trim().length === 0) {
        config = { ...config, apiKey: 'mock-key-for-demo' };
      }
    }
    assertOptionalNumberRange(config.temperature, '温度', 0, 2);
    assertOptionalNumberRange(config.topP, 'Top-P', 0, 1);

    // Persist verbatim only after all fields pass validation, so a rejected
    // save never mutates the stored config (Requirement 4.4 / Property 16).
    await this.store.saveModelConfig(config);
    return toView(config);
  }

  /**
   * Return the safe, frontend-facing view of the model configuration
   * (Requirement 4.2). The API key is always masked — its raw value is never
   * present in the result (Requirement 5.6 / Property 15).
   *
   * When no configuration has been saved, returns an empty view
   * (`baseUrl`/`modelName`/`apiKeyMasked` all empty) so the settings UI has a
   * well-formed object to render.
   */
  async getView(): Promise<ModelConfigView> {
    const config = await this.store.getModelConfig();
    if (config === undefined) {
      return {
        baseUrl: '',
        modelName: '',
        apiKeyMasked: '',
        temperature: DEFAULT_TEMPERATURE,
        topP: DEFAULT_TOP_P,
      };
    }
    return toView(config);
  }

  /**
   * Return the FULL model configuration (including the raw API key) for the
   * current request. Prefers the request-scoped browser header; if the client
   * did not send a key this turn, fall back to the server-persisted config so
   * a page refresh does not force re-entry when the key was saved earlier.
   *
   * SECURITY: the result contains the plaintext API key and MUST NOT be
   * serialized to any frontend-facing response. Use {@link getView} for that.
   */
  async getInternalConfig(): Promise<ModelConfig | undefined> {
    if (hasRequestModelConfigScope()) {
      const fromRequest = getRequestModelConfig();
      if (fromRequest !== undefined) {
        return fromRequest;
      }
    }
    return this.store.getModelConfig();
  }
}

/**
 * Validate that a model-config field has at least one non-whitespace
 * character. Throws `VALIDATION_ERROR` when empty or whitespace-only
 * (Requirement 4.4); a whitespace-only value is treated as empty.
 */
function assertNonEmptyField(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw ServiceError.validation(`模型配置的 ${label} 不能为空`);
  }
}

function assertOptionalNumberRange(
  value: number | undefined,
  label: string,
  min: number,
  max: number,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw ServiceError.validation(`模型配置的 ${label} 必须在 ${min} 到 ${max} 之间`);
  }
}

/** Build the masked outward-facing view from a full config. */
function toView(config: ModelConfig): ModelConfigView {
  return {
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    apiKeyMasked: maskApiKey(config.apiKey),
    temperature: config.temperature ?? DEFAULT_TEMPERATURE,
    topP: config.topP ?? DEFAULT_TOP_P,
  };
}

/**
 * Produce a masked representation of an API key that reveals at most a short
 * suffix and is GUARANTEED never to contain the raw key as a substring
 * (Property 15), even for pathological keys (e.g. a key made entirely of mask
 * characters). Unicode code points are handled safely via `Array.from`.
 */
export function maskApiKey(apiKey: string): string {
  const chars = Array.from(apiKey);
  const len = chars.length;
  if (len === 0) return '';

  // Reveal strictly fewer characters than the full key, so the revealed suffix
  // alone can never equal the whole key.
  const revealCount = Math.min(4, len - 1);
  const suffix = revealCount > 0 ? chars.slice(len - revealCount).join('') : '';
  let masked = `${MASK}${suffix}`;

  // Robustness guard: if the chosen mask happens to embed the raw key (e.g. the
  // key is itself a run of mask characters), fall back to a value strictly
  // shorter than the key, which therefore cannot contain it.
  if (masked.includes(apiKey)) {
    masked = suffix.length > 0 ? suffix : MASK.slice(0, len - 1);
  }
  return masked;
}
