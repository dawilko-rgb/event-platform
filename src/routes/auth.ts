import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { getDb } from '../db.js';

export const authRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  skip: () => process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_ENABLED !== 'true',
});

export const authRouter = Router();

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET must be set in production');
    }
    return 'dev-secret-not-for-production';
  }
  return secret;
}

function getRefreshSecret(): string {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_REFRESH_SECRET must be set in production');
    }
    return 'dev-refresh-secret-not-for-production';
  }
  return secret;
}

function signAccessToken(payload: { userId: string; email: string; role: string }): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '15m' });
}

function signRefreshToken(payload: { userId: string; email: string; role: string }): string {
  return jwt.sign(payload, getRefreshSecret(), { expiresIn: '7d' });
}

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(6),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

authRouter.post('/auth/register', authRateLimiter, async (req: Request, res: Response) => {
  const parse = registerSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Validation failed', details: parse.error.flatten() });
    return;
  }

  const { email, name, password } = parse.data;
  const db = getDb();

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await db.user.create({
    data: { email, name, passwordHash },
  });

  const payload = { userId: user.id, email: user.email, role: user.role };
  const token = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  res.status(201).json({ token, refreshToken, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

authRouter.post('/auth/login', authRateLimiter, async (req: Request, res: Response) => {
  const parse = loginSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Validation failed', details: parse.error.flatten() });
    return;
  }

  const { email, password } = parse.data;
  const db = getDb();

  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const payload = { userId: user.id, email: user.email, role: user.role };
  const token = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  res.json({ token, refreshToken, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

authRouter.post('/auth/refresh', authRateLimiter, async (req: Request, res: Response) => {
  const parse = refreshSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Validation failed', details: parse.error.flatten() });
    return;
  }

  const { refreshToken } = parse.data;

  let decoded: { userId: string; email: string; role: string };
  try {
    decoded = jwt.verify(refreshToken, getRefreshSecret()) as { userId: string; email: string; role: string };
  } catch {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
    return;
  }

  const db = getDb();
  const user = await db.user.findUnique({ where: { id: String(decoded.userId) } });
  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }

  const payload = { userId: user.id, email: user.email, role: user.role };
  const token = signAccessToken(payload);

  res.json({ token });
});
