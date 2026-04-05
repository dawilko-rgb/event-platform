import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { getDb, closeDb } from '../src/db.js';

let server: http.Server;
let baseUrl: string;
let memberToken: string;
let member2Token: string;
let adminToken: string;
let memberId: string;

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
  process.env.DATABASE_URL = 'file:/tmp/test-s4.db';
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

  const r1 = await request('POST', '/auth/register', { email: 'm1@s4.com', name: 'Member One', password: 'pass1234' });
  memberToken = r1.body.token;
  memberId = r1.body.user.id;

  const r2 = await request('POST', '/auth/register', { email: 'm2@s4.com', name: 'Member Two', password: 'pass1234' });
  member2Token = r2.body.token;

  const bcrypt = await import('bcrypt');
  const jwt = await import('jsonwebtoken');
  const adminUser = await db.user.create({
    data: { email: 'admin@s4.com', name: 'Admin', passwordHash: await bcrypt.hash('admin', 10), role: 'admin' },
  });
  adminToken = jwt.sign({ userId: adminUser.id, email: adminUser.email, role: adminUser.role }, 'test-jwt-secret', { expiresIn: '15m' });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});

describe('S4: Event CRUD + Ownership', () => {
  let eventId: string;

  it('POST /events — creates event with required fields', async () => {
    const res = await request('POST', '/events', {
      title: 'Test Event',
      description: 'A test event',
      date: '2025-12-01T10:00:00.000Z',
      location: 'Test City',
      capacity: 50,
    }, auth(memberToken));
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Test Event');
    expect(res.body.status).toBe('draft');
    expect(res.body.organizer).toBeDefined();
    eventId = res.body.id;
  });

  it('POST /events — 400 on missing required fields', async () => {
    const res = await request('POST', '/events', { title: 'No date' }, auth(memberToken));
    expect(res.status).toBe(400);
  });

  it('POST /events — 401 without auth', async () => {
    const res = await request('POST', '/events', {
      title: 'T', description: 'D', date: '2025-12-01T10:00:00.000Z', location: 'L', capacity: 10,
    });
    expect(res.status).toBe(401);
  });

  it('GET /events — returns paginated list of published events', async () => {
    // Publish the event first
    await request('PATCH', `/events/${eventId}/status`, { status: 'published' }, auth(memberToken));

    const res = await request('GET', '/events', undefined, auth(memberToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.limit).toBeDefined();
    expect(res.body.offset).toBeDefined();
  });

  it('GET /events — pagination with limit/offset', async () => {
    const res = await request('GET', '/events?limit=5&offset=0', undefined, auth(memberToken));
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5);
    expect(res.body.offset).toBe(0);
  });

  it('GET /events/:id — returns event with registration count and comment count', async () => {
    const res = await request('GET', `/events/${eventId}`, undefined, auth(memberToken));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(eventId);
    expect(res.body._count).toBeDefined();
    expect(typeof res.body._count.registrations).toBe('number');
    expect(typeof res.body._count.comments).toBe('number');
  });

  it('GET /events/:id — 404 for non-existent event', async () => {
    const res = await request('GET', '/events/nonexistentid', undefined, auth(memberToken));
    expect(res.status).toBe(404);
  });

  it('PUT /events/:id — organizer can update event', async () => {
    const res = await request('PUT', `/events/${eventId}`, { title: 'Updated Title' }, auth(memberToken));
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated Title');
  });

  it('PUT /events/:id — 403 for non-organizer', async () => {
    const res = await request('PUT', `/events/${eventId}`, { title: 'Hacked' }, auth(member2Token));
    expect(res.status).toBe(403);
  });

  it('PUT /events/:id — admin can update any event', async () => {
    const res = await request('PUT', `/events/${eventId}`, { location: 'Admin Updated City' }, auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.location).toBe('Admin Updated City');
  });

  it('PATCH /events/:id/status — organizer can publish event', async () => {
    // Create a fresh draft event
    const createRes = await request('POST', '/events', {
      title: 'Draft Event',
      description: 'To be published',
      date: '2025-12-15T10:00:00.000Z',
      location: 'Somewhere',
      capacity: 20,
    }, auth(memberToken));
    const draftId = createRes.body.id;

    const res = await request('PATCH', `/events/${draftId}/status`, { status: 'published' }, auth(memberToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('published');
  });

  it('PATCH /events/:id/status — 400 on invalid transition', async () => {
    // Try to publish a cancelled event (need to create and cancel one first)
    const createRes = await request('POST', '/events', {
      title: 'Cancel Test',
      description: 'Will be cancelled',
      date: '2025-12-20T10:00:00.000Z',
      location: 'Nowhere',
      capacity: 10,
    }, auth(memberToken));
    const id = createRes.body.id;

    await request('PATCH', `/events/${id}/status`, { status: 'published' }, auth(memberToken));
    await request('PATCH', `/events/${id}/status`, { status: 'cancelled' }, auth(memberToken));

    // Try to publish again after cancellation
    const res = await request('PATCH', `/events/${id}/status`, { status: 'published' }, auth(memberToken));
    expect(res.status).toBe(400);
  });

  it('PATCH /events/:id/status — 403 for non-organizer', async () => {
    const res = await request('PATCH', `/events/${eventId}/status`, { status: 'cancelled' }, auth(member2Token));
    expect(res.status).toBe(403);
  });

  it('Event organizer is set to req.user', async () => {
    const res = await request('GET', `/events/${eventId}`, undefined, auth(memberToken));
    expect(res.body.organizer.id).toBe(memberId);
  });

  it('PUT /events/:id — 404 for non-existent event', async () => {
    const res = await request('PUT', '/events/nosuchid', { title: 'X' }, auth(memberToken));
    expect(res.status).toBe(404);
  });
});
