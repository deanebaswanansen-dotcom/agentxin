/**
 * Playwright UI smoke for the current workbench.
 *
 * Assumes:
 * - backend is listening on http://localhost:3000
 * - frontend dev server is listening on http://localhost:5173
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const BASE = process.env.UI_BASE_URL ?? 'http://localhost:5173';
const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3000/api';
// Project data is scoped to a browser client id. Keep direct smoke API calls
// in the same scope as Playwright so setup/cleanup and UI reads see one book.
const CLIENT_ID = process.env.UI_CLIENT_ID ?? '0123456789abcdef'.repeat(4);
const API_HEADERS = { 'X-Agentxin-Client-Id': CLIENT_ID };
const REPORT_DIR = join(process.cwd(), 'reports', 'browser-smoke');
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium } = require('playwright');

async function saveShot(page, name) {
  await mkdir(REPORT_DIR, { recursive: true });
  await page.screenshot({ path: join(REPORT_DIR, name), fullPage: true });
}

async function expectThemeBackground(page, assetName, issues) {
  const backgroundImage = await page.locator('.nwa-tavern-app').evaluate((el) => getComputedStyle(el).backgroundImage);
  if (!backgroundImage.includes(assetName)) {
    issues.push(`主题背景未加载 ${assetName}。`);
  }
}

async function cleanupProjectByName(projectName) {
  if (!projectName) return;
  try {
    const res = await fetch(`${API_BASE}/projects`, { headers: API_HEADERS });
    if (!res.ok) return;
    const projects = await res.json();
    const matches = Array.isArray(projects) ? projects.filter((p) => p.name === projectName) : [];
    await Promise.all(
      matches.map((project) =>
        fetch(`${API_BASE}/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE', headers: API_HEADERS }),
      ),
    );
  } catch {
    // Smoke cleanup is best effort; test result is based on UI assertions.
  }
}

async function findProjectByName(projectName) {
  const res = await fetch(`${API_BASE}/projects`, { headers: API_HEADERS });
  if (!res.ok) return undefined;
  const projects = await res.json();
  return Array.isArray(projects) ? projects.find((project) => project.name === projectName) : undefined;
}

async function createMarkdownSmokeChapter(projectName) {
  const project = await findProjectByName(projectName);
  if (!project?.id) return undefined;
  const createRes = await fetch(`${API_BASE}/projects/${encodeURIComponent(project.id)}/chapters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...API_HEADERS },
    body: JSON.stringify({ title: 'Markdown 烟测章节' }),
  });
  if (!createRes.ok) {
    console.warn(`Markdown 烟测章节创建失败：HTTP ${createRes.status} ${await createRes.text()}`);
    return undefined;
  }
  const chapter = await createRes.json();
  if (!chapter?.id) return undefined;
  await fetch(`${API_BASE}/chapters/${encodeURIComponent(chapter.id)}/content`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...API_HEADERS },
    body: JSON.stringify({
      content: '## 烟测标题\n普通 **重点**\n- 线索\n> 旁白',
    }),
  });
  return chapter;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const issues = [];
  let projectName = '';
  let secondProjectName = '';

  try {
    await page.addInitScript((clientId) => {
      window.localStorage.setItem('nwa:theme-mode', 'tavern');
      window.localStorage.setItem('nwa.clientId.v1', clientId);
    }, CLIENT_ID);
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
    await page.getByRole('heading', { name: /小说\s*Agent/ }).waitFor({ timeout: 15000 });
    await page.locator('[data-empty-illustration="project"]').waitFor({ timeout: 10000 });
    await expectThemeBackground(page, 'bg-tavern.svg', issues);

    await page.getByRole('button', { name: '打开设置' }).click();
    await page.getByRole('tab', { name: '夜航' }).click();
    await expectThemeBackground(page, 'bg-cyber.svg', issues);
    await page.getByRole('tab', { name: '纸页' }).click();
    await expectThemeBackground(page, 'bg-study.svg', issues);
    await page.getByRole('tab', { name: '酒馆' }).click();
    await expectThemeBackground(page, 'bg-tavern.svg', issues);
    await page.getByRole('button', { name: /Mock \(本地演示\)/ }).click();
    // The settings panel now saves and probes the provider in one action;
    // retain compatibility with older builds whose label was just 保存配置.
    await page.getByRole('button', { name: /保存(?:配置|并测试 API)/ }).click();
    await page.getByText(/已保存|连接成功|配置已留在本机/).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '关闭设置' }).click();

    projectName = `UI实测${Date.now().toString().slice(-5)}`;
    await page.getByLabel('新项目名称').fill(projectName);
    await page.keyboard.press('Enter');
    await page.locator('.nwa-project-tree__label', { hasText: projectName }).waitFor({ timeout: 10000 });

    const markdownChapter = await createMarkdownSmokeChapter(projectName);
    if (!markdownChapter) {
      issues.push('Markdown 烟测章节创建失败。');
    } else {
      await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
      await page.getByRole('heading', { name: /小说\s*Agent/ }).waitFor({ timeout: 15000 });
      await page.locator('.nwa-project-tree__label', { hasText: projectName }).click();
      await page.locator('.nwa-project-tree__sublabel', { hasText: 'Markdown 烟测章节' }).click();
      await page.getByRole('button', { name: '预览' }).click();
      await page.getByRole('heading', { name: '烟测标题' }).waitFor({ timeout: 10000 });
      const markdownPreview = page.locator('.nwa-markdown-pane--preview');
      await markdownPreview.getByText('重点').waitFor({ timeout: 10000 });
      await markdownPreview.getByText('线索').waitFor({ timeout: 10000 });
      await markdownPreview.getByText('旁白').waitFor({ timeout: 10000 });
      await page.getByRole('button', { name: '编辑' }).click();
    }

    const input = page.getByRole('textbox', { name: '对话输入' });
    await input.fill('/');
    await page.getByRole('option', { name: /\/审阅 · 主动审阅/ }).click();
    await page.getByRole('button', { name: '执行' }).click();
    await page.getByText('已主动审阅当前项目').waitFor({ timeout: 120000 });
    await page.getByRole('button', { name: /大纲：主动审阅报告/ }).waitFor({ timeout: 15000 });

    await input.fill('/');
    await page.getByRole('option', { name: /\/大纲 · 大纲和设定/ }).click();
    await input.fill('短篇灵异：电梯里多一个人');
    await page.getByRole('button', { name: '执行' }).click();

    await page.getByText('任务完成').waitFor({ timeout: 120000 });
    await page.getByText(/项目：|世界观：|大纲：|章节：/).first().waitFor({ timeout: 15000 });

    // Project chat isolation: a new project must not inherit the previous
    // project's command/result pane, and returning must restore it.
    const uniquePrompt = '短篇灵异：电梯里多一个人';
    const chatPane = page.locator('.nwa-chat-workspace');
    await chatPane.getByText(new RegExp(uniquePrompt)).first().waitFor({ timeout: 10000 });
    secondProjectName = `UI隔离${Date.now().toString().slice(-5)}`;
    await page.getByLabel('新项目名称').fill(secondProjectName);
    await page.keyboard.press('Enter');
    await page.locator('.nwa-project-tree__label', { hasText: secondProjectName }).waitFor({ timeout: 10000 });
    if (await chatPane.getByText(new RegExp(uniquePrompt)).count() !== 0) {
      issues.push('切到新项目后仍显示旧项目的 AI 对话。');
    }
    await page.locator('.nwa-project-tree__label', { hasText: projectName }).click();
    await chatPane.getByText(new RegExp(uniquePrompt)).first().waitFor({ timeout: 10000 });

    await saveShot(page, 'current-desktop-smoke.png');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: /展开侧栏|收起侧栏/ }).click();
    await page.getByRole('navigation', { name: '项目导航' }).waitFor({ timeout: 10000 });
    await page.locator('.nwa-project-tree__label').first().waitFor({ timeout: 10000 });
    const brandBox = await page.locator('.nwa-header-brand').boundingBox();
    const actionsBox = await page.locator('.nwa-header-actions').boundingBox();
    if (brandBox && actionsBox && brandBox.x + brandBox.width > actionsBox.x) {
      issues.push('移动端头部品牌区与操作按钮发生重叠。');
    }
    await saveShot(page, 'current-mobile-sidebar-smoke.png');

    if (issues.length > 0) {
      console.log(JSON.stringify({ ok: false, issues }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ ok: true, issues }, null, 2));
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
    await saveShot(page, 'current-smoke-failure.png').catch(() => undefined);
    console.log(JSON.stringify({ ok: false, issues }, null, 2));
    process.exitCode = 1;
  } finally {
    await cleanupProjectByName(projectName);
    await cleanupProjectByName(secondProjectName);
    await browser.close();
  }
}

main();
