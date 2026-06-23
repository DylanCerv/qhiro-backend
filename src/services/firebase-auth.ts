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
    console.log('message', message);
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

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  const data = (await response.json()) as {
    error?: { message?: string };
    localId?: string;
    email?: string;
    idToken?: string;
  };

  console.log('data', data);

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
