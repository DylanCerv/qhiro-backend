import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware, tokenMiddleware } from '../middleware/auth.js';
import {
  isFirebaseAuthConfigured,
  signInWithPassword,
  signUpWithPassword,
} from '../services/firebase-auth.js';
import {
  admin,
  getUserProfile,
  upsertUserProfile,
} from '../services/firebase.js';
import type { UserProfile } from '../types/index.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  displayName: z.string().min(2),
  country: z.string().min(2).max(2),
  location: z.object({
    lat: z.number(),
    lng: z.number(),
  }),
  fcmToken: z.string().min(10).optional(),
});

const profileUpdateSchema = z.object({
  displayName: z.string().min(2).optional(),
  country: z.string().min(2).max(2).optional(),
  location: z
    .object({
      lat: z.number(),
      lng: z.number(),
    })
    .optional(),
  fcmToken: z.string().min(10).nullable().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const userRoutes = new Hono();

userRoutes.post('/login', async (c) => {
  const body = await c.req.json();
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid login payload', details: parsed.error.flatten() }, 400);
  }

  try {
    if (!isFirebaseAuthConfigured() || !admin.apps.length) {
      return c.json(
        {
          error:
            'Firebase Authentication is not configured. Set FIREBASE_WEB_API_KEY and load the admin service account.',
        },
        500,
      );
    }

    const session = await signInWithPassword(parsed.data.email, parsed.data.password);
    return c.json({
      uid: session.uid,
      email: session.email,
      token: session.idToken,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Login failed';
    return c.json({ error: message }, 401);
  }
});

userRoutes.post('/register', async (c) => {
  const body = await c.req.json();
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid registration payload', details: parsed.error.flatten() }, 400);
  }

  const { email, password, displayName, country, location } = parsed.data;

  try {
    if (admin.apps.length && !isFirebaseAuthConfigured()) {
      return c.json(
        {
          error:
            'FIREBASE_WEB_API_KEY is missing in qhiro-backend/.env. Copy the Web API Key from Firebase Console → Project settings → General (starts with AIza).',
        },
        500,
      );
    }

    if (!isFirebaseAuthConfigured() || !admin.apps.length) {
      return c.json(
        {
          error:
            'Firebase Authentication is not configured. Set FIREBASE_WEB_API_KEY and load the admin service account.',
        },
        500,
      );
    }

    const session = await signUpWithPassword(email, password);

    const now = new Date().toISOString();
    const profile: UserProfile = {
      userId: session.uid,
      email: session.email,
      displayName,
      role: 'client',
      accountStatus: 'active',
      country,
      location,
      createdAt: now,
      updatedAt: now,
    };
    await upsertUserProfile(profile);

    return c.json({ userId: session.uid, email: session.email, token: session.idToken }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Registration failed';
    return c.json({ error: message }, 400);
  }
});

const profileCreateSchema = registerSchema.omit({ password: true });

userRoutes.post('/profile', tokenMiddleware, async (c) => {
  const user = c.get('user');
  const existing = await getUserProfile(user.uid);
  if (existing) {
    return c.json({ user: existing });
  }

  const body = await c.req.json();
  const parsed = profileCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid profile payload', details: parsed.error.flatten() }, 400);
  }

  const now = new Date().toISOString();
  const profile: UserProfile = {
    userId: user.uid,
    email: parsed.data.email ?? user.email ?? '',
    displayName: parsed.data.displayName,
    role: 'client',
    accountStatus: 'active',
    country: parsed.data.country,
    location: parsed.data.location,
    fcmToken: parsed.data.fcmToken,
    createdAt: now,
    updatedAt: now,
  };
  await upsertUserProfile(profile);
  return c.json({ user: profile }, 201);
});

userRoutes.use('/*', authMiddleware);

userRoutes.get('/me', async (c) => {
  const user = c.get('user');
  const profile = await getUserProfile(user.uid);
  return c.json({ user: profile });
});

userRoutes.put('/me', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = profileUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid profile payload', details: parsed.error.flatten() }, 400);
  }

  const existing = await getUserProfile(user.uid);
  if (!existing) {
    return c.json({ error: 'Profile not found' }, 404);
  }

  const updated: UserProfile = {
    ...existing,
    ...parsed.data,
    fcmToken: parsed.data.fcmToken ?? undefined,
    updatedAt: new Date().toISOString(),
  };
  await upsertUserProfile(updated);
  return c.json({ user: updated });
});
