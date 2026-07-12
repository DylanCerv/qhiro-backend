import { randomUUID } from 'node:crypto';
import type {
  AiAnalysisRequest,
  AiAnalysisResponse,
  Device,
  TelemetryProcessingLog,
  TelemetryProcessingStatus,
} from '../types/index.js';
import { requestAiAnalysis } from './ai-client.js';
import { applyDecisionEngine } from './decision-engine.js';
import {
  getDevice,
  getFlight,
  getParcel,
  saveTelemetryProcessingLog,
  updateFlight,
  upsertDevice,
  upsertParcel,
} from './firebase.js';
import { sendNotification } from './notifications.js';

interface TelemetryContext {
  userId: string;
  deviceId: string;
  deviceType: Device['type'];
}

interface TelemetryLogInput {
  ctx: TelemetryContext;
  payload: Record<string, unknown>;
  startedAt: number;
  status: TelemetryProcessingStatus;
  actions?: string[];
  validationMessage?: string;
  aiRequest?: AiAnalysisRequest;
  aiResponse?: AiAnalysisResponse;
}

async function saveProcessingLog(input: TelemetryLogInput): Promise<void> {
  const log: TelemetryProcessingLog = {
    logId: randomUUID(),
    userId: input.ctx.userId,
    deviceId: input.ctx.deviceId,
    deviceType: input.ctx.deviceType,
    parcelId: typeof input.payload.parcelId === 'string' ? input.payload.parcelId : undefined,
    flightId: typeof input.payload.flightId === 'string' ? input.payload.flightId : undefined,
    status: input.status,
    validationMessage: input.validationMessage,
    payload: input.payload,
    aiRequest: input.aiRequest,
    aiResponse: input.aiResponse,
    actions: input.actions ?? [],
    durationMs: Date.now() - input.startedAt,
    createdAt: new Date().toISOString(),
  };
  await saveTelemetryProcessingLog(log);
}

async function validateRegisteredDevice(ctx: TelemetryContext): Promise<Device | null> {
  const device = await getDevice(ctx.userId, ctx.deviceId);
  if (!device) {
    console.warn(`[Telemetry] Unknown device "${ctx.deviceId}" for user "${ctx.userId}". Ignoring payload.`);
    return null;
  }
  if (device.type !== ctx.deviceType) {
    console.warn(
      `[Telemetry] Device "${ctx.deviceId}" type mismatch. Expected ${device.type}, got ${ctx.deviceType}.`,
    );
    return null;
  }
  return device;
}

