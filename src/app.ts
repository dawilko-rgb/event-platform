import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { eventsRouter } from './routes/events.js';
import { registrationsRouter } from './routes/registrations.js';
import { commentsRouter } from './routes/comments.js';
import { activityRouter } from './routes/activity.js';
import { dashboardRouter } from './routes/dashboard.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
  app.use(express.json({ limit: '1mb' }));

  // Public routes
  app.use('/', healthRouter);
  app.use('/', authRouter);

  // Protected routes
  app.use('/', eventsRouter);
  app.use('/', registrationsRouter);
  app.use('/', commentsRouter);
  app.use('/', activityRouter);
  app.use('/', dashboardRouter);

  // Error handler
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
