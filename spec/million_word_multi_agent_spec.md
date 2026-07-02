# 百万字多 Agent 写作 SPEC

## Objective

用户可以一键启动接近百万字的长篇小说生成，并在同一条任务结果里看到章节数量、计划字数、token 消耗、缓存命中和可选成本估算；系统必须通过长期记忆保持剧情、人物、世界规则和文风一致。

## Tech Stack

- Backend: Fastify + TypeScript + Vitest
- Frontend: React + TypeScript + Vite + Vitest
- Provider: existing OpenAI-compatible `ModelProxy` with DeepSeek usage chunks
- Storage: existing `FileDataStore` and `MemoryService`
- Long control plan: `长篇章节控制大纲` generated in 50-chapter chunks before writing

## Commands

```bash
cd backend && npm run typecheck
cd backend && npm test
cd frontend && npm run typecheck
cd frontend && npm test
cd backend && npm run cli -- ping
cd backend && npm run acceptance:long-novel -- --chapters 500 --words 2000 --batch 10
```

## Cost Metrics

`AgentRunResult.metrics` always returns token/cache counters. `estimatedCostUsd` is returned only when these environment variables are set:

```bash
LLM_PROMPT_USD_PER_1M_TOKENS=0.14
LLM_CACHED_PROMPT_USD_PER_1M_TOKENS=0.0028
LLM_COMPLETION_USD_PER_1M_TOKENS=0.28
```

The values above match DeepSeek V4 Flash public pricing checked during implementation; update them when the provider changes prices.

## Project Structure

- `backend/src/services/agent/AgentOrchestrator.ts`: Supervisor and sub-agent orchestration
- `backend/scripts/run-long-novel-acceptance.ts`: resumable paid-model acceptance runner
- `backend/src/proxy/cacheStats.ts`: token/cache usage summary
- `backend/src/types/index.ts`: API request/result contracts
- `frontend/src/components/ChatWorkspace.tsx`: full-novel parameters
- `frontend/src/components/ChatMessageView.tsx`: result metrics display

## Code Style

```ts
const chapterCount = clampInteger(chapters, 1, 500);
const total = clampInteger(totalChapters ?? chapters, 1, 500);
const plannedWords = total * targetWords;
```

Use explicit clamps for user-controlled numeric ranges, keep API keys in runtime config only, and keep long-running behavior resumable by writing each chapter immediately after generation.

## Testing Strategy

- Unit tests verify numeric clamps and usage deltas.
- Unit tests verify batched runs still create chapter anchors through the final `totalChapters` value.
- Existing HTTP SSE E2E verifies `full_novel` progress, chapter persistence and memory persistence.
- Frontend tests verify parameter bounds and result rendering where practical.
- Real DeepSeek tests are manual/integration only and must pass Key through environment variables.

## Boundaries

- Always: keep `.env` and `.env.*` ignored, mask API keys, persist each completed chapter before continuing.
- Ask first: schema migrations, new external dependencies, running a full paid 500-chapter generation.
- Never: write the provided API key into files, logs, tests, README or screenshots.

## Success Criteria

- `full_novel` supports `chapters=500` and `targetWords=2000` as a 1,000,000-word plan.
- Batched `full_novel` supports `chapters=<batch>` plus `totalChapters=500`, and the first batch persists chapter-control anchors through chapter 500.
- `npm run acceptance:long-novel` can resume a long run from `reports/long-run/...` without persisting the API key.
- Result summary includes completed chapter count and planned word count.
- Result metrics include model calls, prompt tokens, completion tokens, cache hit tokens, cache miss tokens, hit rate, local cache hits and local cache misses.
- Reflection memory is updated after each generated chapter.
- Mock E2E and front/back test gates pass.
