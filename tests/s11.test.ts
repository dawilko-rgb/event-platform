import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { getDb, closeDb } from '../src/db.js';

let server: http.Server;
let baseUrl: string;

function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data).toString() } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          const resHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') resHeaders[k] = v;
            else if (Array.isArray(v)) resHeaders[k] = v[0];
          }
          resolve({ status: res.statusCode!, body: parsed, headers: resHeaders });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = 'file:/tmp/test-s11.db';
  process.env.JWT_SECRET = 'test-jwt-secret-s11';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-s11';
  process.env.CORS_ORIGIN = 'https://example.com';
  process.env.RATE_LIMIT_ENABLED = 'true';

  const db = getDb();
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Clean state
  await db.activity.deleteMany();
  await db.comment.deleteMany();
  await db.registration.deleteMany();
  await db.event.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});

// ─── AC1: Timing-safe auth ───────────────────────────────────────────────────
describe('S11 AC1: JWT timing-safe comparison', () => {
  it('rejects a tampered JWT with 401', async () => {
    const res = await request('GET', '/events', undefined, {
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ4In0.invalidsig',
    });
    expect(res.status).toBe(401);
  });

  it('rejects a completely fake token with 401', async () => {
    const res = await request('GET', '/events', undefined, {
      Authorization: 'Bearer not.a.token',
    });
    expect(res.status).toBe(401);
  });
});

// ─── AC2: Parameterised queries (no raw SQL paths exposed) ───────────────────
describe('S11 AC2: Parameterised Prisma queries', () => {
  it('SQL injection attempt in event query returns safe 401 (not a DB error)', async () => {
    const res = await request('GET', "/events?q=' OR '1'='1");
    // Without auth we get 401, never a 500 from raw SQL injection
    expect(res.status).toBe(401);
  });

  it('SQL injection attempt in auth email returns 400 or 401, not 500', async () => {
    const res = await request('POST', '/auth/login', {
      email: "' OR 1=1--",
      password: 'anything',
    });
    expect([400, 401]).toContain(res.status);
  });
});

// ─── AC3: Zod validation on POST/PUT bodies ───────────────────────────────────
describe('S11 AC3: Zod validation', () => {
  it('POST /auth/register — 400 on missing name', async () => {
    const res = await request('POST', '/auth/register', {
      email: 'zod@test.com',
      password: 'password123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/validation/i);
  });

  it('POST /auth/register — 400 on invalid email format', async () => {
    const res = await request('POST', '/auth/register', {
      email: 'not-an-email',
      name: 'Test',
      password: 'password123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/validation/i);
  });

  it('POST /auth/login — 400 on empty body', async () => {
    const res = await request('POST', '/auth/login', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/validation/i);
  });

  it('POST /auth/refresh — 400 on missing refreshToken', async () => {
    const res = await request('POST', '/auth/refresh', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/validation/i);
  });
});

// ─── AC4: Rate limiting on /auth/* ───────────────────────────────────────────
describe('S11 AC4: Rate limiting on /auth/*', () => {
  it('eventually returns 429 after exceeding 10 requests to /auth/* within the window', async () => {
    // Drain remaining quota and confirm rate limiting fires.
    // Prior tests in this file have already consumed some of the 10-request window.
    // Send up to 15 requests; we expect a 429 to appear once the quota is exhausted.
    const results: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await request('POST', '/auth/login', {
        email: `ratelimit${i}@test.com`,
        password: 'pw',
      });
      results.push(res.status);
    }
    expect(results).toContain(429);
  });

  it('non-auth routes are not rate limited by the auth limiter', async () => {
    // /health is not under /auth/* so the auth rate limiter should not apply
    // even when /auth/* is exhausted
    const res = await request('GET', '/health');
    expect(res.status).not.toBe(429);
  });

  it('rate-limited response includes RateLimit headers', async () => {
    // Already over the limit from the previous test
    const res = await request('POST', '/auth/login', {
      email: 'ratelimit-headers@test.com',
      password: 'pw',
    });
    expect(res.status).toBe(429);
    const headerKeys = Object.keys(res.headers).map((k) => k.toLowerCase());
    const hasRateLimitHeader = headerKeys.some((k) => k.startsWith('ratelimit'));
    expect(hasRateLimitHeader).toBe(true);
  });
});

// ─── AC5: CORS locked to CORS_ORIGIN ─────────────────────────────────────────
describe('S11 AC5: CORS origin', () => {
  it('allows requests from the configured CORS_ORIGIN', async () => {
    const res = await request('OPTIONS', '/health', undefined, {
      Origin: 'https://example.com',
      'Access-Control-Request-Method': 'GET',
    });
    // CORS preflight or simple — Access-Control-Allow-Origin should match
    const acao = res.headers['access-control-allow-origin'];
    expect(acao).toBe('https://example.com');
  });

  it('does not echo back an arbitrary disallowed origin', async () => {
    const res = await request('GET', '/health', undefined, {
      Origin: 'https://evil.com',
    });
    const acao = res.headers['access-control-allow-origin'];
    // Should NOT reflect the evil origin
    expect(acao).not.toBe('https://evil.com');
  });
});

// ─── AC6: Helmet security headers ────────────────────────────────────────────
describe('S11 AC6: Helmet security headers', () => {
  it('sets X-Content-Type-Options: nosniff', async () => {
    const res = await request('GET', '/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options header', async () => {
    const res = await request('GET', '/health');
    expect(res.headers['x-frame-options']).toBeTruthy();
  });
});
