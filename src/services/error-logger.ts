import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const ERROR_LOG_FILE = resolve(process.cwd(), 'logs', 'errors.jsonl');

export interface ErrorLogEntry {
  logId: string;
  createdAt: string;
  scope: string;
  method?: string;
  path?: string;
  message: string;
  code?: string;
  name?: string;
  details?: Record<string, unknown>;
}

function serializeError(error: unknown): Pick<ErrorLogEntry, 'message' | 'code' | 'name'> {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  const withCode = error as Error & {
    code?: string;
    errorInfo?: { code?: string };
  };

  return {
    name: error.name,
    message: error.message,
    code: withCode.code ?? withCode.errorInfo?.code,
  };
}

export function readJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;

  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function tokenDiagnostics(token: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const claims = readJwtClaims(token);
  const iat = typeof claims?.iat === 'number' ? claims.iat : null;
  const exp = typeof claims?.exp === 'number' ? claims.exp : null;

  return {
    tokenLength: token.length,
    tokenParts: token.split('.').length,
    aud: claims?.aud ?? null,
    iss: claims?.iss ?? null,
    sub: claims?.sub ?? null,
    iat,
    exp,
    serverTime: now,
    issuedAgoSeconds: iat === null ? null : now - iat,
    secondsUntilExp: exp === null ? null : exp - now,
  };
}

export async function logError(
  scope: string,
  error: unknown,
  extras: Omit<ErrorLogEntry, 'logId' | 'createdAt' | 'scope' | 'message' | 'code' | 'name'> & {
    details?: Record<string, unknown>;
  } = {},
): Promise<ErrorLogEntry> {
  const serialized = serializeError(error);
  const entry: ErrorLogEntry = {
    logId: randomUUID(),
    createdAt: new Date().toISOString(),
    scope,
    method: extras.method,
    path: extras.path,
    ...serialized,
    details: extras.details,
  };

  console.error(`[ErrorLog] ${scope}: ${serialized.code ?? serialized.message}`);

  try {
    await mkdir(resolve(process.cwd(), 'logs'), { recursive: true });
    await appendFile(ERROR_LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (fileError) {
    console.error(
      '[ErrorLog] Failed to write logs/errors.jsonl:',
      fileError instanceof Error ? fileError.message : fileError,
    );
  }

  persistToFirestore(entry).catch((firestoreError) => {
    console.error(
      '[ErrorLog] Failed to write Firestore errorLogs:',
      firestoreError instanceof Error ? firestoreError.message : firestoreError,
    );
  });

  return entry;
}

async function persistToFirestore(entry: ErrorLogEntry): Promise<void> {
  const { admin } = await import('./firebase.js');
  if (!admin.apps.length) return;
  await admin.firestore().collection('errorLogs').doc(entry.logId).set(entry);
}
