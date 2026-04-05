import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';
import { authenticate } from '../middleware/auth.js';

export const registrationsRouter = Router();

// POST /events/:id/register
registrationsRouter.post('/events/:id/register', authenticate, async (req: Request, res: Response) => {
  const db = getDb();
  const eventId = String(req.params.id);
  const userId = req.user!.userId;

  const event = await db.event.findUnique({
    where: { id: eventId },
    include: { _count: { select: { registrations: { where: { status: 'confirmed' } } } } },
  });

  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }

  if (event.status !== 'published') {
    res.status(400).json({ error: 'Event is not published' });
    return;
  }

  if (event.organizerId === userId) {
    res.status(400).json({ error: 'Cannot register for your own event' });
    return;
  }

  // Check for existing registration
  const existing = await db.registration.findUnique({
    where: { eventId_userId: { eventId, userId } },
  });
  if (existing) {
    res.status(409).json({ error: 'Already registered for this event' });
    return;
  }

  const confirmedCount = event._count.registrations;
  const status = confirmedCount < event.capacity ? 'confirmed' : 'waitlisted';

  const registration = await db.registration.create({
    data: { eventId, userId, status },
    include: { event: { select: { id: true, title: true } }, user: { select: { id: true, email: true, name: true } } },
  });

  await db.activity.create({
    data: {
      eventId,
      userId,
      action: status === 'confirmed' ? 'registered' : 'waitlisted',
      metadata: JSON.stringify({ registrationId: registration.id }),
    },
  });

  res.status(201).json(registration);
});

// DELETE /events/:id/register — cancel own registration
registrationsRouter.delete('/events/:id/register', authenticate, async (req: Request, res: Response) => {
  const db = getDb();
  const eventId = String(req.params.id);
  const userId = req.user!.userId;

  const registration = await db.registration.findUnique({
    where: { eventId_userId: { eventId, userId } },
  });

  if (!registration) {
    res.status(404).json({ error: 'Registration not found' });
    return;
  }

  const wasConfirmed = registration.status === 'confirmed';

  await db.registration.delete({
    where: { eventId_userId: { eventId, userId } },
  });

  await db.activity.create({
    data: {
      eventId,
      userId,
      action: 'cancelled',
      metadata: JSON.stringify({ registrationId: registration.id }),
    },
  });

  // Auto-promote first waitlisted if confirmed slot freed
  if (wasConfirmed) {
    const firstWaitlisted = await db.registration.findFirst({
      where: { eventId, status: 'waitlisted' },
      orderBy: { createdAt: 'asc' },
    });

    if (firstWaitlisted) {
      await db.registration.update({
        where: { id: firstWaitlisted.id },
        data: { status: 'confirmed' },
      });

      await db.activity.create({
        data: {
          eventId,
          userId: firstWaitlisted.userId,
          action: 'promoted',
          metadata: JSON.stringify({ registrationId: firstWaitlisted.id }),
        },
      });
    }
  }

  res.status(204).send();
});

// GET /events/:id/registrations — organizer/admin only
registrationsRouter.get('/events/:id/registrations', authenticate, async (req: Request, res: Response) => {
  const db = getDb();
  const eventId = String(req.params.id);

  // Allow organizer of this specific event OR admin
  const event = await db.event.findUnique({ where: { id: eventId } });
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }

  const isOrganizer = event.organizerId === req.user!.userId;
  const isAdmin = req.user!.role === 'admin';
  if (!isOrganizer && !isAdmin) {
    res.status(403).json({ error: 'Only the organizer or admin can view registrations' });
    return;
  }

  const registrations = await db.registration.findMany({
    where: { eventId },
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  res.json({ registrations, total: registrations.length });
});

// GET /me/registrations — my registrations
registrationsRouter.get('/me/registrations', authenticate, async (req: Request, res: Response) => {
  const db = getDb();
  const userId = req.user!.userId;

  const registrations = await db.registration.findMany({
    where: { userId },
    include: { event: { select: { id: true, title: true, date: true, location: true, status: true } } },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ registrations, total: registrations.length });
});
