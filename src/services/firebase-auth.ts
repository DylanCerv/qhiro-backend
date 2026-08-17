import { env } from '../config/env.js';

export interface AuthSession {
  uid: string;
  email: string;
  idToken: string;
}

function mapAuthError(message: string): string {
  if (
    message.includes('CONFIGURATION_NOT_FOUND') ||
    message.includes('no configuration corresponding')
  ) {
    return [
      'Firebase Authentication is not ready.',
      '1) Open Firebase Console → Authentication → Get started.',
      '2) Enable Email/Password in Sign-in method.',
      '3) Copy the Web API Key from Project settings and set FIREBASE_WEB_API_KEY in qhiro-backend/.env',
    ].join(' ');
  }
  if (message.includes('EMAIL_EXISTS')) {
    return 'This email is already registered. Try logging in instead.';
  }
  if (message.includes('INVALID_LOGIN_CREDENTIALS')) {
    return 'Invalid email or password.';
  }
  if (message.includes('API key not valid')) {
    return 'Invalid FIREBASE_WEB_API_KEY in backend .env. Use the Web API Key from Firebase project settings.';
  }
  return message;
}

function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  const combined = `${message} ${cause}`;
  return (
    combined.includes('fetch failed') ||
    combined.includes('ECONNRESET') ||
    combined.includes('ETIMEDOUT') ||
    combined.includes('ENOTFOUND') ||
    combined.includes('UND_ERR') ||
    combined.includes('AbortError') ||
    combined.includes('TimeoutError')
  );
}

function mapNetworkError(error: unknown): Error {
  if (!isTransientNetworkError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const cause =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  console.error('[Auth] Identity Toolkit request failed:', cause || error);
  return new Error(
    'No se pudo conectar con Firebase Authentication. Revisa tu conexión e inténtalo de nuevo.',
  );
}

async function identityRequest(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Record<string, string>> {
  const apiKey = env.firebaseWebApiKey;
  if (!apiKey) {
    throw new Error(
      'FIREBASE_WEB_API_KEY is missing in backend .env. Get it from Firebase Console → Project settings → General.',
    );
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
        },
      );

      const data = (await response.json()) as {
        error?: { message?: string };
        localId?: string;
        email?: string;
        idToken?: string;
      };

      if (data.error?.message) {
        throw new Error(mapAuthError(data.error.message));
      }

      if (!data.localId || !data.idToken) {
        throw new Error('Unexpected Firebase Authentication response.');
      }

      return {
        localId: data.localId,
        email: data.email ?? String(body.email ?? ''),
        idToken: data.idToken,
      };
    } catch (error) {
      if (error instanceof Error && error.message !== 'fetch failed' && !isTransientNetworkError(error)) {
        throw error;
      }
      lastError = error;
      if (attempt === 1 && isTransientNetworkError(error)) {
        continue;
      }
      throw mapNetworkError(error);
    }
  }

  throw mapNetworkError(lastError);
}

export function isFirebaseAuthConfigured(): boolean {
  return Boolean(env.firebaseWebApiKey && env.firebaseProjectId);
}

export async function signUpWithPassword(
  email: string,
  password: string,
): Promise<AuthSession> {
  const data = await identityRequest('accounts:signUp', {
    email,
    password,
    returnSecureToken: true,
  });

  return {
    uid: data.localId,
    email: data.email,
    idToken: data.idToken,
  };
}

export async function signInWithPassword(
  email: string,
  password: string,
): Promise<AuthSession> {
  const data = await identityRequest('accounts:signInWithPassword', {
    email,
    password,
    returnSecureToken: true,
  });

  return {
    uid: data.localId,
    email: data.email,
    idToken: data.idToken,
  };
}
