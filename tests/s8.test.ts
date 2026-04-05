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

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  process.env.DATABASE_URL = 'file:/tmp/test-s8.db';
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
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});

describe('S8: Integration — Full Lifecycle', () => {
  let organizerToken: string;
  let attendee1Token: string;
  let attendee1Id: string;
  let attendee2Token: string;
  let attendee2Id: string;
  let eventId: string;

  it('1. Register organizer user', async () => {
    const res = await request('POST', '/auth/register', {
      email: 'organizer@lifecycle.com',
      name: 'Event Organizer',
      password: 'secure123',
    });
    expect(res.status).toBe(201);
    organizerToken = res.body.token;
  });

  it('2. Register attendee users', async () => {
    const r1 = await request('POST', '/auth/register', {
      email: 'attendee1@lifecycle.com',
      name: 'Attendee One',
      password: 'secure123',
    });
    expect(r1.status).toBe(201);
    attendee1Token = r1.body.token;
    attendee1Id = r1.body.user.id;

    const r2 = await request('POST', '/auth/register', {
      email: 'attendee2@lifecycle.com',
      name: 'Attendee Two',
      password: 'secure123',
    });
    expect(r2.status).toBe(201);
    attendee2Token = r2.body.token;
    attendee2Id = r2.body.user.id;
  });

  it('3. Create event (draft)', async () => {
    const res = await request('POST', '/events', {
      title: 'Lifecycle Test Event',
      description: 'Full lifecycle test',
      date: '2025-12-01T10:00:00.000Z',
      location: 'Test Venue',
      capacity: 1,
    }, auth(organizerToken));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    eventId = res.body.id;
  });

  it('4. Publish event', async () => {
    const res = await request('PATCH', `/events/${eventId}/status`, { status: 'published' }, auth(organizerToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('published');
  });

  it('5. Attendee 1 registers — confirmed (capacity = 1)', async () => {
    const res = await request('POST', `/events/${eventId}/register`, undefined, auth(attendee1Token));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('confirmed');
  });

  it('6. Attendee 2 registers — waitlisted (capacity full)', async () => {
    const res = await request('POST', `/events/${eventId}/register`, undefined, auth(attendee2Token));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('waitlisted');
  });

  it('7. Verify registrations list shows both statuses', async () => {
    const res = await request('GET', `/events/${eventId}/registrations`, undefined, auth(organizerToken));
    expect(res.status).toBe(200);
    const statuses = res.body.registrations.map((r: any) => r.status);
    expect(statuses).toContain('confirmed');
    expect(statuses).toContain('waitlisted');
  });

  it('8. Attendee 1 cancels — triggers auto-promotion of attendee 2', async () => {
    const res = await request('DELETE', `/events/${eventId}/register`, undefined, auth(attendee1Token));
    expect(res.status).toBe(204);

    const db = getDb();
    const promoted = await db.registration.findUnique({
      where: { eventId_userId: { eventId, userId: attendee2Id } },
    });
    expect(promoted?.status).toBe('confirmed');
  });

  it('9. Activity feed reflects entire lifecycle', async () => {
    const res = await request('GET', `/events/${eventId}/activity`, undefined, auth(organizerToken));
    expect(res.status).toBe(200);
    const actions = res.body.activities.map((a: any) => a.action);
    expect(actions).toContain('status_changed');
    expect(actions).toContain('registered');
    expect(actions).toContain('waitlisted');
    expect(actions).toContain('cancelled');
    expect(actions).toContain('promoted');
  });

  it('10. Cancel event', async () => {
    const res = await request('PATCH', `/events/${eventId}/status`, { status: 'cancelled' }, auth(organizerToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });
});

describe('S8: Integration — Auth Edge Cases', () => {
  const protectedRoutes = [
    ['GET', '/events'],
    ['POST', '/events'],
    ['GET', '/dashboard'],
    ['GET', '/me/registrations'],
  ];

  for (const [method, path] of protectedRoutes) {
    it(`${method} ${path} — rejects without token`, async () => {
      const res = await request(method, path);
      expect(res.status).toBe(401);
    });
  }

  it('Admin-only: registrations list rejects regular member', async () => {
    // Use an existing event from previous test suite context
    const regRes = await request('POST', '/auth/register', {
      email: 'plainmember@s8edge.com',
      name: 'Plain Member',
      password: 'pass1234',
    });
    const memberToken = regRes.body.token;

    const db = getDb();
    const bcrypt = await import('bcrypt');
    const jwt = await import('jsonwebtoken');
    const org = await db.user.create({
      data: { email: 'org2@s8edge.com', name: 'Org2', passwordHash: await bcrypt.hash('p', 10), role: 'member' },
    });
    const orgToken = jwt.sign({ userId: org.id, email: org.email, role: org.role }, 'test-jwt-secret', { expiresIn: '15m' });

    const ev = await request('POST', '/events', {
      title: 'Edge Test Event',
      description: 'Edge',
      date: '2025-12-01T10:00:00.000Z',
      location: 'L',
      capacity: 10,
    }, auth(orgToken));
    await request('PATCH', `/events/${ev.body.id}/status`, { status: 'published' }, auth(orgToken));

    const res = await request('GET', `/events/${ev.body.id}/registrations`, undefined, auth(memberToken));
    expect(res.status).toBe(403);
  });
});

describe('S8: Integration — Edge Cases', () => {
  let memberToken: string;
  let organizerToken: string;
  let organizerId: string;
  let eventId: string;

  beforeAll(async () => {
    const r1 = await request('POST', '/auth/register', {
      email: 'edgemember@s8.com',
      name: 'Edge Member',
      password: 'pass1234',
    });
    memberToken = r1.body.token;

    const r2 = await request('POST', '/auth/register', {
      email: 'edgeorg@s8.com',
      name: 'Edge Organizer',
      password: 'pass1234',
    });
    organizerToken = r2.body.token;
    organizerId = r2.body.user.id;

    const evRes = await request('POST', '/events', {
      title: 'Edge Case Event',
      description: 'For edge testing',
      date: '2025-12-10T10:00:00.000Z',
      location: 'Everywhere',
      capacity: 10,
    }, auth(organizerToken));
    eventId = evRes.body.id;
    await request('PATCH', `/events/${eventId}/status`, { status: 'published' }, auth(organizerToken));
  });

  it('Cannot register for own event — 400', async () => {
    const res = await request('POST', `/events/${eventId}/register`, undefined, auth(organizerToken));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own event/i);
  });

  it('Cannot register twice for same event — 409', async () => {
    await request('POST', `/events/${eventId}/register`, undefined, auth(memberToken));
    const res = await request('POST', `/events/${eventId}/register`, undefined, auth(memberToken));
    expect(res.status).toBe(409);
  });

  it('Cannot comment without registration — 403', async () => {
    // Create new member who is not registered
    const newMember = await request('POST', '/auth/register', {
      email: 'commentnoreg@s8.com',
      name: 'No Reg',
      password: 'pass1234',
    });
    const res = await request('POST', `/events/${eventId}/comments`, { content: 'No reg comment' }, auth(newMember.body.token));
    expect(res.status).toBe(403);
  });

  it('Duplicate email registration returns 409', async () => {
    const res = await request('POST', '/auth/register', {
      email: 'edgemember@s8.com',
      name: 'Dup',
      password: 'pass1234',
    });
    expect(res.status).toBe(409);
  });

  it('Event not found returns 404', async () => {
    const res = await request('GET', '/events/doesnotexist', undefined, auth(memberToken));
    expect(res.status).toBe(404);
  });

  it('Cannot update another user\'s event — 403', async () => {
    const res = await request('PUT', `/events/${eventId}`, { title: 'Stolen' }, auth(memberToken));
    expect(res.status).toBe(403);
  });

  it('Invalid status transition returns 400', async () => {
    // Try going from draft directly to cancelled (need a fresh event)
    const ev = await request('POST', '/events', {
      title: 'Transition Test',
      description: 'For transition',
      date: '2025-12-20T10:00:00.000Z',
      location: 'X',
      capacity: 5,
    }, auth(organizerToken));
    // draft → cancelled is not a valid transition
    const res = await request('PATCH', `/events/${ev.body.id}/status`, { status: 'cancelled' }, auth(organizerToken));
    expect(res.status).toBe(400);
  });
});
