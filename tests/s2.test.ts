import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { getDb, closeDb } from '../src/db.js';

let server: http.Server;
let baseUrl: string;

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data).toString() } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        let parsed: any;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode!, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = 'file:/tmp/test-s2.db';
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

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

describe('S2: Auth', () => {
  it('POST /auth/register — creates user and returns token', async () => {
    const res = await request('POST', '/auth/register', {
      email: 'user1@test.com',
      name: 'User One',
      password: 'password123',
    });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.email).toBe('user1@test.com');
    expect(res.body.user.role).toBe('member');
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('POST /auth/register — 409 on duplicate email', async () => {
    const res = await request('POST', '/auth/register', {
      email: 'user1@test.com',
      name: 'Another',
      password: 'password123',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already registered/i);
  });

  it('POST /auth/register — 400 on missing fields', async () => {
    const res = await request('POST', '/auth/register', { email: 'bad@test.com' });
    expect(res.status).toBe(400);
  });

  it('POST /auth/register — 400 on invalid email', async () => {
    const res = await request('POST', '/auth/register', {
      email: 'not-an-email',
      name: 'Test',
      password: 'password123',
    });
    expect(res.status).toBe(400);
  });

  it('POST /auth/register — 400 on short password', async () => {
    const res = await request('POST', '/auth/register', {
      email: 'short@test.com',
      name: 'Test',
      password: 'abc',
    });
    expect(res.status).toBe(400);
  });

  it('POST /auth/login — returns token with valid credentials', async () => {
    const res = await request('POST', '/auth/login', {
      email: 'user1@test.com',
      password: 'password123',
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.email).toBe('user1@test.com');
  });

  it('POST /auth/login — 401 on wrong password', async () => {
    const res = await request('POST', '/auth/login', {
      email: 'user1@test.com',
      password: 'wrongpassword',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid credentials/i);
  });

  it('POST /auth/login — 401 on unknown email', async () => {
    const res = await request('POST', '/auth/login', {
      email: 'nobody@test.com',
      password: 'password123',
    });
    expect(res.status).toBe(401);
  });

  it('POST /auth/login — 400 on missing fields', async () => {
    const res = await request('POST', '/auth/login', { email: 'user1@test.com' });
    expect(res.status).toBe(400);
  });

  it('POST /auth/refresh — returns new JWT from valid refresh token', async () => {
    const loginRes = await request('POST', '/auth/login', {
      email: 'user1@test.com',
      password: 'password123',
    });
    const { refreshToken } = loginRes.body;

    const res = await request('POST', '/auth/refresh', { refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('POST /auth/refresh — 401 on invalid refresh token', async () => {
    const res = await request('POST', '/auth/refresh', { refreshToken: 'invalid.token.here' });
    expect(res.status).toBe(401);
  });

  it('POST /auth/refresh — 400 on missing refresh token', async () => {
    const res = await request('POST', '/auth/refresh', {});
    expect(res.status).toBe(400);
  });

  it('JWT contains userId, email, role', async () => {
    const loginRes = await request('POST', '/auth/login', {
      email: 'user1@test.com',
      password: 'password123',
    });
    const { token } = loginRes.body;
    // Decode without verifying (base64)
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    expect(payload.userId).toBeTruthy();
    expect(payload.email).toBe('user1@test.com');
    expect(payload.role).toBe('member');
  });
});
