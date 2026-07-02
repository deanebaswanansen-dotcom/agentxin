/**
 * Property-based test for the OpenAI-compatible streaming forward path.
 *
 * Covers design.md Correctness **Property 17: 流式增量保序无损转发**
 * (task 8.2; Requirement 5.3): for any sequence of provider content deltas,
 * re-chunked at ARBITRARY byte boundaries on the wire, the deltas forwarded by
 * {@link OpenAiCompatibleModelProxy.streamCompletion} — concatenated in order —
 * must equal the in-order concatenation of the source (non-empty) deltas. No
 * loss, no duplication, no reordering.
 *
 * Method (design.md Testing Strategy): end-to-end through a MOCK provider. We
 * stub the global `fetch` to return a `Response`-like object whose `body` is a
 * `ReadableStream` that emits the SSE wire bytes split at fast-check-chosen
 * chunk sizes (down to a single byte, which forces multi-byte UTF-8 characters
 * to straddle chunk boundaries and exercises the streaming `TextDecoder`).
 *
 * Empty-string deltas carry no information and are dropped by the parser, so
 * they are filtered out of the expected value.
 *
 * Uses fast-check with >= 100 runs. Generators cover ASCII, full Unicode,
 * graphemes/emoji, whitespace, structural markers and long strings.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fc from 'fast-check';

import { OpenAiCompatibleModelProxy } from './ModelProxy.js';
import type { StreamDelta } from './sseParser.js';
import type { ChatMessage, ModelConfig } from '../types/index.js';

const NUM_RUNS = 150;

const CONFIG: ModelConfig = {
  baseUrl: 'https://provider.example.com/v1',
  apiKey: 'sk-property-test-key',
  modelName: 'test-model',
};

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'system prompt' },
  { role: 'user', content: 'write something' },
];

/**
 * Build the SSE wire text for a sequence of content deltas, followed by the
 * terminating `[DONE]` sentinel. JSON.stringify escapes newlines/quotes, so
 * each frame stays on a single physical line regardless of delta contents.
 */
function buildSseWire(deltas: string[]): string {
  let wire = '';
  for (const delta of deltas) {
    const payload = JSON.stringify({ choices: [{ delta: { content: delta } }] });
    wire += `data: ${payload}\n\n`;
  }
  wire += 'data: [DONE]\n\n';
  return wire;
}

/**
 * A `Response`-like stub whose body streams `bytes` split into chunks whose
 * sizes cycle through `chunkSizes`. Only the fields the proxy touches
 * (`ok`, `status`, `body`) are provided.
 */
function makeStreamingResponse(bytes: Uint8Array, chunkSizes: number[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      let i = 0;
      while (offset < bytes.length) {
        const size = chunkSizes[i % chunkSizes.length];
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
        i += 1;
      }
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

async function collect(iterable: AsyncIterable<StreamDelta>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of iterable) {
    if (d.kind === 'content') out.push(d.text);
  }
  return out;
}

/** Delta text generator covering the required edge classes. */
const deltaTextArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.string({ unit: 'binary' }),
  fc.constantFrom(
    '',
    ' ',
    '\n',
    '\t',
    '   ',
    'Hello',
    '世界',
    '日本語のテキスト',
    '😀🎉👨‍👩‍👧‍👦',
    'line1\nline2\r\nline3',
    '"quoted"',
    'back\\slash',
    '[DONE]', // looks like the sentinel, but wrapped in JSON it is real content
    'data: smuggled',
  ),
  fc.string({ minLength: 100, maxLength: 300 }),
);

const deltasArb: fc.Arbitrary<string[]> = fc.array(deltaTextArb, {
  maxLength: 30,
});

// Chunk sizes include 1, which splits multi-byte UTF-8 characters across reads.
const chunkSizesArb: fc.Arbitrary<number[]> = fc.array(
  fc.integer({ min: 1, max: 24 }),
  { minLength: 1, maxLength: 40 },
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAiCompatibleModelProxy streaming', () => {
  it('Feature: novel-writing-agent, Property 17: 流式增量保序无损转发', async () => {
    await fc.assert(
      fc.asyncProperty(deltasArb, chunkSizesArb, async (deltas, chunkSizes) => {
        const wire = buildSseWire(deltas);
        const bytes = new TextEncoder().encode(wire);
        const response = makeStreamingResponse(bytes, chunkSizes);

        const fetchMock = vi.fn(async () => response);
        vi.stubGlobal('fetch', fetchMock);

        const proxy = new OpenAiCompatibleModelProxy();
        const controller = new AbortController();
        const collected = await collect(
          proxy.streamCompletion(CONFIG, MESSAGES, controller.signal),
        );

        // Parser drops empty-string deltas; they carry no information.
        const expected = deltas.filter((d) => d.length > 0).join('');

        // Ordered concatenation must match exactly: no loss/dup/reorder.
        expect(collected.join('')).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
