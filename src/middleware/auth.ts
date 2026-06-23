import { createMiddleware } from 'hono/factory';
import { getUserProfile, verifyIdToken } from '../services/firebase.js';
import type { AuthenticatedUser } from '../types/index.js';

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthenticatedUser;
  }
}

export const tokenMiddleware = createMiddleware(async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }

  const token = header.slice(7);
  try {
    const decoded = await verifyIdToken(token);
    c.set('user', {
      uid: decoded.uid,
      email: decoded.email,
      role: 'client',
      accountStatus: 'active',
    });
    await next();
  } catch {
    return c.json({ error: 'Invalid authentication token' }, 401);
  }
});

export const authMiddleware = createMiddleware(async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }

  const token = header.slice(7);
  try {
    const decoded = await verifyIdToken(token);
    const profile = await getUserProfile(decoded.uid);

    if (!profile) {
      return c.json({ error: 'User profile not found. Complete registration first.' }, 403);
    }

    if (profile.accountStatus === 'disabled') {
      return c.json({ error: 'Account disabled. Contact Qhiro Symbiotic support.' }, 403);
    }

    if (profile.accountStatus === 'suspended') {
      return c.json({ error: 'Account temporarily suspended. Please resolve billing to continue.' }, 403);
    }

    c.set('user', {
      uid: decoded.uid,
      email: decoded.email ?? profile.email,
      role: profile.role,
      accountStatus: profile.accountStatus,
      displayName: profile.displayName,
      country: profile.country,
      location: profile.location,
    });
    await next();
  } catch {
    return c.json({ error: 'Invalid authentication token' }, 401);
  }
});
