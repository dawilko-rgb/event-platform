import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';
import { authenticate } from '../middleware/auth.js';

export const activityRouter = Router();

// GET /events/:id/activity — combined activity feed
activityRouter.get('/events/:id/activity', authenticate, async (req: Request, res: Response) => {
  const db = getDb();
  const eventId = String(req.params.id);

  const event = await db.event.findUnique({ where: { id: eventId } });
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }

  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10), 100);
  const offset = parseInt(String(req.query.offset || '0'), 10);

  const [activities, total] = await Promise.all([
    db.activity.findMany({
      where: { eventId },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
    }),
    db.activity.count({ where: { eventId } }),
  ]);

  res.json({ activities, total, limit, offset });
});
