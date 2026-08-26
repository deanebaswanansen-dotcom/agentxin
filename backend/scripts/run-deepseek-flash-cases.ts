import { OpenAiCompatibleModelProxy } from '../src/proxy/ModelProxy.js';
import type { ChatMessage, ModelConfig } from '../src/types/index.js';

const MODEL = process.env.DEEPSEEK_CASE_MODEL?.trim() || 'deepseek-v4-flash-vision-exp';
const BASE_URL = process.env.DEEPSEEK_CASE_BASE_URL?.trim() || 'https://api.deepseek.com';
const API_KEY = process.env.DEEPSEEK_CASE_API_KEY?.trim();

if (!API_KEY) throw new Error('Set DEEPSEEK_CASE_API_KEY in process memory before running the cases.');

interface ModelCase {
  name: string;
  prompt: string;
  json?: boolean;
  maxTokens?: number;
  validate(content: string): void;
}

function visibleChars(value: string): number {
  return Array.from(value.replace(/\s/gu, '')).length;
}

function jsonObject(content: string): Record<string, unknown> {
  const normalized = content.trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '');
  const parsed = JSON.parse(normalized) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('没有返回 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

function requireText(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} 为空`);
}

const cases: ModelCase[] = [
  {
    name: '01-普通中文输出',
    prompt: '只回复“连接正常”，不要解释。',
    validate: (content) => { if (!content.includes('连接正常')) throw new Error('未按要求返回连接正常'); },
  },
  {
    name: '02-短剧策划JSON',
    json: true,
    prompt: '只输出JSON：为便利店夜班反击短剧提供 title、logline、totalEpisodes，totalEpisodes必须为5。',
    validate: (content) => {
      const value = jsonObject(content);
      requireText(value.title, 'title');
      requireText(value.logline, 'logline');
      if (value.totalEpisodes !== 5) throw new Error('totalEpisodes 不是 5');
    },
  },
  {
    name: '03-分集大纲JSON',
    json: true,
    prompt: '只输出JSON对象，字段 episodeCards 为3项数组；每项必须有 episodeNumber、mainEvent、endingHook，集数依次为1、2、3。',
    validate: (content) => {
      const cards = jsonObject(content).episodeCards;
      if (!Array.isArray(cards) || cards.length !== 3) throw new Error('episodeCards 不是3项');
      cards.forEach((card, index) => {
        const row = card as Record<string, unknown>;
        if (row.episodeNumber !== index + 1) throw new Error(`第${index + 1}张分集卡集数错误`);
        requireText(row.mainEvent, 'mainEvent');
        requireText(row.endingHook, 'endingHook');
      });
    },
  },
  {
    name: '04-人物卡JSON',
    json: true,
    prompt: '只输出JSON对象，创建一名都市短剧女主角，必须包含 name、identity、goal、weakness、speechStyle。',
    validate: (content) => {
      const value = jsonObject(content);
      for (const field of ['name', 'identity', 'goal', 'weakness', 'speechStyle']) requireText(value[field], field);
    },
  },
  {
    name: '05-世界设定JSON',
    json: true,
    prompt: '只输出JSON对象，为当代都市现实短剧生成 era、worldState、rules；rules必须是至少3项字符串数组。',
    validate: (content) => {
      const value = jsonObject(content);
      requireText(value.era, 'era');
      requireText(value.worldState, 'worldState');
      if (!Array.isArray(value.rules) || value.rules.length < 3) throw new Error('rules 少于3项');
    },
  },
  {
    name: '06-临时说话人正文',
    prompt: '只写一小段标准中文短剧正文，必须包含场号“1-1 便利店 夜/内”和说话人“路人甲：”，不要写创作说明。',
    maxTokens: 1_200,
    validate: (content) => {
      if (!/1-1\s+便利店\s+夜\s*\/\s*内/u.test(content)) throw new Error('缺少标准场号');
      if (!/路人甲\s*：/u.test(content)) throw new Error('缺少路人甲对白');
    },
  },
  {
    name: '07-临时角色与真实姓名分类',
    json: true,
    prompt: '只输出JSON对象：temporary数组必须包含“路人甲”和“保安乙”；named数组必须包含“赵铁柱”和“程野”。不要增加其他字段。',
    validate: (content) => {
      const value = jsonObject(content);
      const temporary = Array.isArray(value.temporary) ? value.temporary : [];
      const named = Array.isArray(value.named) ? value.named : [];
      if (!temporary.includes('路人甲') || !temporary.includes('保安乙')) throw new Error('临时角色分类错误');
      if (!named.includes('赵铁柱') || !named.includes('程野')) throw new Error('真实姓名分类错误');
    },
  },
  {
    name: '08-校稿问题JSON',
    json: true,
    prompt: '已登记人物只有沈清。正文中赵铁柱说了对白。只输出JSON对象，issues为数组，至少包含一个 code 为 UNKNOWN_SPEAKER、speaker 为赵铁柱的问题。',
    validate: (content) => {
      const issues = jsonObject(content).issues;
      if (!Array.isArray(issues) || !issues.some((issue) => {
        const row = issue as Record<string, unknown>;
        return row.code === 'UNKNOWN_SPEAKER' && row.speaker === '赵铁柱';
      })) throw new Error('没有识别未登记的赵铁柱');
    },
  },
  {
    name: '09-正文定向修改',
    prompt: '只输出修改后的两句短剧正文：把“保安：不能进”改成说话人“保安乙”，并增加动作“△保安乙拦住门。”，不要解释。',
    validate: (content) => {
      if (!/保安乙\s*：/u.test(content) || !/△\s*保安乙拦住门/u.test(content)) throw new Error('定向修改未落实');
    },
  },
  {
    name: '10-较长正文不为空',
    prompt: '只输出一段450至650个中文可见字符的现实题材短剧正文，包含动作和对白，不要标题，不要解释。',
    maxTokens: 2_000,
    validate: (content) => {
      const count = visibleChars(content);
      if (count < 300 || count > 900) throw new Error(`正文可见字符数异常：${count}`);
    },
  },
];

const proxy = new OpenAiCompatibleModelProxy();
const config: ModelConfig = {
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  modelName: MODEL,
  temperature: 0.2,
  topP: 1,
};

const report: Array<{ name: string; ok: boolean; milliseconds: number; visibleChars?: number; error?: string }> = [];

for (const modelCase of cases) {
  const startedAt = Date.now();
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: '你是 AgentXin 的短剧生产测试模型。严格遵守输出格式，不解释。' },
      { role: 'user', content: modelCase.prompt },
    ];
    const chunks: string[] = [];
    for await (const delta of proxy.streamCompletion(
      config,
      messages,
      AbortSignal.timeout(120_000),
      {
        jsonMode: modelCase.json === true,
        disableThinking: true,
        maxTokens: modelCase.maxTokens ?? 900,
        temperature: 0.2,
      },
    )) {
      if (delta.kind === 'content') chunks.push(delta.text);
    }
    const content = chunks.join('').trim();
    if (!content) throw new Error('模型返回空内容');
    modelCase.validate(content);
    report.push({
      name: modelCase.name,
      ok: true,
      milliseconds: Date.now() - startedAt,
      visibleChars: visibleChars(content),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.push({
      name: modelCase.name,
      ok: false,
      milliseconds: Date.now() - startedAt,
      error: message.replaceAll(API_KEY, '[API_KEY]'),
    });
  }
}

const passed = report.filter((item) => item.ok).length;
process.stdout.write(`${JSON.stringify({ model: MODEL, passed, total: cases.length, report }, null, 2)}\n`);
if (passed !== cases.length) process.exitCode = 1;
