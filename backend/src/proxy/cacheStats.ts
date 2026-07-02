/** In-memory prompt cache stats from provider usage chunks (DeepSeek / OpenAI). */

export interface CacheUsageRecord {
  at: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  hitRatePct: number;
}

export interface CacheStatsSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  hitRatePct: number;
  localCache: {
    hits: number;
    misses: number;
    lookups: number;
    hitRatePct: number;
  };
  recent: CacheUsageRecord[];
}

const records: CacheUsageRecord[] = [];
const MAX_RECORDS = 500;

let totals = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
};

// 本地响应缓存（CachingModelProxy）统计：与服务端 prompt-token 缓存相互独立。
// localHits：整次请求命中本地磁盘缓存、完全跳过模型调用的次数。
// localMisses：未命中、真正打到提供商的次数。
let localCache = {
  hits: 0,
  misses: 0,
};

/** 记录一次本地响应缓存命中（整次调用被磁盘缓存直接满足）。 */
export function recordLocalCacheHit(): void {
  localCache.hits += 1;
}

/** 记录一次本地响应缓存未命中（请求真正发往提供商）。 */
export function recordLocalCacheMiss(): void {
  localCache.misses += 1;
}

export function recordCacheUsage(
  model: string,
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  },
): void {
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const cacheHit =
    usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheMiss = usage.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHit);
  if (promptTokens <= 0 && cacheHit <= 0 && completionTokens <= 0) return;

  totals.calls += 1;
  totals.promptTokens += promptTokens;
  totals.completionTokens += completionTokens;
  totals.cacheHitTokens += cacheHit;
  totals.cacheMissTokens += cacheMiss;

  const hitRatePct = promptTokens > 0 ? (cacheHit / promptTokens) * 100 : 0;
  records.push({
    at: new Date().toISOString(),
    model,
    promptTokens,
    completionTokens,
    cacheHitTokens: cacheHit,
    cacheMissTokens: cacheMiss,
    hitRatePct: Math.round(hitRatePct * 10) / 10,
  });
  if (records.length > MAX_RECORDS) records.shift();
}

export function getCacheStatsSummary(): CacheStatsSummary {
  const hitRatePct =
    totals.promptTokens > 0
      ? Math.round((totals.cacheHitTokens / totals.promptTokens) * 1000) / 10
      : 0;
  const localLookups = localCache.hits + localCache.misses;
  const localHitRatePct =
    localLookups > 0 ? Math.round((localCache.hits / localLookups) * 1000) / 10 : 0;
  return {
    calls: totals.calls,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    cacheHitTokens: totals.cacheHitTokens,
    cacheMissTokens: totals.cacheMissTokens,
    hitRatePct,
    localCache: {
      hits: localCache.hits,
      misses: localCache.misses,
      lookups: localLookups,
      hitRatePct: localHitRatePct,
    },
    recent: records.slice(-20),
  };
}

export function resetCacheStats(): void {
  records.length = 0;
  totals = { calls: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
  localCache = { hits: 0, misses: 0 };
}
