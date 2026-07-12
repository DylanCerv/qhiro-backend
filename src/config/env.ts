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
  firebaseStorageBucket:
    process.env.FIREBASE_STORAGE_BUCKET ||
    (projectId ? `${projectId}.firebasestorage.app` : ''),
  firebaseWebApiKey: process.env.FIREBASE_WEB_API_KEY ?? '',
  firebaseAdminEmail: process.env.FIREBASE_ADMIN_EMAIL ?? '',
  firebaseAdminPassword: process.env.FIREBASE_ADMIN_PASSWORD ?? '',
  firebaseAdminDisplayName: process.env.FIREBASE_ADMIN_DISPLAY_NAME ?? 'Qhiro Symbiotic Admin',
  mqttBrokerUrl: process.env.MQTT_BROKER_URL ?? 'mqtt://localhost:1883',
  mqttUsername: process.env.MQTT_USERNAME ?? '',
  mqttPassword: process.env.MQTT_PASSWORD ?? '',
  mqttClientId: process.env.MQTT_CLIENT_ID ?? '',
  aiBackendUrl: process.env.AI_BACKEND_URL ?? 'http://localhost:8000',
};

export function loadServiceAccount(): Record<string, unknown> | null {
  if (!env.firebaseServiceAccountPath) return null;
  const path = resolve(env.firebaseServiceAccountPath);
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}
