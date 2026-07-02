/**
 * Settings panel for the model configuration (task 12.7, Requirement 8.5).
 *
 * Lets the user enable an in-memory model configuration (`baseUrl`, `apiKey`,
 * `modelName`) for the current page session only. The raw API key is kept in
 * browser memory and is lost on refresh, close, or explicit logout.
 *
 * Backend errors are surfaced through the injected `onError` callback (wire it
 * to the global error reporter from `ErrorProvider`, Requirement 8.6). The
 * component owns only its local form/loading state; app-shell composition
 * happens in task 13.2.
 */
import { useCallback, useEffect, useState } from 'react';
import apiClient, { isApiClientError } from '../api/apiClient.js';
import type { CacheStatsSummary, ModelConfig, ModelConfigView } from '../types/index.js';
import './components.css';

/** Minimal client surface this panel depends on (eases testing). */
export type SettingsClient = Pick<typeof apiClient, 'modelConfig' | 'cacheStats'>;

export interface SettingsPanelProps {
  /** Surface a backend/runtime error to the global error UI (Requirement 8.6). */
  onError?: (error: unknown) => void;
  /** Invoked after a successful save with the refreshed masked view. */
  onSaved?: (view: ModelConfigView) => void;
  /** Current UI theme mode, owned by the app shell. */
  themeMode?: 'tavern' | 'midnight' | 'paper';
  /** Switch the app-shell theme. */
  onThemeModeChange?: (mode: 'tavern' | 'midnight' | 'paper') => void;
  /** Injectable client (defaults to the shared {@link apiClient}). */
  client?: SettingsClient;
}

interface ProviderPreset {
  id: string;
  label: string;
  description: string;
  baseUrl: string;
  modelName: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    description: '默认推荐。响应快、首字延迟低，适合日常写作与一键整本生成。',
    baseUrl: 'https://api.deepseek.com',
    modelName: 'deepseek-v4-flash',
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: '质量更高，但会做更长的深度推理，首字较慢（约 8 秒起）。适合精雕关键章节。',
    baseUrl: 'https://api.deepseek.com',
    modelName: 'deepseek-v4-pro',
  },
  {
    id: 'mock',
    label: 'Mock (本地演示)',
    description: '无需 API Key，纯本地模拟响应。用于快速体验、测试和离线演示。',
    baseUrl: 'mock',
    modelName: 'mock-model',
  },
  {
    id: 'openai-compatible',
    label: '自定义 OpenAI 兼容',
    description: '用于第三方中转、本地网关或其他兼容服务。',
    baseUrl: '',
    modelName: '',
  },
];
const DEFAULT_TEMPERATURE = 1;
const DEFAULT_TOP_P = 1;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * View and update the current page-session model configuration.
 */