export async function handleDroneTelemetry(
  ctx: TelemetryContext,
  data: Record<string, unknown>,
): Promise<void> {
  const startedAt = Date.now();
  const device = await validateRegisteredDevice(ctx);
  if (!device) {
    await saveProcessingLog({
      ctx,
      payload: data,
      startedAt,
      status: 'rejected',
      validationMessage: 'Device not found or type mismatch.',
    });
    return;
  }

  const { userId, deviceId } = ctx;
  const parcelId = String(data.parcelId ?? '');
  const flightId = String(data.flightId ?? '');
  const status = String(data.status ?? '');
  const ndvi = Number(data.ndvi ?? 0);

  if (userId && parcelId) {
    const parcel = await getParcel(userId, parcelId);
    if (parcel) {
      const healthStatus = ndvi >= 0.6 ? 'green' : ndvi >= 0.4 ? 'yellow' : 'red';
      await upsertParcel(userId, { ...parcel, ndvi, healthStatus });
    }
  }

  if (flightId && userId && status === 'completed') {
    const flight = await getFlight(userId, flightId);
    if (!flight || flight.parcelId !== parcelId) {
      const validationMessage = `Flight "${flightId}" is not valid for user "${userId}" and parcel "${parcelId}".`;
      console.warn(`[Telemetry] ${validationMessage}`);
      await saveProcessingLog({
        ctx,
        payload: data,
        startedAt,
        status: 'rejected',
        validationMessage,
      });
      return;
    }

    await updateFlight(userId, flightId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    await sendNotification(userId, 'flightCompleted', { parcelId });

    const parcel = await getParcel(userId, parcelId);
    if (parcel && ndvi > 0) {
      await runAnalysisPipeline(ctx, parcel, ndvi, data, startedAt);
      return;
    }
  }

  if (userId) {
    await upsertDevice(userId, {
      ...device,
      deviceId,
      userId,
      type: 'drone',
      status: status === 'idle' ? 'online' : 'online',
      batteryLevel: Number(data.batteryLevel ?? 100),
      lastSeenAt: new Date().toISOString(),
    });
  }

  await saveProcessingLog({
    ctx,
    payload: data,
    startedAt,
    status: 'processed',
    actions: ['device:updateStatus'],
  });
}

export async function handleSensorTelemetry(
  ctx: TelemetryContext,
  data: Record<string, unknown>,
): Promise<void> {
  const startedAt = Date.now();
  const device = await validateRegisteredDevice(ctx);
  if (!device) {
    await saveProcessingLog({
      ctx,
      payload: data,
      startedAt,
      status: 'rejected',
      validationMessage: 'Device not found or type mismatch.',
    });
    return;
  }

  const { userId, deviceId } = ctx;
  const batteryLevel = Number(data.batteryLevel ?? 100);

  if (!userId) return;

  const status = batteryLevel < 20 ? 'lowBattery' : 'online';
  await upsertDevice(userId, {
    ...device,
    deviceId,
    userId,
    type: 'sensor',
    status,
    batteryLevel,
    lastSeenAt: new Date().toISOString(),
  });

  if (batteryLevel < 20) {
    await sendNotification(userId, 'deviceLowBattery', { deviceId, batteryLevel });
  }

  await saveProcessingLog({
    ctx,
    payload: data,
    startedAt,
    status: 'processed',
    actions: batteryLevel < 20 ? ['device:updateStatus', 'notify:deviceLowBattery'] : ['device:updateStatus'],
  });
}

export async function handleNestTelemetry(
  ctx: TelemetryContext,
  data: Record<string, unknown>,
): Promise<void> {
  const startedAt = Date.now();
  const device = await validateRegisteredDevice(ctx);
  if (!device) {
    await saveProcessingLog({
      ctx,
      payload: data,
      startedAt,
      status: 'rejected',
      validationMessage: 'Device not found or type mismatch.',
    });
    return;
  }

  const { userId, deviceId } = ctx;
  const supplyLevel = Number(data.supplyLevel ?? 100);

  if (!userId) return;

  await upsertDevice(userId, {
    ...device,
    deviceId,
    userId,
    type: 'nest',
    status: 'online',
    batteryLevel: Number(data.batteryLevel ?? 100),
    lastSeenAt: new Date().toISOString(),
  });

  if (supplyLevel < 15) {
    await sendNotification(userId, 'supplyLow', { parcelId: String(data.parcelId ?? '') });
  }

  await saveProcessingLog({
    ctx,
    payload: data,
    startedAt,
    status: 'processed',
    actions: supplyLevel < 15 ? ['device:updateStatus', 'notify:supplyLow'] : ['device:updateStatus'],
  });
}

async function runAnalysisPipeline(
  ctx: TelemetryContext,
  parcel: Awaited<ReturnType<typeof getParcel>> & object,
  ndvi: number,
  telemetry: Record<string, unknown>,
  startedAt: number,
): Promise<void> {
  const request: AiAnalysisRequest = {
    parcelId: parcel.parcelId,
    zoneId: parcel.zoneId,
    ndvi,
    soilNutrients: parcel.soilNutrients ?? {
      nitrogen: Number(telemetry.nitrogen ?? 0),
      phosphorus: Number(telemetry.phosphorus ?? 0),
      potassium: Number(telemetry.potassium ?? 0),
    },
    soilMoisture: parcel.soilMoisture ?? Number(telemetry.soilMoisture ?? 0),
    cropType: parcel.cropType,
    timestamp: new Date().toISOString(),
    imageUrl: typeof telemetry.imageUrl === 'string' ? telemetry.imageUrl : undefined,
    imageBase64: typeof telemetry.imageBase64 === 'string' ? telemetry.imageBase64 : undefined,
    coordinates: Array.isArray(telemetry.coordinates) ? telemetry.coordinates as AiAnalysisRequest['coordinates'] : parcel.coordinates,
  };

  let analysis: AiAnalysisResponse;
  try {
    analysis = await requestAiAnalysis(request);
  } catch (error) {
    console.error('[Telemetry] AI analysis failed:', error);
    await saveProcessingLog({
      ctx,
      payload: telemetry,
      startedAt,
      status: 'failed',
      aiRequest: request,
      validationMessage: error instanceof Error ? error.message : 'AI analysis failed',
      actions: ['flight:completed', 'notify:flightCompleted', 'ai:failed'],
    });
    return;
  }

  try {
    const actions = await applyDecisionEngine({
      userId: ctx.userId,
      parcelId: parcel.parcelId,
      zoneId: parcel.zoneId,
      analysis,
    });
    await saveProcessingLog({
      ctx,
      payload: telemetry,
      startedAt,
      status: 'processed',
      aiRequest: request,
      aiResponse: analysis,
      actions: ['flight:completed', 'notify:flightCompleted', 'ai:analyze', ...actions],
    });
  } catch (error) {
    console.error('[Telemetry] Decision pipeline failed:', error);
    await saveProcessingLog({
      ctx,
      payload: telemetry,
      startedAt,
      status: 'failed',
      aiRequest: request,
      aiResponse: analysis,
      validationMessage: error instanceof Error ? error.message : 'Decision pipeline failed',
      actions: ['flight:completed', 'notify:flightCompleted', 'ai:analyze', 'decision:failed'],
    });
  }
}
