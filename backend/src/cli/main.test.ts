import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from './main.js';

describe('NovelAgent CLI', () => {
  let dir: string;
  const oldEnv = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'novel-agent-cli-'));
    process.env = { ...oldEnv, LLM_PROVIDER: 'mock', LLM_MODEL: 'mock-model' };
  });

  afterEach(async () => {
    process.env = oldEnv;
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the required novel project structure', async () => {
    await runCli(['init', '--project', 'projects/demo', '--title', 'Demo', '--genre', 'fantasy,web'], dir);

    for (const path of [
      'projects/demo/bible/premise.md',
      'projects/demo/bible/world.md',
      'projects/demo/bible/characters.md',
      'projects/demo/outline/chapter-list.md',
      'projects/demo/chapters',
      'projects/demo/reviews',
      'projects/demo/state.json',
    ]) {
      expect(existsSync(join(dir, path))).toBe(true);
    }
  });

  it('runs MVP commands in mock mode and refuses chapter overwrite by default', async () => {
    await runCli(['init', '--project', 'projects/demo', '--title', 'Demo'], dir);
    await runCli(['idea', '--project', 'projects/demo', '--seed', '都市异能'], dir);
    await runCli(['outline', '--project', 'projects/demo', '--chapters', '3', '--overwrite'], dir);
    await runCli(['write', '--project', 'projects/demo', '--chapter', '1', '--title', '开端'], dir);
    await expect(
      runCli(['write', '--project', 'projects/demo', '--chapter', '1', '--title', '开端'], dir),
    ).rejects.toThrow('使用 --overwrite');
    await runCli(['summary', '--project', 'projects/demo'], dir);
    await runCli(['check', '--project', 'projects/demo', '--chapter', '1'], dir);
    await runCli(['export', '--project', 'projects/demo', '--format', 'markdown'], dir);

    const exported = await readFile(join(dir, 'projects/demo/exports/novel.md'), 'utf8');
    expect(exported).toContain('MOCK_OUTPUT');
    expect(existsSync(join(dir, 'projects/demo/reviews/ch001.review.md'))).toBe(true);
  });

  it('pings mock provider without reading an API key', async () => {
    delete process.env.LLM_API_KEY;
    const result = await runCli(['ping'], dir);
    expect(result).toContain('"ok": true');
    expect(result).toContain('"provider": "mock"');
    expect(result).toContain('当前使用 Mock 模型');
  });

  it('persists a current workspace so project commands can omit --project', async () => {
    await runCli(['init', '--project', 'projects/current', '--title', 'Current'], dir);

    const workspace = await runCli(['workspace'], dir);
    expect(workspace).toContain('projects\\current');

    const result = await runCli(['idea', '--seed', '悬疑便利店'], dir);
    expect(result).toContain('[progress] 读取当前工作区');
    expect(result).toContain('当前使用 Mock 模型');
    expect(existsSync(join(dir, 'projects/current/bible/premise.md'))).toBe(true);
  });
});
