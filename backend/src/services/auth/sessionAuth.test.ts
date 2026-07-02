import { afterEach, describe, expect, it } from 'vitest';
import { FileDataStore } from '../../store/FileDataStore.js';
import { buildServer } from '../../index.js';

const ENV_KEYS = [
  'NETLIFY',
  'NODE_ENV',
  'APP_AUTH_DISABLED',
  'APP_AUTH_USERNAME',
  'APP_AUTH_PASSWORD',
  'APP_AUTH_PASSWORD_SHA256',
  'APP_SESSION_SECRET',
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
});

describe('session auth', () => {
  it('protects API routes in production and accepts a signed session cookie', async () => {
    process.env.NETLIFY = 'true';
    process.env.APP_AUTH_USERNAME = 'owner';
    process.env.APP_AUTH_PASSWORD = 'secret-pass';
    process.env.APP_SESSION_SECRET = 'test-session-secret-with-enough-length';

    const app = buildServer(new FileDataStore());
    try {
      const blocked = await app.inject({ method: 'GET', url: '/api/projects' });
      expect(blocked.statusCode).toBe(401);
      expect(blocked.json()).toEqual({
        error: { code: 'AUTH_REQUIRED', message: '请先登录。' },
      });

      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'owner', password: 'secret-pass' },
      });
      expect(login.statusCode).toBe(200);
      const cookie = login.headers['set-cookie'];
      expect(String(cookie)).toContain('agentxin_session=');
      expect(String(cookie)).toContain('HttpOnly');

      const allowed = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { cookie: Array.isArray(cookie) ? cookie[0] : String(cookie) },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('reports missing production auth configuration', async () => {
    process.env.NETLIFY = 'true';
    delete process.env.APP_AUTH_PASSWORD;
    delete process.env.APP_AUTH_PASSWORD_SHA256;
    delete process.env.APP_SESSION_SECRET;

    const app = buildServer(new FileDataStore());
    try {
      const res = await app.inject({ method: 'GET', url: '/api/projects' });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('AUTH_NOT_CONFIGURED');
    } finally {
      await app.close();
    }
  });
});
