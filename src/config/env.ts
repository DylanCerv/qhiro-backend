import { config } from 'dotenv';

config();

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectId = process.env.FIREBASE_PROJECT_ID ?? '';

export const env = {
  port: Number(process.env.PORT ?? 3001),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  firebaseProjectId: projectId,
  firebaseDatabaseUrl:
    process.env.FIREBASE_DATABASE_URL ||
    (projectId ? `https://${projectId}-default-rtdb.firebaseio.com` : ''),
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? '',
  firebaseWebApiKey: process.env.FIREBASE_WEB_API_KEY ?? '',
  mqttBrokerUrl: process.env.MQTT_BROKER_URL ?? 'mqtt://localhost:1883',
  aiBackendUrl: process.env.AI_BACKEND_URL ?? 'http://localhost:8000',
};

export function loadServiceAccount(): Record<string, unknown> | null {
  if (!env.firebaseServiceAccountPath) return null;
  const path = resolve(env.firebaseServiceAccountPath);
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}
