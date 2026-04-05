import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db.js';
import { authenticate } from '../middleware/auth.js';

export const commentsRouter = Router();

const createCommentSchema = z.object({
  content: z.string().min(1),
});

// POST /events/:id/comments — must be registered or organizer
commentsRouter.post('/events/:id/comments', authenticate, async (req: Request, res: Response) => {
  const parse = createCommentSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Validation failed', details: parse.error.flatten() });
    return;
  }

  const db = getDb();
  const eventId = String(req.params.id);
  const userId = req.user!.userId;

  const event = await db.event.findUnique({ where: { id: eventId } });
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }

  const isOrganizer = event.organizerId === userId;
  const isAdmin = req.user!.role === 'admin';

  if (!isOrganizer && !isAdmin) {
    // Must be registered (confirmed or waitlisted)
    const registration = await db.registration.findUnique({
      where: { eventId_userId: { eventId, userId } },
    });
    if (!registration) {
      res.status(403).json({ error: 'Must be registered for the event to comment' });
      return;
    }
  }

  const comment = await db.comment.create({
    data: { content: parse.data.content, eventId, authorId: userId },
    include: { author: { select: { id: true, email: true, name: true } } },
  });

  await db.activity.create({
    data: {
      eventId,
      userId,
      action: 'commented',
      metadata: JSON.stringify({ commentId: comment.id }),
    },
  });

  res.status(201).json(comment);
});

// GET /events/:id/comments — newest first with author info
commentsRouter.get('/events/:id/comments', authenticate, async (req: Request, res: Response) => {
  const db = getDb();
  const eventId = String(req.params.id);

  const event = await db.event.findUnique({ where: { id: eventId } });
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }

  const comments = await db.comment.findMany({
    where: { eventId },
    include: { author: { select: { id: true, email: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ comments, total: comments.length });
});

// DELETE /comments/:id — own or admin
commentsRouter.delete('/comments/:id', authenticate, async (req: Request, res: Response) => {
  const db = getDb();
  const id = String(req.params.id);
  const userId = req.user!.userId;

  const comment = await db.comment.findUnique({ where: { id } });
  if (!comment) {
    res.status(404).json({ error: 'Comment not found' });
    return;
  }

  const isOwner = comment.authorId === userId;
  const isAdmin = req.user!.role === 'admin';
  if (!isOwner && !isAdmin) {
    res.status(403).json({ error: 'Cannot delete another user\'s comment' });
    return;
  }

  await db.comment.delete({ where: { id } });
  res.status(204).send();
});
