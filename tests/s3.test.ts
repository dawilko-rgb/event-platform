import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { getDb, closeDb } from '../src/db.js';

let server: http.Server;
let baseUrl: string;
let memberToken: string;
let adminToken: string;

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

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  process.env.DATABASE_URL = 'file:/tmp/test-s3.db';
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

  const db = getDb();
  await db.activity.deleteMany();
  await db.comment.deleteMany();
  await db.registration.deleteMany();
  await db.event.deleteMany();
  await db.user.deleteMany();

  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Create a member
  const memberRes = await request('POST', '/auth/register', {
    email: 'member@s3test.com',
    name: 'Member S3',
    password: 'password123',
  });
  memberToken = memberRes.body.token;

  // Create admin directly in DB
  const bcrypt = await import('bcrypt');
  const adminHash = await bcrypt.hash('admin123', 10);
  const jwt = await import('jsonwebtoken');
  const adminUser = await db.user.create({
    data: { email: 'admin@s3test.com', name: 'Admin S3', passwordHash: adminHash, role: 'admin' },
  });
  adminToken = jwt.sign(
    { userId: adminUser.id, email: adminUser.email, role: adminUser.role },
    'test-jwt-secret',
    { expiresIn: '15m' }
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});

describe('S3: Auth Middleware + Role Guards', () => {
  it('GET /health does not require auth', async () => {
    const res = await request('GET', '/health');
    expect(res.status).toBe(200);
  });

  it('POST /auth/register does not require auth', async () => {
    const res = await request('POST', '/auth/register', {
      email: 'new@s3test.com',
      name: 'New User',
      password: 'password123',
    });
    expect(res.status).toBe(201);
  });

  it('POST /auth/login does not require auth', async () => {
    const res = await request('POST', '/auth/login', {
      email: 'member@s3test.com',
      password: 'password123',
    });
    expect(res.status).toBe(200);
  });

  it('GET /events — 401 without token', async () => {
    const res = await request('GET', '/events');
    expect(res.status).toBe(401);
  });

  it('GET /events — 200 with valid token', async () => {
    const res = await request('GET', '/events', undefined, authHeader(memberToken));
    expect(res.status).toBe(200);
  });

  it('401 with malformed bearer token', async () => {
    const res = await request('GET', '/events', undefined, { Authorization: 'Bearer not.a.token' });
    expect(res.status).toBe(401);
  });

  it('401 with expired token', async () => {
    const jwt = await import('jsonwebtoken');
    const expiredToken = jwt.sign(
      { userId: 'fake', email: 'x@x.com', role: 'member' },
      'test-jwt-secret',
      { expiresIn: '0s' }
    );
    await new Promise(r => setTimeout(r, 10));
    const res = await request('GET', '/events', undefined, { Authorization: `Bearer ${expiredToken}` });
    expect(res.status).toBe(401);
  });

  it('401 with wrong secret', async () => {
    const jwt = await import('jsonwebtoken');
    const wrongToken = jwt.sign(
      { userId: 'fake', email: 'x@x.com', role: 'member' },
      'wrong-secret',
      { expiresIn: '15m' }
    );
    const res = await request('GET', '/events', undefined, { Authorization: `Bearer ${wrongToken}` });
    expect(res.status).toBe(401);
  });

  it('401 with no Authorization header', async () => {
    const res = await request('GET', '/events', undefined, {});
    expect(res.status).toBe(401);
  });

  it('401 with Authorization header but no Bearer prefix', async () => {
    const res = await request('GET', '/events', undefined, { Authorization: memberToken });
    expect(res.status).toBe(401);
  });

  it('req.user is set correctly after auth', async () => {
    // Verify by testing dashboard which returns role-specific data
    const res = await request('GET', '/dashboard', undefined, authHeader(memberToken));
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('member');
  });

  it('admin token gives admin role access', async () => {
    const res = await request('GET', '/dashboard', undefined, authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
  });
});
