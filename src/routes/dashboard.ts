import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';
import { authenticate, requireRole } from '../middleware/auth.js';

export const dashboardRouter = Router();

dashboardRouter.get('/dashboard', authenticate, async (req: Request, res: Response) => {
  const db = getDb();
  const userId = req.user!.userId;
  const isAdmin = req.user!.role === 'admin';

  if (isAdmin) {
    const [totalUsers, totalEvents, totalRegistrations, eventsByStatus] = await Promise.all([
      db.user.count(),
      db.event.count(),
      db.registration.count(),
      db.event.groupBy({ by: ['status'], _count: { id: true } }),
    ]);

    const statusCounts: Record<string, number> = {};
    for (const row of eventsByStatus) {
      statusCounts[row.status] = row._count.id;
    }

    res.json({
      role: 'admin',
      totals: {
        users: totalUsers,
        events: totalEvents,
        registrations: totalRegistrations,
        eventsByStatus: statusCounts,
      },
    });
    return;
  }

  // Member dashboard
  const now = new Date();

  const [myEvents, myRegistrations, upcomingRegistrations] = await Promise.all([
    db.event.findMany({
      where: { organizerId: userId },
      include: { _count: { select: { registrations: true } } },
      orderBy: { date: 'desc' },
    }),
    db.registration.findMany({
      where: { userId },
      include: { event: { select: { id: true, title: true, date: true, location: true, status: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    db.registration.findMany({
      where: {
        userId,
        status: 'confirmed',
        event: { date: { gte: now }, status: 'published' },
      },
      include: { event: { select: { id: true, title: true, date: true, location: true } } },
      orderBy: { event: { date: 'asc' } },
      take: 10,
    }),
  ]);

  res.json({
    role: 'member',
    myEvents,
    myRegistrations,
    upcoming: upcomingRegistrations,
  });
});
