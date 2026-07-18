import { randomUUID } from 'node:crypto';
import type { AiAnalysisResponse, Device, NotificationEvent } from '../types/index.js';
import { createAlert, getDevices, saveActionExecutionLog } from './firebase.js';
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
    const injectionActions = await triggerInjection(userId, parcelId, zoneId, analysis);
    actions.push(...injectionActions);
    const report = await generateAndStoreReport(userId, parcelId, analysis);
    actions.push(`report:${report.reportId}`);
    return actions;
  }

  if (severity >= 0.8) {
    await notify(userId, parcelId, severity, diagnosis, 'emergencyAlert');
    actions.push('notify:emergencyAlert');
    const injectionActions = await triggerInjection(userId, parcelId, zoneId, analysis);
    actions.push(...injectionActions);
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
): Promise<string[]> {
  const targetSentinels = await selectTargetSentinels(userId, parcelId);
  if (targetSentinels.length === 0) {
    console.warn(`[DecisionEngine] No sentinel found for parcel ${parcelId}, zone ${zoneId}`);
    const actionId = randomUUID();
    const queuedPayload = {
      actionId,
      action: 'inject',
      parcelId,
      zoneId,
      affectedCoordinates: analysis.affectedCoordinates ?? [],
      npkFormula: analysis.recommendedNpkFormula,
      timestamp: new Date().toISOString(),
      queuedReason: 'No online sentinel registered for this parcel yet.',
    };

    await saveActionExecutionLog({
      actionId,
      userId,
      deviceId: `parcel:${parcelId}`,
      parcelId,
      zoneId,
      action: 'inject',
      status: 'pending',
      commandPayload: queuedPayload,
      startedAt: queuedPayload.timestamp,
      queueReason: 'No online sentinel registered for this parcel yet.',
    });

    await sendNotification(userId, 'injectionExecuted', {
      parcelId,
      zoneId,
      npkFormula: analysis.recommendedNpkFormula,
      actionId,
      status: 'pending',
      message: 'Acción pendiente de centinela online',
    });

    return [`mqtt:inject:queued:${actionId}:pending`];
  }

  const actions: string[] = [];
  const actionId = randomUUID();
  for (const sentinel of targetSentinels) {
    const commandPayload = {
      actionId: targetSentinels.length === 1 ? actionId : randomUUID(),
      action: 'inject',
      parcelId,
      zoneId: sentinel.zoneId ?? zoneId,
      affectedCoordinates: analysis.affectedCoordinates ?? [],
      npkFormula: analysis.recommendedNpkFormula,
      timestamp: new Date().toISOString(),
    };

    await saveActionExecutionLog({
      actionId: commandPayload.actionId,
      userId,
      deviceId: sentinel.deviceId,
      parcelId,
      zoneId: commandPayload.zoneId,
      action: 'inject',
      status: 'pending',
      commandPayload,
      startedAt: commandPayload.timestamp,
    });
    sendSensorCommand(userId, sentinel.deviceId, commandPayload);
    actions.push(`mqtt:inject:${sentinel.deviceId}:${commandPayload.actionId}:pending`);
  }

  await sendNotification(userId, 'injectionExecuted', {
    parcelId,
    zoneId,
    npkFormula: analysis.recommendedNpkFormula,
    actionId,
    status: 'pending',
  });
  return actions;
}

async function selectTargetSentinels(
  userId: string,
  parcelId: string,
): Promise<Device[]> {
  const devices = await getDevices(userId);
  const sentinel = devices.find((device) =>
    device.type === 'sentinel' &&
    device.status !== 'offline' &&
    device.parcelId === parcelId,
  );
  return sentinel ? [sentinel] : [];
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
