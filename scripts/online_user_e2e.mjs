/**
 * Public-site user journey for AgentXin.
 *
 * Required environment:
 *   TEST_API_KEY   Provider key used only in this browser process.
 * Optional:
 *   TEST_BASE_URL  Public frontend (default: http://101.133.150.84)
 *   TEST_API_BASE_URL  API root when frontend/backend use different local ports
 *   TEST_MODEL     Provider model (default: deepseek-v4-flash)
 *   TEST_SCENARIO  campus | western (default: campus)
 *   TEST_TOTAL_CHAPTERS  Planned novel size (default: 3); one run must still cap at 5.
 */
import { createRequire } from 'node:module';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium } = require('playwright');

const SITE = (process.env.TEST_BASE_URL ?? 'http://101.133.150.84').replace(/\/$/, '');
const API = (process.env.TEST_API_BASE_URL ?? `${SITE}/api`).replace(/\/$/, '');
const API_KEY = process.env.TEST_API_KEY?.trim();
const MODEL = process.env.TEST_MODEL?.trim() || 'deepseek-v4-flash';
const SCENARIO = process.env.TEST_SCENARIO === 'western' ? 'western' : 'campus';
const TOTAL_CHAPTERS = Math.min(500, Math.max(1, Number.parseInt(process.env.TEST_TOTAL_CHAPTERS ?? '3', 10) || 3));
const EXPECTED_BATCH = Math.min(5, TOTAL_CHAPTERS);
const CLIENT_ID = process.env.TEST_CLIENT_ID ?? `e2e${Date.now().toString(16)}`.padEnd(64, '7').slice(0, 64);
const API_HEADERS = { 'X-Agentxin-Client-Id': CLIENT_ID };

if (!API_KEY) throw new Error('TEST_API_KEY is required.');

const scenario = SCENARIO === 'campus'
  ? {
      projectPrefix: '公网校园测试',
      prompt: '写一部现实主义校园悬疑小说：一名普通高中生调查校园广播在深夜播出未来新闻的真相。不要超自然力量，不要玄幻修仙。',
      genre: '校园 + 悬疑 + 现实主义',
      forbiddenQuestion: /魔法|王国|骑士|修仙|灵气|血脉|宗门|仙侠/,
    }
  : {
      projectPrefix: '公网西幻测试',
      prompt: '写一部西方玄幻冒险小说：落魄骑士为阻止边境城被永夜吞没，必须与曾经的敌人合作。不要校园，不要修仙。',
      genre: '西方玄幻 + 冒险',
      forbiddenQuestion: /高考|班主任|校园|宗门|灵气|仙侠/,
    };

