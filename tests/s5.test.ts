import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { getDb, closeDb } from '../src/db.js';

let server: http.Server;
let baseUrl: string;
let organizerToken: string;
let organizerId: string;
let member1Token: string;
let member1Id: string;
let member2Token: string;
let member2Id: string;
let member3Token: string;
let adminToken: string;
let adminId: string;
let publishedEventId: string;
let smallCapacityEventId: string;

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
  process.env.DATABASE_URL = 'file:/tmp/test-s5.db';
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

  const r0 = await request('POST', '/auth/register', { email: 'org@s5.com', name: 'Organizer', password: 'pass1234' });
  organizerToken = r0.body.token;
  organizerId = r0.body.user.id;

  const r1 = await request('POST', '/auth/register', { email: 'm1@s5.com', name: 'Member One', password: 'pass1234' });
  member1Token = r1.body.token;
  member1Id = r1.body.user.id;

  const r2 = await request('POST', '/auth/register', { email: 'm2@s5.com', name: 'Member Two', password: 'pass1234' });
  member2Token = r2.body.token;
  member2Id = r2.body.user.id;

  const r3 = await request('POST', '/auth/register', { email: 'm3@s5.com', name: 'Member Three', password: 'pass1234' });
  member3Token = r3.body.token;

  const bcrypt = await import('bcrypt');
  const jwt = await import('jsonwebtoken');
  const adminUser = await db.user.create({
    data: { email: 'admin@s5.com', name: 'Admin', passwordHash: await bcrypt.hash('admin', 10), role: 'admin' },
  });
  adminToken = jwt.sign({ userId: adminUser.id, email: adminUser.email, role: adminUser.role }, 'test-jwt-secret', { expiresIn: '15m' });
  adminId = adminUser.id;

  // Create a published event with capacity 2
  const ev1 = await request('POST', '/events', {
    title: 'Published Event',
    description: 'Test event',
    date: '2025-12-01T10:00:00.000Z',
    location: 'City',
    capacity: 50,
  }, auth(organizerToken));
  publishedEventId = ev1.body.id;
  await request('PATCH', `/events/${publishedEventId}/status`, { status: 'published' }, auth(organizerToken));

  // Create a small capacity event (cap 1) for waitlist testing
  const ev2 = await request('POST', '/events', {
    title: 'Small Capacity Event',
    description: 'Only 1 spot',
    date: '2025-12-05T10:00:00.000Z',
    location: 'Tiny Venue',
    capacity: 1,
  }, auth(organizerToken));
  smallCapacityEventId = ev2.body.id;
  await request('PATCH', `/events/${smallCapacityEventId}/status`, { status: 'published' }, auth(organizerToken));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});

describe('S5: Event Registration + Waitlist', () => {
  it('POST /events/:id/register — member registers successfully (confirmed)', async () => {
    const res = await request('POST', `/events/${publishedEventId}/register`, undefined, auth(member1Token));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('confirmed');
    expect(res.body.userId).toBe(member1Id);
  });

  it('POST /events/:id/register — 409 on duplicate registration', async () => {
    const res = await request('POST', `/events/${publishedEventId}/register`, undefined, auth(member1Token));
    expect(res.status).toBe(409);
  });

  it('POST /events/:id/register — 400 on registering for own event', async () => {
    const res = await request('POST', `/events/${publishedEventId}/register`, undefined, auth(organizerToken));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own event/i);
  });

  it('POST /events/:id/register — 404 for unknown event', async () => {
    const res = await request('POST', '/events/nonexistent/register', undefined, auth(member1Token));
    expect(res.status).toBe(404);
  });

  it('POST /events/:id/register — waitlisted when capacity full', async () => {
    // Fill capacity (1 spot)
    await request('POST', `/events/${smallCapacityEventId}/register`, undefined, auth(member1Token));
    // Second registration goes to waitlist
    const res = await request('POST', `/events/${smallCapacityEventId}/register`, undefined, auth(member2Token));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('waitlisted');
  });

  it('DELETE /events/:id/register — confirmed cancelled + waitlisted auto-promoted', async () => {
    // member1 cancels from smallCapacityEvent → member2 should get promoted
    const delRes = await request('DELETE', `/events/${smallCapacityEventId}/register`, undefined, auth(member1Token));
    expect(delRes.status).toBe(204);

    const db = getDb();
    const m2Reg = await db.registration.findUnique({
      where: { eventId_userId: { eventId: smallCapacityEventId, userId: member2Id } },
    });
    expect(m2Reg?.status).toBe('confirmed');
  });

  it('DELETE /events/:id/register — 404 when not registered', async () => {
    const res = await request('DELETE', `/events/${publishedEventId}/register`, undefined, auth(member3Token));
    expect(res.status).toBe(404);
  });

  it('DELETE /events/:id/register — can cancel own registration', async () => {
    // member2 registers for published event
    await request('POST', `/events/${publishedEventId}/register`, undefined, auth(member2Token));
    const res = await request('DELETE', `/events/${publishedEventId}/register`, undefined, auth(member2Token));
    expect(res.status).toBe(204);
  });

  it('GET /events/:id/registrations — organizer can list registrations', async () => {
    const res = await request('GET', `/events/${publishedEventId}/registrations`, undefined, auth(organizerToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.registrations)).toBe(true);
  });

  it('GET /events/:id/registrations — admin can list registrations', async () => {
    const res = await request('GET', `/events/${publishedEventId}/registrations`, undefined, auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.registrations)).toBe(true);
  });

  it('GET /events/:id/registrations — 403 for regular member', async () => {
    const res = await request('GET', `/events/${publishedEventId}/registrations`, undefined, auth(member1Token));
    expect(res.status).toBe(403);
  });

  it('GET /me/registrations — returns my registrations', async () => {
    const res = await request('GET', '/me/registrations', undefined, auth(member1Token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.registrations)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('Activity log created on registration', async () => {
    // Re-register member1 on publishedEvent and check activity
    await request('POST', `/events/${publishedEventId}/register`, undefined, auth(member1Token));
    const db = getDb();
    const activity = await db.activity.findFirst({
      where: { eventId: publishedEventId, userId: member1Id, action: 'registered' },
    });
    expect(activity).not.toBeNull();
  });

  it('Activity log created on cancellation', async () => {
    const db = getDb();
    const activity = await db.activity.findFirst({
      where: { eventId: smallCapacityEventId, userId: member1Id, action: 'cancelled' },
    });
    expect(activity).not.toBeNull();
  });

  it('Activity log created on promotion', async () => {
    const db = getDb();
    const activity = await db.activity.findFirst({
      where: { eventId: smallCapacityEventId, userId: member2Id, action: 'promoted' },
    });
    expect(activity).not.toBeNull();
  });
});
