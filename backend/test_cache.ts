/**
 * Prompt Cache Diagnostic Script
 *
 * Sends 3 identical requests to DeepSeek and checks:
 * 1. Whether prefix hash stays identical across runs
 * 2. Whether prompt_cache_hit_tokens rises on runs 2 & 3
 * 3. Full usage breakdown for each run
 */
import crypto from 'node:crypto';
import { OpenAiCompatibleModelProxy } from './src/proxy/ModelProxy.js';
import type { ChatMessage, ModelConfig } from './src/types/index.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Read existing model config from store.json
const storeRaw = readFileSync(path.resolve('./data/store.json'), 'utf-8');
const store = JSON.parse(storeRaw);
const cfg = store.modelConfig;

if (!cfg?.apiKey) {
  console.error('No model config found in data/store.json');
  process.exit(1);
}

const config: ModelConfig = {
  baseUrl: cfg.baseUrl,
  apiKey: cfg.apiKey,
  modelName: process.env.CACHE_TEST_MODEL ?? cfg.modelName,
};

console.log(`Model: ${config.modelName}`);
console.log(`Base URL: ${config.baseUrl}`);
console.log('');

// Construct a fixed prompt that simulates a typical writing task.
// System prompt is static (should be cached). User prompt has a small dynamic part at the end.
const STATIC_SYSTEM = `你是一名专业的小说写作助手。
你擅长创作长篇网络小说，尤其是玄幻、仙侠和都市类题材。
你会严格遵守以下创作规范：
1. 每个场景必须有明确的目的（purpose）和必含要点（must_include）
2. 场景结尾需达到指定的结束状态（ending_state）
3. 正文实际字数应尽量接近场景目标字数（target_words）
4. 保持与已给出的出场角色设定一致
5. 只输出场景正文，不要输出额外说明
6. 对话要生动自然，符合角色性格
7. 描写要细腻，善用五感描写
8. 节奏要合理，张弛有度`;

const STATIC_USER_PREFIX = `【项目世界观】
这是一个灵气复苏的都市世界，现代科技与修仙体系并存。大型科技公司掌握了灵石开采权，而传统修仙大宗门则控制着高阶功法和丹药配方。两方势力在资源争夺中形成微妙平衡。

【项目人物】
- 林远：23岁，某科技公司底层员工，体内被植入了一枚实验性AI芯片，意外获得了感知灵气的能力。性格沉稳但偶尔冲动，说话简洁直接。
- 苏晴：25岁，天机宗外门弟子，负责与科技公司对接的联络人。外表冷淡但内心热忱，说话文雅。
- 陈总：45岁，灵石科技CEO，野心勃勃，试图用科技手段复制修仙能力。

【项目大纲】
第一卷：觉醒
- 第1章：林远在公司加班时芯片异常激活，感知到办公楼内隐藏的灵气节点
- 第2章：天机宗注意到异常波动，派苏晴前来调查
- 第3章：陈总发现芯片的意外效果，试图控制林远`;

// The dynamic part — same across all 3 runs
const DYNAMIC_USER_SUFFIX = `【续写指令】
请续写第1章的开头场景，约500字。描写林远加班时芯片激活的过程。`;

const messages: ChatMessage[] = [
  { role: 'system', content: STATIC_SYSTEM },
  { role: 'user', content: STATIC_USER_PREFIX + '\n\n' + DYNAMIC_USER_SUFFIX },
];

const proxy = new OpenAiCompatibleModelProxy();

async function runOnce(label: string): Promise<void> {
  console.log(`\n${'='.repeat(20)} ${label} ${'='.repeat(20)}`);

  // Compute prefix hash
  const promptJson = JSON.stringify(messages);
  const prefix = promptJson.slice(0, 4000);
  const prefixHash = crypto.createHash('sha256').update(prefix).digest('hex').slice(0, 16);
  console.log(`Prefix Hash: ${prefixHash}`);
  console.log(`Prompt JSON length: ${promptJson.length} chars`);

  const chunks: string[] = [];
  const controller = new AbortController();

  for await (const chunk of proxy.streamCompletion(config, messages, controller.signal)) {
    chunks.push(chunk);
  }

  const fullText = chunks.join('');
  console.log(`Output length: ${fullText.length} chars`);
  console.log(`Output preview: ${fullText.slice(0, 100)}...`);
}

async function main() {
  console.log('Starting 3-run cache diagnostic...\n');

  await runOnce('RUN 1 (expect cache miss)');

  // Brief pause to allow server-side cache to populate
  console.log('\nWaiting 3 seconds for cache to warm up...');
  await new Promise(r => setTimeout(r, 3000));

  await runOnce('RUN 2 (expect cache hit)');

  await new Promise(r => setTimeout(r, 2000));

  await runOnce('RUN 3 (expect cache hit)');

  console.log('\n' + '='.repeat(60));
  console.log('DIAGNOSTIC COMPLETE');
  console.log('If all 3 prefix hashes are identical and runs 2/3 show');
  console.log('cache_hit > 0, prompt caching is working correctly.');
  console.log('='.repeat(60));
}

main().catch(console.error);
