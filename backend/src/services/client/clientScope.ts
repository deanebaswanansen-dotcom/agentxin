import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const CLIENT_ID_HEADER = 'x-agentxin-client-id';
const LOCAL_CLIENT_ID = 'local';
const CLIENT_ID_PATTERN = /^[a-f0-9]{64}$/;

const clientScope = new AsyncLocalStorage<{ clientId: string }>();

function headerValue(request: FastifyRequest): string | undefined {
  const value = request.headers[CLIENT_ID_HEADER];
  return Array.isArray(value) ? value[0] : value;
}

export function isValidClientId(value: string | undefined): value is string {
  return value !== undefined && CLIENT_ID_PATTERN.test(value);
}

export function getCurrentClientId(): string {
  return clientScope.getStore()?.clientId ?? LOCAL_CLIENT_ID;
}

export function runWithClientId<T>(clientId: string, operation: () => T): T {
  if (!isValidClientId(clientId)) {
    throw new Error('Invalid Agentxin client id');
  }
  return clientScope.run({ clientId }, operation);
}

export function registerClientScope(app: FastifyInstance): void {
  const required = process.env.REQUIRE_CLIENT_ID === '1' || process.env.NETLIFY === 'true';

  app.addHook('onRequest', (request, reply, done) => {
    const supplied = headerValue(request);
    if (supplied !== undefined && !isValidClientId(supplied)) {
      void reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: '客户端库标识格式无效' },
      });
      done();
      return;
    }
    if (required && supplied === undefined && request.url.startsWith('/api/')) {
      void reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: '缺少客户端库标识' },
      });
      done();
      return;
    }
    clientScope.run({ clientId: supplied ?? LOCAL_CLIENT_ID }, done);
  });
}
