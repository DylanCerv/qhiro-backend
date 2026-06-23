import type { NotificationEvent } from '../types/index.js';
import { admin } from './firebase.js';

interface NotificationPayload {
  parcelId?: string;
  severity?: number;
  message?: string;
  zoneId?: string;
  npkFormula?: { nitrogen: number; phosphorus: number; potassium: number };
  deviceId?: string;
  batteryLevel?: number;
}

const EVENT_TITLES: Record<NotificationEvent, string> = {
  flightCompleted: 'Flight Completed',
  anomalyDetected: 'Anomaly Detected',
  injectionExecuted: 'Injection Executed',
  emergencyAlert: 'Emergency Alert',
  deviceLowBattery: 'Device Low Battery',
  supplyLow: 'Supply Low',
};

export async function sendNotification(
  userId: string,
  event: NotificationEvent,
  payload: NotificationPayload,
): Promise<void> {
  const title = EVENT_TITLES[event];
  const body = buildBody(event, payload);

  console.log(`[FCM] ${event} → user ${userId}: ${body}`);

  if (!admin.apps.length) return;

  const fs = admin.firestore();
  const userSnap = await fs.collection('users').doc(userId).get();
  const token = userSnap.data()?.fcmToken as string | undefined;
  if (!token) return;

  await admin.messaging().send({
    token,
    notification: { title, body },
    data: {
      event,
      ...stringifyPayload(payload),
    },
  });
}

function buildBody(event: NotificationEvent, payload: NotificationPayload): string {
  switch (event) {
    case 'flightCompleted':
      return `Flight completed for parcel ${payload.parcelId ?? 'unknown'}.`;
    case 'anomalyDetected':
      return `Anomaly detected (severity ${payload.severity}). ${payload.message ?? ''}`;
    case 'injectionExecuted':
      return `NPK injection executed in zone ${payload.zoneId ?? 'unknown'}.`;
    case 'emergencyAlert':
      return `Emergency alert for parcel ${payload.parcelId}. Immediate action required.`;
    case 'deviceLowBattery':
      return `Device ${payload.deviceId} battery at ${payload.batteryLevel}%.`;
    case 'supplyLow':
      return `Supply levels are low for parcel ${payload.parcelId ?? 'unknown'}.`;
    default:
      return 'Qhiro Symbiotic notification';
  }
}

function stringifyPayload(payload: NotificationPayload): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) {
      result[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
  }
  return result;
}
