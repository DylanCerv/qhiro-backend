import { createMiddleware } from 'hono/factory';
import { logError, tokenDiagnostics } from '../services/error-logger.js';
import { admin, getUserProfile, verifyIdToken } from '../services/firebase.js';
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
  } catch (error) {
    await logAuthFailure(c, 'auth.token', token, error);
    return c.json({ error: 'Invalid authentication token' }, 401);
  }
});

export const authMiddleware = createMiddleware(async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }

  const token = header.slice(7);
  let uid = '';

  try {
    const decoded = await verifyIdToken(token);
    uid = decoded.uid;

    const profile = await getUserProfile(decoded.uid);

    if (!profile) {
      return c.json({ error: 'User profile not found. Complete registration first.' }, 403);
    }

    if (profile.accountStatus === 'pending') {
      return c.json(
        {
          error:
            'Tu cuenta está pendiente de activación. Te contactaremos cuando el acceso esté listo.',
        },
        403,
      );
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
  } catch (error) {
    await logAuthFailure(c, uid ? 'auth.profile' : 'auth.verify', token, error);
    return c.json({ error: 'Invalid authentication token' }, 401);
  }
});

async function logAuthFailure(
  c: { req: { method: string; path: string } },
  scope: string,
  token: string,
  error: unknown,
): Promise<void> {
  await logError(scope, error, {
    method: c.req.method,
    path: c.req.path,
    details: {
      ...tokenDiagnostics(token),
      firebaseAdminReady: Boolean(admin.apps.length),
    },
  });
}