function safe(value) {
  return String(value).replace(/sk-[a-zA-Z0-9_-]{8,}/g, '[API_KEY]').slice(0, 500);
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { ...API_HEADERS, ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { ok: response.ok, status: response.status, body };
}

async function main() {
  const startedAt = Date.now();
  const projectName = `${scenario.projectPrefix}${Date.now().toString().slice(-6)}`;
  const detourName = `切换测试${Date.now().toString().slice(-6)}`;
  const report = {
    scenario: SCENARIO,
    clientId: CLIENT_ID,
    projectName,
    plannedChapters: TOTAL_CHAPTERS,
    expectedBatch: EXPECTED_BATCH,
    planRounds: [],
    duplicateQuestions: [],
    offTopicQuestions: [],
    requestErrors: [],
    consoleErrors: [],
    job: null,
    chapters: [],
    restoredResult: false,
    fallbackSteps: [],
    elapsedSeconds: 0,
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      report.consoleErrors.push({ type: message.type(), text: safe(message.text()) });
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      report.requestErrors.push({ status: response.status(), url: response.url().replace(SITE, '') });
    }
  });

  try {
    await page.addInitScript((clientId) => localStorage.setItem('nwa.clientId.v1', clientId), CLIENT_ID);
    await page.goto(SITE, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.getByRole('heading', { name: /小说\s*Agent/ }).waitFor({ timeout: 15_000 });

    await page.getByRole('button', { name: '打开设置' }).click();
    await page.getByRole('button', { name: /DeepSeek V4 Flash/ }).click();
    await page.getByLabel('Base URL').fill('https://api.deepseek.com');
    await page.getByLabel('模型名称').fill(MODEL);
    await page.getByLabel('API Key').fill(API_KEY);
    await page.getByRole('button', { name: '保存并测试 API' }).click();
    await page.getByText(/连接成功|API 连接成功/).waitFor({ timeout: 90_000 });
    await page.getByRole('button', { name: '关闭设置' }).click();
    console.log(JSON.stringify({ phase: 'provider-ready', model: MODEL }));

    await page.getByLabel('新项目名称').fill(projectName);
    await page.keyboard.press('Enter');
    await page.locator('.nwa-project-tree__label', { hasText: projectName }).waitFor({ timeout: 15_000 });

    const input = page.getByRole('textbox', { name: '对话输入' });
    await input.fill(`/计划 ${scenario.prompt}`);
    await page.getByRole('button', { name: '发送' }).click();
    const config = page.getByLabel('小说计划配置');
    await config.waitFor({ timeout: 10_000 });
    await config.getByLabel('全文目标字数').fill(String(TOTAL_CHAPTERS * 800));
    await config.getByLabel('总章节数').fill(String(TOTAL_CHAPTERS));
    await config.getByLabel('单章最少字数').fill('700');
    await config.getByLabel('单章最多字数').fill('900');
    await config.getByLabel('小说类型').fill(scenario.genre);
    await config.getByLabel('额外要求').fill('节奏紧凑，人物选择要有后果，每章必须有明确的剧情推进。');
    await page.getByRole('button', { name: '执行' }).click();

    const seen = new Set();
    for (let round = 1; round <= 6; round += 1) {
      const planCards = page.locator('.nwa-chat__msg--plan');
      await planCards.last().waitFor({ timeout: 120_000 });
      const latest = planCards.last();
      const ready = await latest.locator('.nwa-plan-chat__ready').count();
      if (ready) break;
      const fieldsets = latest.locator('fieldset.nwa-plan-chat__question');
      const count = await fieldsets.count();
      if (count === 0) throw new Error(`第 ${round} 轮无问题也未进入 ready。`);
      const questions = [];
      for (let index = 0; index < count; index += 1) {
        const fieldset = fieldsets.nth(index);
        const text = (await fieldset.locator('legend').innerText()).replace(/\s+/g, ' ').trim();
        questions.push(text);
        const normalized = text.replace(/[？?\s]/g, '');
        if (seen.has(normalized)) report.duplicateQuestions.push(text);
        seen.add(normalized);
        if (scenario.forbiddenQuestion.test(text)) report.offTopicQuestions.push(text);
        await fieldset.locator('button.nwa-plan-chat__option').first().click();
      }
      report.planRounds.push(questions);
      console.log(JSON.stringify({ phase: 'plan-round', round, questions }));
      const cardCountBeforeSubmit = await planCards.count();
      await latest.getByRole('button', { name: '回答全部问题，继续策划' }).click();
      await page.waitForFunction(
        (previousCount) => document.querySelectorAll('.nwa-chat__msg--plan').length > previousCount,
        cardCountBeforeSubmit,
        { timeout: 120_000 },
      );
    }

    const readyCard = page.locator('.nwa-chat__msg--plan').filter({ has: page.locator('.nwa-plan-chat__ready') }).last();
    await readyCard.getByRole('button', { name: '长篇模式生成' }).waitFor({ timeout: 120_000 });
    await readyCard.getByRole('button', { name: '长篇模式生成' }).click();

    const projectList = await api('/projects');
    const project = Array.isArray(projectList.body)
      ? projectList.body.find((item) => item.name === projectName)
      : undefined;
    if (!project?.id) throw new Error('无法找到测试项目 ID。');

    let jobs = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await api(`/projects/${encodeURIComponent(project.id)}/agent-jobs`);
      jobs = Array.isArray(response.body) ? response.body : [];
      if (jobs.length) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!jobs.length) throw new Error('长篇生成未创建后台任务。');
    const jobId = jobs[0].id;

    await page.getByLabel('新项目名称').fill(detourName);
    await page.keyboard.press('Enter');
    await page.locator('.nwa-project-tree__label', { hasText: detourName }).waitFor({ timeout: 15_000 });
    if (await page.getByText(scenario.prompt, { exact: false }).count()) {
      throw new Error('切换到新项目后仍显示旧项目的计划内容。');
    }

    let lastEventCount = -1;
    let finalJob;
    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
      const response = await api(`/agent/jobs/${encodeURIComponent(jobId)}`);
      if (!response.ok) throw new Error(`读取后台任务失败：HTTP ${response.status}`);
      const job = response.body;
      finalJob = job;
      report.job = {
        id: job.id,
        status: job.status,
        attempts: job.attempts,
        eventCount: job.events?.length ?? 0,
        error: job.error,
      };
      if ((job.events?.length ?? 0) !== lastEventCount) {
        lastEventCount = job.events?.length ?? 0;
        console.log(JSON.stringify({ phase: 'job', status: job.status, attempts: job.attempts, events: lastEventCount, latest: job.events?.at(-1)?.message }));
      }
      if (job.status === 'completed') break;
      if (job.status === 'failed' || job.status === 'cancelled') throw new Error(`后台任务${job.status}：${safe(job.error?.message ?? '')}`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (report.job?.status !== 'completed') throw new Error(`20 分钟内未完成 ${EXPECTED_BATCH} 章小说。`);
    report.summary = safe(finalJob?.result?.summary ?? '');
    report.modelCalls = finalJob?.result?.metrics?.modelCalls ?? 0;
    report.fallbackSteps = (finalJob?.result?.steps ?? [])
      .filter((step) => /ChapterPlanner|SceneWriter|蓝图链路/.test(step))
      .map(safe);

    const chapters = await api(`/projects/${encodeURIComponent(project.id)}/chapters`);
    report.chapters = Array.isArray(chapters.body)
      ? chapters.body.map((chapter) => ({
          title: chapter.title,
          chars: chapter.content?.trim().length ?? 0,
          actualWords: Array.from((chapter.content ?? '').replace(/\s/gu, '')).length,
        }))
      : [];
    if (report.chapters.length !== EXPECTED_BATCH || report.chapters.some((chapter) => chapter.chars < 300)) {
      throw new Error(`章节落盘异常：${JSON.stringify(report.chapters)}`);
    }
    if (report.chapters.some((chapter) => chapter.actualWords < 700 || chapter.actualWords > 900)) {
      throw new Error(`章节字数未遵守 700-900 字计划：${JSON.stringify(report.chapters)}`);
    }
    if (/暂停|失败/.test(report.summary)) {
      throw new Error(`小说未完整结束：${report.summary}`);
    }

    await page.locator('.nwa-project-tree__label', { hasText: projectName }).click();
    const summary = finalJob?.result?.summary || '任务完成';
    await page.getByText(summary, { exact: false }).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    report.restoredResult = await page.locator('.nwa-chat__msg--result').count() > 0;
    if (!report.restoredResult) throw new Error('返回原项目后没有恢复后台任务结果。');
  } catch (error) {
    report.failure = safe(error instanceof Error ? error.message : error);
  } finally {
    report.elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    report.consoleErrors = report.consoleErrors.slice(0, 20);
    report.requestErrors = report.requestErrors.slice(0, 30);
    console.log(`FINAL_REPORT ${JSON.stringify(report)}`);
    await browser.close();
  }

  if (report.failure || report.duplicateQuestions.length || report.offTopicQuestions.length || !report.restoredResult) {
    process.exitCode = 1;
  }
}

await main();
