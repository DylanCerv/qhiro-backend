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
  createFirebaseAuthUser,
  getUserProfile,
  loginDemoUser,
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
    if (isFirebaseAuthConfigured() && admin.apps.length) {
      const session = await signInWithPassword(parsed.data.email, parsed.data.password);
      return c.json({
        uid: session.uid,
        email: session.email,
        token: session.idToken,
      });
    }

    const session = await loginDemoUser(parsed.data.email, parsed.data.password);
    if (!session) {
      return c.json({ error: 'Invalid email or password' }, 401);
    }
    return c.json(session);
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

    let userId: string;
    let userEmail: string;
    let token: string;

    if (isFirebaseAuthConfigured() && admin.apps.length) {
      const session = await signUpWithPassword(email, password);
      userId = session.uid;
      userEmail = session.email;
      token = session.idToken;
    } else {
      const authUser = await createFirebaseAuthUser(email, password, displayName);
      userId = authUser.uid;
      userEmail = authUser.email;
      token = `demo-user:${authUser.uid}`;
    }

    const now = new Date().toISOString();
    const profile: UserProfile = {
      userId,
      email: userEmail,
      displayName,
      role: 'client',
      accountStatus: 'active',
      country,
      location,
      createdAt: now,
      updatedAt: now,
    };
    await upsertUserProfile(profile);

    return c.json({ userId, email: userEmail, token }, 201);
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
    updatedAt: new Date().toISOString(),
  };
  await upsertUserProfile(updated);
  return c.json({ user: updated });
});
