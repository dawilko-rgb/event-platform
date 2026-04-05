import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { getDb, closeDb } from '../src/db.js';

let server: http.Server;
let baseUrl: string;
let memberToken: string;
let memberId: string;
let adminToken: string;
let adminId: string;

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

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  process.env.DATABASE_URL = 'file:/tmp/test-s7.db';
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

  const r1 = await request('POST', '/auth/register', { email: 'member@s7.com', name: 'Member S7', password: 'pass1234' });
  memberToken = r1.body.token;
  memberId = r1.body.user.id;

  const bcrypt = await import('bcrypt');
  const jwt = await import('jsonwebtoken');
  const adminUser = await db.user.create({
    data: { email: 'admin@s7.com', name: 'Admin S7', passwordHash: await bcrypt.hash('admin', 10), role: 'admin' },
  });
  adminToken = jwt.sign({ userId: adminUser.id, email: adminUser.email, role: adminUser.role }, 'test-jwt-secret', { expiresIn: '15m' });
  adminId = adminUser.id;

  // Create test events
  const ev1Res = await request('POST', '/events', {
    title: 'JavaScript Conference 2025',
    description: 'All about JavaScript and TypeScript',
    date: '2025-06-01T10:00:00.000Z',
    location: 'San Francisco',
    capacity: 100,
  }, auth(memberToken));
  await request('PATCH', `/events/${ev1Res.body.id}/status`, { status: 'published' }, auth(memberToken));

  const ev2Res = await request('POST', '/events', {
    title: 'Python Workshop',
    description: 'Learn Python from scratch',
    date: '2025-07-15T10:00:00.000Z',
    location: 'New York',
    capacity: 50,
  }, auth(memberToken));
  await request('PATCH', `/events/${ev2Res.body.id}/status`, { status: 'published' }, auth(memberToken));

  const ev3Res = await request('POST', '/events', {
    title: 'TypeScript Basics',
    description: 'Introduction to TypeScript',
    date: '2025-09-01T10:00:00.000Z',
    location: 'Chicago',
    capacity: 30,
  }, auth(memberToken));
  // leave as draft

  // Register member for the JS conference
  await request('POST', `/events/${ev1Res.body.id}/register`, undefined, auth(memberToken));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});

describe('S7: Search + Filters + Dashboard', () => {
  it('GET /events?q=term — searches title and description', async () => {
    const res = await request('GET', '/events?q=JavaScript', undefined, auth(memberToken));
    expect(res.status).toBe(200);
    const titles = res.body.events.map((e: any) => e.title);
    expect(titles.some((t: string) => t.toLowerCase().includes('javascript'))).toBe(true);
  });

  it('GET /events?q=term — search is case-insensitive', async () => {
    const res = await request('GET', '/events?q=javascript', undefined, auth(memberToken));
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeGreaterThan(0);
  });

  it('GET /events?q=term — search description too', async () => {
    const res = await request('GET', '/events?q=TypeScript', undefined, auth(memberToken));
    expect(res.status).toBe(200);
    // "JavaScript Conference" has "TypeScript" in description; "Python Workshop" doesn't
    expect(res.body.events.length).toBeGreaterThan(0);
  });

  it('GET /events?from=DATE — filters events after date', async () => {
    const res = await request('GET', '/events?from=2025-07-01T00:00:00.000Z', undefined, auth(memberToken));
    expect(res.status).toBe(200);
    for (const event of res.body.events) {
      expect(new Date(event.date).getTime()).toBeGreaterThanOrEqual(new Date('2025-07-01').getTime());
    }
  });

  it('GET /events?to=DATE — filters events before date', async () => {
    const res = await request('GET', '/events?to=2025-06-30T23:59:59.000Z', undefined, auth(memberToken));
    expect(res.status).toBe(200);
    for (const event of res.body.events) {
      expect(new Date(event.date).getTime()).toBeLessThanOrEqual(new Date('2025-06-30T23:59:59').getTime());
    }
  });

  it('GET /events?from=&to= — date range filter', async () => {
    const res = await request('GET', '/events?from=2025-06-01T00:00:00.000Z&to=2025-07-31T23:59:59.000Z', undefined, auth(memberToken));
    expect(res.status).toBe(200);
    for (const event of res.body.events) {
      const d = new Date(event.date).getTime();
      expect(d).toBeGreaterThanOrEqual(new Date('2025-06-01').getTime());
      expect(d).toBeLessThanOrEqual(new Date('2025-07-31T23:59:59').getTime());
    }
  });

  it('GET /events?status=draft — filters by status', async () => {
    const res = await request('GET', '/events?status=draft', undefined, auth(memberToken));
    expect(res.status).toBe(200);
    for (const event of res.body.events) {
      expect(event.status).toBe('draft');
    }
  });

  it('GET /events?status=published — filters published events', async () => {
    const res = await request('GET', '/events?status=published', undefined, auth(memberToken));
    expect(res.status).toBe(200);
    for (const event of res.body.events) {
      expect(event.status).toBe('published');
    }
  });

  it('GET /events — filters combinable with pagination', async () => {
    const res = await request('GET', '/events?q=JavaScript&status=published&limit=5&offset=0', undefined, auth(memberToken));
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5);
    expect(res.body.offset).toBe(0);
    for (const event of res.body.events) {
      expect(event.status).toBe('published');
    }
  });

  it('GET /dashboard — admin gets totals', async () => {
    const res = await request('GET', '/dashboard', undefined, auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
    expect(res.body.totals).toBeDefined();
    expect(typeof res.body.totals.users).toBe('number');
    expect(typeof res.body.totals.events).toBe('number');
    expect(typeof res.body.totals.registrations).toBe('number');
    expect(res.body.totals.eventsByStatus).toBeDefined();
  });

  it('GET /dashboard — member gets my events + registrations + upcoming', async () => {
    const res = await request('GET', '/dashboard', undefined, auth(memberToken));
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('member');
    expect(Array.isArray(res.body.myEvents)).toBe(true);
    expect(Array.isArray(res.body.myRegistrations)).toBe(true);
    expect(Array.isArray(res.body.upcoming)).toBe(true);
  });

  it('GET /dashboard — member myEvents includes organized events', async () => {
    const res = await request('GET', '/dashboard', undefined, auth(memberToken));
    expect(res.body.myEvents.length).toBeGreaterThan(0);
  });

  it('GET /dashboard — 401 without token', async () => {
    const res = await request('GET', '/dashboard');
    expect(res.status).toBe(401);
  });
});
