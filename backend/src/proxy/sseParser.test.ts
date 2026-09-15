import { describe, expect, it } from 'vitest';

import { SseDeltaParser } from './sseParser.js';
import { sanitizeProviderDetail } from './ProxyError.js';

describe('SseDeltaParser event framing', () => {
  it.each(['\n', '\r\n', '\r'])('preserves multi-line data split one character at a time with %j endings', (ending) => {
    const wire = [
      ': keepalive', '', 'event: message', 'data: {"choices": [',
      'data: {"delta": {"content": "正文😀"}}]}', '', 'data: [DONE]', '',
    ].join(ending);
    const parser = new SseDeltaParser();
    const deltas = [...wire].flatMap((character) => parser.push(character));
    deltas.push(...parser.flush());
    expect(deltas).toEqual([{ kind: 'content', text: '正文😀' }]);
  });

  it('keeps a split error event type through comments and redacts before throwing', () => {
    const key = 'unusual-provider-key';
    const parser = new SseDeltaParser('test', (detail) => sanitizeProviderDetail(detail, key));
    parser.push('event: err');
    parser.push('or\r');
    parser.push('\n: keepalive\r\ndata: {"message": "rejected ');
    expect(() => parser.push(`${key}"}\r\n\r\n`)).toThrow('rejected [API_KEY]');
  });
});
