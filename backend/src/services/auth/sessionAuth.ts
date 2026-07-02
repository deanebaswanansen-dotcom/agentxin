import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const SESSION_COOKIE = 'agentxin_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface AuthSessionView {
  authRequired: boolean;
  configured: boolean;
  authenticated: boolean;
  username?: string;
}

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

interface AuthConfig {
  required: boolean;
  configured: boolean;
  username: string;
  password?: string;
  passwordSha256?: string;
  sessionSecret?: string;
  secureCookie: boolean;
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function buildAuthConfig(): AuthConfig {
  const disabled = envValue('APP_AUTH_DISABLED') === 'true';
  const productionLike = process.env.NETLIFY === 'true' || process.env.NODE_ENV === 'production';
  const password = envValue('APP_AUTH_PASSWORD');
  const passwordSha256 = envValue('APP_AUTH_PASSWORD_SHA256');
  const sessionSecret = envValue('APP_SESSION_SECRET');
  const required = !disabled && (productionLike || password !== undefined || passwordSha256 !== undefined);
  return {
    required,
    configured: sessionSecret !== undefined && (password !== undefined || passwordSha256 !== undefined),
    username: envValue('APP_AUTH_USERNAME') ?? 'admin',
    password,
    passwordSha256,
    sessionSecret,
    secureCookie: productionLike,
  };
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    result[key] = decodeURIComponent(value);
  }
  return result;
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function createSessionToken(username: string, secret: string): string {
  const payload = base64url(JSON.stringify({
    sub: username,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  }));
  return `${payload}.${sign(payload, secret)}`;
}

function verifySessionToken(token: string | undefined, secret: string | undefined): string | undefined {
  if (!token || !secret) return undefined;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return undefined;
  const expected = sign(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.sub !== 'string' || typeof parsed.exp !== 'number') return undefined;
    if (parsed.exp <= Math.floor(Date.now() / 1000)) return undefined;
    return parsed.sub;
  } catch {
    return undefined;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function passwordMatches(password: string, config: AuthConfig): boolean {
  if (config.passwordSha256 !== undefined) {
    return safeEqualText(sha256(password), config.passwordSha256.toLowerCase());
  }
  if (config.password !== undefined) {
    return safeEqualText(password, config.password);
  }
  return false;
}

function cookieHeader(name: string, value: string, config: AuthConfig): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (config.secureCookie) parts.push('Secure');
  return parts.join('; ');
}

function clearCookieHeader(config: AuthConfig): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.secureCookie) parts.push('Secure');
  return parts.join('; ');
}

function currentUsername(request: FastifyRequest, config: AuthConfig): string | undefined {
  const cookies = parseCookies(request.headers.cookie);
  return verifySessionToken(cookies[SESSION_COOKIE], config.sessionSecret);
}

function sessionView(request: FastifyRequest, config: AuthConfig): AuthSessionView {
  const username = currentUsername(request, config);
  return {
    authRequired: config.required,
    configured: config.configured,
    authenticated: !config.required || username !== undefined,
    username,
  };
}

function isPublicAuthPath(path: string): boolean {
  return path === '/api/auth/session' || path === '/api/auth/login' || path === '/api/auth/logout';
}

export function registerSessionAuth(app: FastifyInstance): void {
  const config = buildAuthConfig();

  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (!path.startsWith('/api/') || isPublicAuthPath(path)) return;
    if (!config.required) return;
    if (!config.configured) {
      return reply.code(503).send({
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: '站点登录未配置，请在 Netlify 环境变量设置 APP_AUTH_PASSWORD 和 APP_SESSION_SECRET。',
        },
      });
    }
    if (currentUsername(request, config) === undefined) {
      return reply.code(401).send({
        error: { code: 'AUTH_REQUIRED', message: '请先登录。' },
      });
    }
  });

  app.get('/api/auth/session', async (request) => sessionView(request, config));

  app.post<{ Body: LoginBody }>('/api/auth/login', async (request, reply) => {
    if (!config.required) return sessionView(request, config);
    if (!config.configured || config.sessionSecret === undefined) {
      return reply.code(503).send({
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: '站点登录未配置，请在 Netlify 环境变量设置 APP_AUTH_PASSWORD 和 APP_SESSION_SECRET。',
        },
      });
    }

    const username = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (username !== config.username || !passwordMatches(password, config)) {
      return reply.code(401).send({
        error: { code: 'AUTH_INVALID', message: '账号或密码错误。' },
      });
    }

    reply.header('Set-Cookie', cookieHeader(SESSION_COOKIE, createSessionToken(username, config.sessionSecret), config));
    return { authRequired: true, configured: true, authenticated: true, username };
  });

  app.post('/api/auth/logout', async (_request, reply: FastifyReply) => {
    reply.header('Set-Cookie', clearCookieHeader(config));
    return { ok: true };
  });
}
