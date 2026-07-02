/**
 * Unit tests for {@link SettingsPanel} (task 12.8, Requirements 8.5, 8.6).
 *
 * Covers:
 *  - Viewing the persisted model config: loads the masked view on mount and
 *    displays `baseUrl` / `modelName` plus the masked API key, never prefilling
 *    the raw key (Requirement 8.5).
 *  - Updating the config submits the full {@link ModelConfig} via the client.
 *  - Surfacing backend errors via `onError` (Requirement 8.6).
 *
 * The injected client (`Pick<typeof apiClient, 'modelConfig'>`) is mocked with
 * `vi.fn()` so no real network calls happen.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ModelConfigView } from '../types/index.js';
import { SettingsPanel, type SettingsClient } from './SettingsPanel.js';

function makeClient(overrides: Partial<SettingsClient['modelConfig']> = {}): SettingsClient {
  const view: ModelConfigView = {
    baseUrl: 'https://api.deepseek.com',
    modelName: 'deepseek-v4-pro',
    apiKeyMasked: 'sk-****abcd',
    temperature: 0.8,
    topP: 0.9,
  };
  return {
    modelConfig: {
      get: vi.fn().mockResolvedValue(view),
      save: vi.fn().mockResolvedValue(view),
      clear: vi.fn(),
      ...overrides,
    },
    cacheStats: {
      get: vi.fn().mockResolvedValue({
        calls: 2,
        promptTokens: 1000,
        completionTokens: 120,
        cacheHitTokens: 650,
        cacheMissTokens: 350,
        hitRatePct: 65,
        localCache: { hits: 1, misses: 1, lookups: 2, hitRatePct: 50 },
        recent: [
          {
            at: '2026-06-04T00:00:00.000Z',
            model: 'deepseek-v4-pro',
            promptTokens: 1000,
            completionTokens: 120,
            cacheHitTokens: 650,
            cacheMissTokens: 350,
            hitRatePct: 65,
          },
        ],
      }),
      reset: vi.fn().mockResolvedValue({ ok: true }),
    },
  } as unknown as SettingsClient;
}

describe('SettingsPanel', () => {
  it('loads and displays the masked model config on mount (Requirement 8.5)', async () => {
    const client = makeClient();
    render(<SettingsPanel client={client} />);

    expect(await screen.findByDisplayValue('https://api.deepseek.com')).toBeInTheDocument();
    expect(screen.getByDisplayValue('deepseek-v4-pro')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /DeepSeek V4 Pro/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The masked key is shown as a reference; the editable field stays empty.
    expect(screen.getByText('sk-****abcd')).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    expect(screen.getByLabelText('温度')).toHaveValue('0.8');
    expect(screen.getByLabelText('Top-P')).toHaveValue('0.9');
    expect(await screen.findByLabelText('缓存率')).toHaveTextContent('65%');
  });

  it('defaults an empty config to DeepSeek V4 Flash for first-time users', async () => {
    const client = makeClient({
      get: vi.fn().mockResolvedValue({
        baseUrl: '',
        modelName: '',
        apiKeyMasked: '',
        temperature: 1,
        topP: 1,
      }),
    });
    render(<SettingsPanel client={client} />);

    expect(await screen.findByDisplayValue('https://api.deepseek.com')).toBeInTheDocument();
    expect(screen.getByDisplayValue('deepseek-v4-flash')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /DeepSeek V4 Flash/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('can resave a persisted Mock preset without asking for a real API key', async () => {
    const save = vi.fn().mockResolvedValue({
      baseUrl: 'mock',
      modelName: 'mock-model',
      apiKeyMasked: 'mo-****demo',
      temperature: 1,
      topP: 1,
    });
    const client = makeClient({
      get: vi.fn().mockResolvedValue({
        baseUrl: 'mock',
        modelName: 'mock-model',
        apiKeyMasked: 'mo-****demo',
        temperature: 1,
        topP: 1,
      }),
      save,
    });
    render(<SettingsPanel client={client} />);

    expect(await screen.findByText('（演示模式，无需真实密钥）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '启用本次 API' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        baseUrl: 'mock',
        apiKey: 'mock-key-for-demo',
        modelName: 'mock-model',
        temperature: 1,
        topP: 1,
      }),
    );
  });

  it('notifies the app shell when switching UI theme', async () => {
    const client = makeClient();
    const onThemeModeChange = vi.fn();
    render(
      <SettingsPanel
        client={client}
        themeMode="tavern"
        onThemeModeChange={onThemeModeChange}
      />,
    );

    await screen.findByLabelText('界面主题');
    fireEvent.click(screen.getByRole('tab', { name: '夜航' }));
    expect(onThemeModeChange).toHaveBeenCalledWith('midnight');
  });

  it('submits the full config via the client on save', async () => {
    const save = vi.fn().mockResolvedValue({
      baseUrl: 'https://api.deepseek.com',
      modelName: 'deepseek-v4-pro',
      apiKeyMasked: 'sk-****wxyz',
      temperature: 1.25,
      topP: 0.85,
    });
    const client = makeClient({ save });
    const onSaved = vi.fn();
    render(<SettingsPanel client={client} onSaved={onSaved} />);

    await screen.findByDisplayValue('https://api.deepseek.com');

    // The API key must be (re)entered before save is enabled.
    fireEvent.click(screen.getByRole('button', { name: /DeepSeek V4 Pro/ }));
    fireEvent.change(screen.getByLabelText('温度'), { target: { value: '1.25' } });
    fireEvent.change(screen.getByLabelText('Top-P'), { target: { value: '0.85' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-secret-key' } });
    fireEvent.click(screen.getByRole('button', { name: '启用本次 API' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-secret-key',
        modelName: 'deepseek-v4-pro',
        temperature: 1.25,
        topP: 0.85,
      }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('allows a non-technical custom OpenAI-compatible endpoint', async () => {
    const save = vi.fn().mockResolvedValue({
      baseUrl: 'https://gateway.example.com/v1',
      modelName: 'custom-novel-model',
      apiKeyMasked: 'sk-****wxyz',
      temperature: 1,
      topP: 1,
    });
    const client = makeClient({ save });
    render(<SettingsPanel client={client} />);

    await screen.findByDisplayValue('https://api.deepseek.com');
    fireEvent.click(screen.getByRole('button', { name: /自定义 OpenAI 兼容/ }));
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://gateway.example.com/v1' },
    });
    fireEvent.change(screen.getByLabelText('模型名称'), {
      target: { value: 'custom-novel-model' },
    });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-secret-key' } });
    fireEvent.click(screen.getByRole('button', { name: '启用本次 API' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        baseUrl: 'https://gateway.example.com/v1',
        apiKey: 'sk-secret-key',
        modelName: 'custom-novel-model',
        temperature: 0.8,
        topP: 0.9,
      }),
    );
  });

  it('surfaces backend errors via onError when loading fails (Requirement 8.6)', async () => {
    const failure = new Error('读取配置失败');
    const client = makeClient({ get: vi.fn().mockRejectedValue(failure) });
    const onError = vi.fn();
    render(<SettingsPanel client={client} onError={onError} />);

    await waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
  });
});