export function SettingsPanel({
  onError,
  onSaved,
  themeMode = 'tavern',
  onThemeModeChange,
  client = apiClient,
}: SettingsPanelProps): JSX.Element {
  const [baseUrl, setBaseUrl] = useState('');
  const [modelName, setModelName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyMasked, setApiKeyMasked] = useState('');
  const [presetId, setPresetId] = useState(PROVIDER_PRESETS[0].id);
  const [temperature, setTemperature] = useState(DEFAULT_TEMPERATURE);
  const [topP, setTopP] = useState(DEFAULT_TOP_P);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [cacheStats, setCacheStats] = useState<CacheStatsSummary | null>(null);

  const handleError = useCallback(
    (error: unknown) => {
      if (isAbort(error)) return;
      onError?.(error);
    },
    [onError],
  );

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const view = await client.modelConfig.get(signal);
        if (view.baseUrl.trim().length === 0 && view.modelName.trim().length === 0) {
          const defaultPreset = PROVIDER_PRESETS[0];
          setBaseUrl(defaultPreset.baseUrl);
          setModelName(defaultPreset.modelName);
          setPresetId(defaultPreset.id);
        } else {
          setBaseUrl(view.baseUrl);
          setModelName(view.modelName);
          const detected = resolvePresetId(view.baseUrl, view.modelName);
          setPresetId(detected);
        }
        setTemperature(view.temperature ?? DEFAULT_TEMPERATURE);
        setTopP(view.topP ?? DEFAULT_TOP_P);
        setApiKeyMasked(view.apiKeyMasked);
        // Never prefill the editable key field; the raw key is unavailable.
        setApiKey('');
      } catch (error) {
        handleError(error);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [client, handleError],
  );

  const refreshCacheStats = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setCacheStats(await client.cacheStats.get(signal));
      } catch (error) {
        handleError(error);
      }
    },
    [client, handleError],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    void refreshCacheStats(controller.signal);
    return () => controller.abort();
  }, [refresh, refreshCacheStats]);

  const handleResetCacheStats = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await client.cacheStats.reset();
      await refreshCacheStats();
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }, [busy, client, refreshCacheStats, handleError]);

  // Mirror the backend's non-empty validation (Requirement 4.4) for the
  // button-enabled state; the backend remains the source of truth.
  // Special case for 'mock' preset: no real API key required for local demo.
  const isMockPreset = presetId === 'mock' || baseUrl.trim() === 'mock';
  const canSave =
    isMockPreset || (baseUrl.trim().length > 0 && modelName.trim().length > 0 && apiKey.trim().length > 0);
  const recentCacheRecords = cacheStats?.recent ?? [];

  const handleSave = useCallback(async () => {
    if (busy || !canSave) return;
    setBusy(true);
    setSaved(false);
    const config: ModelConfig = {
      baseUrl: baseUrl.trim(),
      apiKey: isMockPreset ? apiKey.trim() || 'mock-key-for-demo' : apiKey.trim(),
      modelName: modelName.trim(),
      temperature,
      topP,
    };
    try {
      const view = await client.modelConfig.save(config);
      setBaseUrl(view.baseUrl);
      setModelName(view.modelName);
      setTemperature(view.temperature ?? DEFAULT_TEMPERATURE);
      setTopP(view.topP ?? DEFAULT_TOP_P);
      setApiKeyMasked(view.apiKeyMasked);
      setApiKey('');
      setSaved(true);
      onSaved?.(view);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }, [busy, canSave, baseUrl, apiKey, isMockPreset, modelName, temperature, topP, client, onSaved, handleError]);

  const hasSavedKey = apiKeyMasked.trim().length > 0;

  const handlePresetChange = useCallback(
    (nextId: string) => {
      const preset = PROVIDER_PRESETS.find((item) => item.id === nextId);
      if (!preset) return;
      setPresetId(nextId);
      setBaseUrl(preset.baseUrl);
      setModelName(preset.modelName);
      // For mock demo, auto-provide a dummy key so save succeeds without user input.
      if (nextId === 'mock') {
        setApiKey('mock-key-for-demo');
      } else if (nextId !== 'openai-compatible') {
        // For real presets, clear key so user must re-enter (security).
        setApiKey('');
      }
      setSaved(false);
    },
    [],
  );

  return (
    <section className="nwa-panel" aria-label="模型设置">
      <div className="nwa-row">
        <h2 className="nwa-panel__title nwa-grow">模型设置</h2>
        <a
          className="nwa-link"
          href="https://platform.deepseek.com/usage"
          target="_blank"
          rel="noreferrer"
        >
          用量
        </a>
        <a
          className="nwa-link"
          href="https://platform.deepseek.com/api_keys"
          target="_blank"
          rel="noreferrer"
        >
          API Key
        </a>
      </div>

      {/* NEW-01: 显眼的一键 Mock 引导，降低首次无 Key 门槛，直接保存 mock preset */}
      <div className="nwa-quick-mock">
        <button
          type="button"
          className="nwa-button nwa-button--ghost"
          disabled={busy}
          onClick={() => {
            // 直接切换到 Mock 预设并保存（无需用户填 Key）
            const mockPreset = PROVIDER_PRESETS.find((p) => p.id === 'mock')!;
            setPresetId(mockPreset.id);
            setBaseUrl(mockPreset.baseUrl);
            setModelName(mockPreset.modelName);
            setApiKey('mock-key-for-demo');
            setSaved(false);
            // 立即保存
            void (async () => {
              if (busy) return;
              setBusy(true);
              try {
                const view = await client.modelConfig.save({
                  baseUrl: 'mock',
                  apiKey: 'mock-key-for-demo',
                  modelName: 'mock-model',
                });
                setBaseUrl(view.baseUrl);
                setModelName(view.modelName);
                setApiKeyMasked(view.apiKeyMasked);
                setApiKey('');
                setSaved(true);
                onSaved?.(view);
              } catch (error) {
                handleError(error);
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          🚀 一键启用 Mock (本地演示) -- 无需任何 Key，立即体验
        </button>
        <span className="nwa-muted" style={{ fontSize: '0.75rem' }}>适合新手快速试用全部 Agent 任务与蓝图分场景流程</span>
      </div>

      {loading ? (
        <p className="nwa-muted">加载中…</p>
      ) : (
        <form
          className="nwa-settings-form"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <div className="nwa-field">
            <span className="nwa-field__label">界面主题</span>
            <div className="nwa-segment" role="tablist" aria-label="界面主题">
              {[
                ['tavern', '酒馆'],
                ['midnight', '夜航'],
                ['paper', '纸页'],
              ].map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={themeMode === mode}
                  className={`nwa-segment__item${themeMode === mode ? ' nwa-segment__item--active' : ''}`}
                  onClick={() => onThemeModeChange?.(mode as 'tavern' | 'midnight' | 'paper')}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="nwa-provider-grid" aria-label="服务商预设">
            {PROVIDER_PRESETS.map((preset) => {
              const selected = preset.id === presetId;
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`nwa-provider-card${selected ? ' nwa-provider-card--active' : ''}`}
                  aria-pressed={selected}
                  disabled={busy}
                  onClick={() => handlePresetChange(preset.id)}
                >
                  <span className="nwa-provider-card__title">{preset.label}</span>
                  <span className="nwa-provider-card__desc">{preset.description}</span>
                </button>
              );
            })}
          </div>

          {presetId.startsWith('deepseek') && !isMockPreset ? (
            <p className="nwa-muted">
              当前使用 DeepSeek 官方 OpenAI 兼容接口。<code>deepseek-chat</code> 和{' '}
              <code>deepseek-reasoner</code> 将于 2026-07-24 15:59 UTC 废弃，本产品默认使用
              V4 Pro。
            </p>
          ) : null}

          <label className="nwa-field">
            <span className="nwa-field__label">Base URL</span>
            <input
              className="nwa-input"
              type="text"
              placeholder="https://api.deepseek.com"
              aria-label="Base URL"
              value={baseUrl}
              disabled={busy}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setPresetId(resolvePresetId(e.target.value, modelName));
                setSaved(false);
              }}
            />
            <span className="nwa-field__hint nwa-muted">
              OpenAI 兼容入口示例：DeepSeek 使用 https://api.deepseek.com。
            </span>
          </label>

          <label className="nwa-field">
            <span className="nwa-field__label">模型名称</span>
            <input
              className="nwa-input"
              type="text"
              placeholder="deepseek-v4-pro"
              aria-label="模型名称"
              value={modelName}
              disabled={busy}
              onChange={(e) => {
                setModelName(e.target.value);
                setPresetId(resolvePresetId(baseUrl, e.target.value));
                setSaved(false);
              }}
            />
            <span className="nwa-field__hint nwa-muted">
              可选官方模型：deepseek-v4-pro、deepseek-v4-flash；deepseek-chat / reasoner 当前映射到 Flash 且将弃用。
            </span>
          </label>

          {isMockPreset ? (
            <div className="nwa-field">
              <span className="nwa-field__label">API Key</span>
              <div className="nwa-input" style={{ background: 'rgba(0,0,0,0.3)', color: 'var(--text-muted)' }}>
                （演示模式，无需真实密钥）
              </div>
              <span className="nwa-field__hint nwa-muted">Mock 模式使用本地模拟响应，不调用任何外部 API。</span>
            </div>
          ) : (
            <label className="nwa-field">
              <span className="nwa-field__label">API Key</span>
              <input
                className="nwa-input"
                type="password"
                autoComplete="off"
                placeholder={hasSavedKey ? '本次已启用（重新输入以更新）' : '输入 API Key'}
                aria-label="API Key"
                value={apiKey}
                disabled={busy}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setSaved(false);
                }}
              />
              {hasSavedKey ? (
                <span className="nwa-field__hint nwa-muted">
                  本次已启用：<code>{apiKeyMasked}</code>
                </span>
              ) : (
                <span className="nwa-field__hint nwa-muted">尚未配置 API Key。</span>
              )}
            </label>
          )}

          <div className="nwa-sampling-grid" aria-label="采样参数">
            <label className="nwa-field">
              <span className="nwa-field__label">温度：{temperature.toFixed(2)}</span>
              <input
                className="nwa-range"
                type="range"
                min="0"
                max="2"
                step="0.05"
                aria-label="温度"
                value={temperature}
                disabled={busy}
                onChange={(e) => {
                  setTemperature(Number(e.target.value));
                  setSaved(false);
                }}
              />
              <span className="nwa-field__hint nwa-muted">0 精确收束，2 更发散。</span>
            </label>
            <label className="nwa-field">
              <span className="nwa-field__label">Top-P：{topP.toFixed(2)}</span>
              <input
                className="nwa-range"
                type="range"
                min="0"
                max="1"
                step="0.05"
                aria-label="Top-P"
                value={topP}
                disabled={busy}
                onChange={(e) => {
                  setTopP(Number(e.target.value));
                  setSaved(false);
                }}
              />
              <span className="nwa-field__hint nwa-muted">1 使用完整候选分布，数值越低越收束。</span>
            </label>
          </div>

          <div className="nwa-row">
            <button
              type="submit"
              className="nwa-button"
              disabled={busy || !canSave}
            >
              {busy ? '启用中…' : '启用本次 API'}
            </button>
            {saved ? <span className="nwa-muted" role="status">本次已启用</span> : null}
          </div>

          <section className="nwa-cache-panel" aria-label="缓存率">
            <div className="nwa-cache-panel__head">
              <div>
                <strong>缓存率</strong>
                <p className="nwa-muted">统计来自模型返回的 usage；DeepSeek 官方接口会自动上报命中 token。</p>
              </div>
              <button
                type="button"
                className="nwa-button nwa-button--ghost"
                disabled={busy}
                onClick={() => void handleResetCacheStats()}
              >
                重置
              </button>
            </div>
            <div className="nwa-cache-stats">
              <div><span>{cacheStats?.hitRatePct ?? 0}%</span><small>命中率</small></div>
              <div><span>{cacheStats?.calls ?? 0}</span><small>调用</small></div>
              <div><span>{cacheStats?.completionTokens ?? 0}</span><small>输出 token</small></div>
              <div><span>{cacheStats?.cacheHitTokens ?? 0}</span><small>命中 token</small></div>
              <div><span>{cacheStats?.cacheMissTokens ?? 0}</span><small>未命中 token</small></div>
            </div>
            {recentCacheRecords.length ? (
              <div className="nwa-cache-recent" aria-label="最近缓存记录">
                {recentCacheRecords.slice(-3).reverse().map((record) => (
                  <div key={`${record.at}-${record.model}`} className="nwa-cache-recent__row">
                    <span>{record.model}</span>
                    <span>{record.hitRatePct}%</span>
                    <span>{record.cacheHitTokens}/{record.promptTokens}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="nwa-muted">还没有模型 usage 记录；跑一次真实写作后这里会显示缓存命中。</p>
            )}
          </section>
        </form>
      )}
    </section>
  );
}

function resolvePresetId(baseUrl: string, modelName: string): string {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/$/, '');
  const normalizedModelName = modelName.trim();
  // Special handling for mock demo preset (exact match on our sentinel values).
  if (normalizedBaseUrl === 'mock' && normalizedModelName === 'mock-model') {
    return 'mock';
  }
  const found = PROVIDER_PRESETS.find(
    (preset) =>
      preset.id !== 'openai-compatible' &&
      preset.baseUrl === normalizedBaseUrl &&
      preset.modelName === normalizedModelName,
  );
  return found?.id ?? 'openai-compatible';
}

// Re-export for callers that want to detect ApiClientError near this panel.
export { isApiClientError };

export default SettingsPanel;
