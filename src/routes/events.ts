import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db.js';
import { authenticate, requireRole } from '../middleware/auth.js';

export const eventsRouter = Router();

const createEventSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  date: z.string().datetime(),
  location: z.string().min(1),
  capacity: z.number().int().positive(),
});

const updateEventSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  date: z.string().datetime().optional(),
  location: z.string().min(1).optional(),
  capacity: z.number().int().positive().optional(),
});

const statusSchema = z.object({
  status: z.enum(['published', 'cancelled']),
});

// POST /events — create event
eventsRouter.post('/events', authenticate, async (req: Request, res: Response) => {
  const parse = createEventSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Validation failed', details: parse.error.flatten() });
    return;
  }

  const { title, description, date, location, capacity } = parse.data;
  const db = getDb();

  const event = await db.event.create({
    data: {
      title,
      description,
      date: new Date(date),
      location,
      capacity,
      organizerId: req.user!.userId,
    },
    include: {
      organizer: { select: { id: true, email: true, name: true } },
    },
  });

  res.status(201).json(event);
});

// GET /events — list published events with pagination + filters
eventsRouter.get('/events', authenticate, async (req: Request, res: Response) => {
  const db = getDb();

  const limit = Math.min(parseInt(String(req.query.limit || '20'), 10), 100);
  const offset = parseInt(String(req.query.offset || '0'), 10);
  const q = req.query.q ? String(req.query.q) : undefined;
  const fromDate = req.query.from ? String(req.query.from) : undefined;
  const toDate = req.query.to ? String(req.query.to) : undefined;
  const statusFilter = req.query.status ? String(req.query.status) : 'published';

  const where: Record<string, unknown> = { status: statusFilter };

  if (q) {
    where['OR'] = [
      { title: { contains: q } },
      { description: { contains: q } },
    ];
    // For case-insensitive search in SQLite, we rely on LIKE which is case-insensitive for ASCII
  }

  if (fromDate || toDate) {
    const dateFilter: Record<string, Date> = {};
    if (fromDate) dateFilter['gte'] = new Date(fromDate);
    if (toDate) dateFilter['lte'] = new Date(toDate);
    where['date'] = dateFilter;
  }

  const [events, total] = await Promise.all([
    db.event.findMany({
      where,
      skip: offset,
      take: limit,
      orderBy: { date: 'asc' },
      include: {
        organizer: { select: { id: true, email: true, name: true } },
        _count: { select: { registrations: true, comments: true } },
      },
    }),
    db.event.count({ where }),
  ]);

  res.json({ events, total, limit, offset });
});

// GET /events/:id — single event
eventsRouter.get('/events/:id', authenticate, async (req: Request, res: Response) => {
  const db = getDb();
  const id = String(req.params.id);

  const event = await db.event.findUnique({
    where: { id },
    include: {
      organizer: { select: { id: true, email: true, name: true } },
      _count: { select: { registrations: true, comments: true } },
    },
  });

  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }

  res.json(event);
});

// PUT /events/:id — update event (organizer or admin)
eventsRouter.put('/events/:id', authenticate, async (req: Request, res: Response) => {
  const parse = updateEventSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Validation failed', details: parse.error.flatten() });
    return;
  }

  const db = getDb();
  const id = String(req.params.id);

  const event = await db.event.findUnique({ where: { id } });
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }

  const isOrganizer = event.organizerId === req.user!.userId;
  const isAdmin = req.user!.role === 'admin';
  if (!isOrganizer && !isAdmin) {
    res.status(403).json({ error: 'Only the organizer or admin can update this event' });
    return;
  }

  const { title, description, date, location, capacity } = parse.data;
  const updated = await db.event.update({
    where: { id },
    data: {
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(date !== undefined && { date: new Date(date) }),
      ...(location !== undefined && { location }),
      ...(capacity !== undefined && { capacity }),
    },
    include: {
      organizer: { select: { id: true, email: true, name: true } },
      _count: { select: { registrations: true, comments: true } },
    },
  });

  res.json(updated);
});

// PATCH /events/:id/status — publish/cancel
eventsRouter.patch('/events/:id/status', authenticate, async (req: Request, res: Response) => {
  const parse = statusSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Validation failed', details: parse.error.flatten() });
    return;
  }

  const db = getDb();
  const id = String(req.params.id);

  const event = await db.event.findUnique({ where: { id } });
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }

  const isOrganizer = event.organizerId === req.user!.userId;
  const isAdmin = req.user!.role === 'admin';
  if (!isOrganizer && !isAdmin) {
    res.status(403).json({ error: 'Only the organizer or admin can change event status' });
    return;
  }

  const { status } = parse.data;

  // Validate status transitions: draft→published, published→cancelled
  const validTransitions: Record<string, string[]> = {
    draft: ['published'],
    published: ['cancelled'],
    cancelled: [],
  };

  if (!validTransitions[event.status]?.includes(status)) {
    res.status(400).json({ error: `Cannot transition from ${event.status} to ${status}` });
    return;
  }

  const updated = await db.event.update({
    where: { id },
    data: { status },
    include: {
      organizer: { select: { id: true, email: true, name: true } },
    },
  });

  // Log activity
  await db.activity.create({
    data: {
      eventId: id,
      userId: req.user!.userId,
      action: 'status_changed',
      metadata: JSON.stringify({ from: event.status, to: status }),
    },
  });

  res.json(updated);
});
