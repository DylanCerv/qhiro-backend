import { randomUUID } from 'node:crypto';
import type { AiAnalysisResponse, NotificationEvent } from '../types/index.js';
import { createAlert } from './firebase.js';
import { sendSensorCommand } from './mqtt.js';
import { sendNotification } from './notifications.js';
import { generateAndStoreReport } from './reports.js';

interface DecisionContext {
  userId: string;
  parcelId: string;
  zoneId: string;
  analysis: AiAnalysisResponse;
}

export async function applyDecisionEngine(ctx: DecisionContext): Promise<void> {
  const { userId, parcelId, zoneId, analysis } = ctx;
  const { severity, diagnosis, recommendedAction } = analysis;

  if (severity < 0.3) {
    console.log(`[DecisionEngine] Severity ${severity} — log only for parcel ${parcelId}`);
    return;
  }

  if (severity >= 0.3 && severity < 0.6) {
    await notify(userId, parcelId, severity, diagnosis, 'anomalyDetected');
    return;
  }

  if (severity >= 0.6 && severity < 0.8) {
    await notify(userId, parcelId, severity, diagnosis, 'anomalyDetected');
    await triggerInjection(userId, parcelId, zoneId, analysis);
    await generateAndStoreReport(userId, parcelId, analysis);
    return;
  }

  if (severity >= 0.8) {
    await notify(userId, parcelId, severity, diagnosis, 'emergencyAlert');
    await triggerInjection(userId, parcelId, zoneId, analysis);
    await generateAndStoreReport(userId, parcelId, analysis);
    await scheduleEmergencyRescan(userId, parcelId);
    console.log(`[DecisionEngine] Emergency mode activated for parcel ${parcelId}`);
  }

  if (recommendedAction === 'monitor' && severity < 0.6) {
    await notify(userId, parcelId, severity, diagnosis, 'anomalyDetected');
  }
}

async function notify(
  userId: string,
  parcelId: string,
  severity: number,
  message: string,
  event: NotificationEvent,
): Promise<void> {
  const alertId = randomUUID();
  await createAlert(userId, {
    alertId,
    userId,
    parcelId,
    severity,
    message,
    event,
    createdAt: new Date().toISOString(),
    read: false,
  });
  await sendNotification(userId, event, { parcelId, severity, message });
}

async function triggerInjection(
  userId: string,
  parcelId: string,
  zoneId: string,
  analysis: AiAnalysisResponse,
): Promise<void> {
  const sensorId = `sensor_${zoneId}`;
  sendSensorCommand(sensorId, {
    action: 'inject',
    parcelId,
    zoneId,
    npkFormula: analysis.recommendedNpkFormula,
    timestamp: new Date().toISOString(),
  });
  await sendNotification(userId, 'injectionExecuted', {
    parcelId,
    zoneId,
    npkFormula: analysis.recommendedNpkFormula,
  });
}

async function scheduleEmergencyRescan(userId: string, parcelId: string): Promise<void> {
  const rescanAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  console.log(`[DecisionEngine] Emergency rescan scheduled at ${rescanAt} for parcel ${parcelId}`);
  const { upsertSchedule } = await import('./firebase.js');
  await upsertSchedule(userId, {
    scheduleId: `emergency_${parcelId}`,
    userId,
    parcelId,
    scheduleType: 'emergency',
    startTime: rescanAt,
    frequencyDays: 1,
    enabled: true,
    lastRunAt: null,
    nextRunAt: rescanAt,
  });
}
