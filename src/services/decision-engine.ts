import { randomUUID } from 'node:crypto';
import type { AiAnalysisResponse, NotificationEvent } from '../types/index.js';
import { createAlert, saveActionExecutionLog } from './firebase.js';
import { sendSensorCommand } from './mqtt.js';
import { sendNotification } from './notifications.js';
import { generateAndStoreReport } from './reports.js';

interface DecisionContext {
  userId: string;
  parcelId: string;
  zoneId: string;
  analysis: AiAnalysisResponse;
}

export async function applyDecisionEngine(ctx: DecisionContext): Promise<string[]> {
  const { userId, parcelId, zoneId, analysis } = ctx;
  const { severity, diagnosis, recommendedAction } = analysis;
  const actions: string[] = [];

  if (severity < 0.3) {
    console.log(`[DecisionEngine] Severity ${severity} — log only for parcel ${parcelId}`);
    actions.push('logOnly');
    return actions;
  }

  if (severity >= 0.3 && severity < 0.6) {
    await notify(userId, parcelId, severity, diagnosis, 'anomalyDetected');
    actions.push('notify:anomalyDetected');
    return actions;
  }

  if (severity >= 0.6 && severity < 0.8) {
    await notify(userId, parcelId, severity, diagnosis, 'anomalyDetected');
    actions.push('notify:anomalyDetected');
    const actionId = await triggerInjection(userId, parcelId, zoneId, analysis);
    actions.push(`mqtt:inject:${actionId}:pending`);
    const report = await generateAndStoreReport(userId, parcelId, analysis);
    actions.push(`report:${report.reportId}`);
    return actions;
  }

  if (severity >= 0.8) {
    await notify(userId, parcelId, severity, diagnosis, 'emergencyAlert');
    actions.push('notify:emergencyAlert');
    const actionId = await triggerInjection(userId, parcelId, zoneId, analysis);
    actions.push(`mqtt:inject:${actionId}:pending`);
    const report = await generateAndStoreReport(userId, parcelId, analysis);
    actions.push(`report:${report.reportId}`);
    await scheduleEmergencyRescan(userId, parcelId);
    actions.push('schedule:emergencyRescan');
    console.log(`[DecisionEngine] Emergency mode activated for parcel ${parcelId}`);
  }

  if (recommendedAction === 'monitor' && severity < 0.6) {
    await notify(userId, parcelId, severity, diagnosis, 'anomalyDetected');
    actions.push('notify:anomalyDetected');
  }

  return actions;
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
): Promise<string> {
  const sensorId = `sensor_${zoneId}`;
  const actionId = randomUUID();
  const commandPayload = {
    actionId,
    action: 'inject',
    parcelId,
    zoneId,
    npkFormula: analysis.recommendedNpkFormula,
    timestamp: new Date().toISOString(),
  };

  await saveActionExecutionLog({
    actionId,
    userId,
    deviceId: sensorId,
    parcelId,
    zoneId,
    action: 'inject',
    status: 'pending',
    commandPayload,
    startedAt: commandPayload.timestamp,
  });
  sendSensorCommand(userId, sensorId, commandPayload);
  await sendNotification(userId, 'injectionExecuted', {
    parcelId,
    zoneId,
    npkFormula: analysis.recommendedNpkFormula,
    actionId,
    status: 'pending',
  });
  return actionId;
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
