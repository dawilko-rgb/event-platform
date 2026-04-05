import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { getDb, closeDb } from '../src/db.js';

let server: http.Server;
let baseUrl: string;
let organizerToken: string;
let organizerId: string;
let registeredMemberToken: string;
let registeredMemberId: string;
let unregisteredMemberToken: string;
let adminToken: string;
let eventId: string;

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
  process.env.DATABASE_URL = 'file:/tmp/test-s6.db';
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

  const r0 = await request('POST', '/auth/register', { email: 'org@s6.com', name: 'Organizer', password: 'pass1234' });
  organizerToken = r0.body.token;
  organizerId = r0.body.user.id;

  const r1 = await request('POST', '/auth/register', { email: 'reg@s6.com', name: 'Registered Member', password: 'pass1234' });
  registeredMemberToken = r1.body.token;
  registeredMemberId = r1.body.user.id;

  const r2 = await request('POST', '/auth/register', { email: 'unreg@s6.com', name: 'Unregistered Member', password: 'pass1234' });
  unregisteredMemberToken = r2.body.token;

  const bcrypt = await import('bcrypt');
  const jwt = await import('jsonwebtoken');
  const adminUser = await db.user.create({
    data: { email: 'admin@s6.com', name: 'Admin', passwordHash: await bcrypt.hash('admin', 10), role: 'admin' },
  });
  adminToken = jwt.sign({ userId: adminUser.id, email: adminUser.email, role: adminUser.role }, 'test-jwt-secret', { expiresIn: '15m' });

  // Create and publish an event
  const evRes = await request('POST', '/events', {
    title: 'S6 Test Event',
    description: 'For comments testing',
    date: '2025-12-01T10:00:00.000Z',
    location: 'Test City',
    capacity: 100,
  }, auth(organizerToken));
  eventId = evRes.body.id;
  await request('PATCH', `/events/${eventId}/status`, { status: 'published' }, auth(organizerToken));

  // Register member
  await request('POST', `/events/${eventId}/register`, undefined, auth(registeredMemberToken));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});

describe('S6: Comments + Activity Feed', () => {
  let commentId: string;

  it('POST /events/:id/comments — registered member can comment', async () => {
    const res = await request('POST', `/events/${eventId}/comments`, { content: 'Hello from member!' }, auth(registeredMemberToken));
    expect(res.status).toBe(201);
    expect(res.body.content).toBe('Hello from member!');
    expect(res.body.author).toBeDefined();
    commentId = res.body.id;
  });

  it('POST /events/:id/comments — organizer can comment', async () => {
    const res = await request('POST', `/events/${eventId}/comments`, { content: 'Organizer comment' }, auth(organizerToken));
    expect(res.status).toBe(201);
    expect(res.body.content).toBe('Organizer comment');
  });

  it('POST /events/:id/comments — 403 for unregistered member', async () => {
    const res = await request('POST', `/events/${eventId}/comments`, { content: 'Should fail' }, auth(unregisteredMemberToken));
    expect(res.status).toBe(403);
  });

  it('POST /events/:id/comments — admin can comment', async () => {
    const res = await request('POST', `/events/${eventId}/comments`, { content: 'Admin comment' }, auth(adminToken));
    expect(res.status).toBe(201);
  });

  it('POST /events/:id/comments — 400 on missing content', async () => {
    const res = await request('POST', `/events/${eventId}/comments`, {}, auth(registeredMemberToken));
    expect(res.status).toBe(400);
  });

  it('GET /events/:id/comments — returns comments newest first', async () => {
    const res = await request('GET', `/events/${eventId}/comments`, undefined, auth(registeredMemberToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.comments)).toBe(true);
    expect(res.body.comments.length).toBeGreaterThan(0);
    expect(res.body.comments[0].author).toBeDefined();
    // Newest first — latest createdAt should be at index 0
    if (res.body.comments.length > 1) {
      const d0 = new Date(res.body.comments[0].createdAt).getTime();
      const d1 = new Date(res.body.comments[1].createdAt).getTime();
      expect(d0).toBeGreaterThanOrEqual(d1);
    }
  });

  it('GET /events/:id/comments — 404 for unknown event', async () => {
    const res = await request('GET', '/events/nosuchid/comments', undefined, auth(registeredMemberToken));
    expect(res.status).toBe(404);
  });

  it('DELETE /comments/:id — owner can delete own comment', async () => {
    const res = await request('DELETE', `/comments/${commentId}`, undefined, auth(registeredMemberToken));
    expect(res.status).toBe(204);
  });

  it('DELETE /comments/:id — 403 for non-owner non-admin', async () => {
    // Create a comment as organizer, try to delete as member
    const cr = await request('POST', `/events/${eventId}/comments`, { content: 'Org comment 2' }, auth(organizerToken));
    const orgCommentId = cr.body.id;
    const res = await request('DELETE', `/comments/${orgCommentId}`, undefined, auth(registeredMemberToken));
    expect(res.status).toBe(403);
  });

  it('DELETE /comments/:id — admin can delete any comment', async () => {
    const cr = await request('POST', `/events/${eventId}/comments`, { content: 'To be admin deleted' }, auth(organizerToken));
    const res = await request('DELETE', `/comments/${cr.body.id}`, undefined, auth(adminToken));
    expect(res.status).toBe(204);
  });

  it('DELETE /comments/:id — 404 for non-existent comment', async () => {
    const res = await request('DELETE', '/comments/nosuchid', undefined, auth(adminToken));
    expect(res.status).toBe(404);
  });

  it('GET /events/:id/activity — returns activity feed', async () => {
    const res = await request('GET', `/events/${eventId}/activity`, undefined, auth(organizerToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.activities)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('Activity feed includes registration and comment actions', async () => {
    const res = await request('GET', `/events/${eventId}/activity`, undefined, auth(organizerToken));
    const actions = res.body.activities.map((a: any) => a.action);
    expect(actions).toContain('registered');
    expect(actions).toContain('commented');
  });
});
