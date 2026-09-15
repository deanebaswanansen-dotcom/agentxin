import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from './apiClient.js';
import { makeStoryMemory } from '../test/storyMemoryFixture.js';
afterEach(() => vi.unstubAllGlobals());

describe('story memory API contracts', () => {
  it('encodes project/query fields and keeps recovery and CRUD separate from model requests', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(makeStoryMemory()), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch); const client = createApiClient('/api');
    await client.storyMemory.workspace('p/a', { beforeUnit: 4, q: '钥匙 & 信', topK: 3, maxContextChars: 1200 });
    expect(fetch.mock.calls[0][0]).toBe('/api/projects/p%2Fa/story-memory?beforeUnit=4&q=%E9%92%A5%E5%8C%99+%26+%E4%BF%A1&topK=3&maxContextChars=1200');
    await client.storyMemory.retry('p/a');
    expect(fetch.mock.calls[1][0]).toBe('/api/projects/p%2Fa/memory-sync/retry');
    const control = { kind: 'preference' as const, text: '简洁对白', enabled: true, importance: 'advisory' as const, fromUnit: 2 };
    await client.storyMemory.saveControl('p/a', control, 7);
    expect(fetch.mock.calls[2][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ expectedRevision: 7, control }) });
    await client.storyMemory.saveControl('p/a', { ...control, id: 'c/a' }, 8);
    expect(fetch.mock.calls[3][0]).toBe('/api/projects/p%2Fa/story-controls/c%2Fa');
    expect(fetch.mock.calls[3][1].method).toBe('PUT');
    await client.storyMemory.removeControl('p/a', 'c/a', 9);
    expect(fetch.mock.calls[4][1]).toMatchObject({ method: 'DELETE', body: JSON.stringify({ expectedRevision: 9 }) });
    for (const [, init] of fetch.mock.calls) expect(JSON.stringify(init)).not.toContain('modelConfig');
  });

  it('previews and accepts the existing saved chapter using the exact server credential', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch); const client = createApiClient('/api');
    await client.chapters.sourcePreview('chapter/a');
    expect(fetch.mock.calls[0][0]).toBe('/api/chapters/chapter%2Fa/accept-source');
    expect(fetch.mock.calls[0][1].method).toBe('GET');
    await client.chapters.acceptSource('chapter/a', { expectedRevision: 4, expectedContentHash: 'server-frozen-hash' });
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ expectedRevision: 4, expectedContentHash: 'server-frozen-hash' }) });
    expect(fetch.mock.calls[1][1].body).not.toContain('content":');
  });
});
