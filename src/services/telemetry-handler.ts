import { randomUUID } from 'node:crypto';
import type { AiAnalysisRequest } from '../types/index.js';
import { requestAiAnalysis } from './ai-client.js';
import { applyDecisionEngine } from './decision-engine.js';
import {
  getParcel,
  updateFlight,
  upsertDevice,
  upsertParcel,
} from './firebase.js';
import { sendNotification } from './notifications.js';

export async function handleDroneTelemetry(data: Record<string, unknown>): Promise<void> {
  const userId = String(data.userId ?? '');
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
    await updateFlight(userId, flightId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    await sendNotification(userId, 'flightCompleted', { parcelId });

    const parcel = await getParcel(userId, parcelId);
    if (parcel && ndvi > 0) {
      await runAnalysisPipeline(userId, parcel, ndvi, data);
    }
  }

  if (userId) {
    await upsertDevice(userId, {
      deviceId: String(data.droneId ?? 'drone_001'),
      userId,
      type: 'drone',
      name: 'Field Drone',
      status: status === 'idle' ? 'online' : 'online',
      batteryLevel: Number(data.batteryLevel ?? 100),
      lastSeenAt: new Date().toISOString(),
    });
  }
}

export async function handleSensorTelemetry(data: Record<string, unknown>): Promise<void> {
  const userId = String(data.userId ?? '');
  const sensorId = String(data.sensorId ?? 'sensor_001');
  const batteryLevel = Number(data.batteryLevel ?? 100);

  if (!userId) return;

  const status = batteryLevel < 20 ? 'lowBattery' : 'online';
  await upsertDevice(userId, {
    deviceId: sensorId,
    userId,
    type: 'sensor',
    name: `Sensor ${sensorId}`,
    status,
    batteryLevel,
    lastSeenAt: new Date().toISOString(),
  });

  if (batteryLevel < 20) {
    await sendNotification(userId, 'deviceLowBattery', { deviceId: sensorId, batteryLevel });
  }
}

export async function handleNestTelemetry(data: Record<string, unknown>): Promise<void> {
  const userId = String(data.userId ?? '');
  const nestId = String(data.nestId ?? 'nest_001');
  const supplyLevel = Number(data.supplyLevel ?? 100);

  if (!userId) return;

  await upsertDevice(userId, {
    deviceId: nestId,
    userId,
    type: 'nest',
    name: 'Drone Nest',
    status: 'online',
    batteryLevel: Number(data.batteryLevel ?? 100),
    lastSeenAt: new Date().toISOString(),
  });

  if (supplyLevel < 15) {
    await sendNotification(userId, 'supplyLow', { parcelId: String(data.parcelId ?? '') });
  }
}

async function runAnalysisPipeline(
  userId: string,
  parcel: Awaited<ReturnType<typeof getParcel>> & object,
  ndvi: number,
  telemetry: Record<string, unknown>,
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
  };

  try {
    const analysis = await requestAiAnalysis(request);
    await applyDecisionEngine({
      userId,
      parcelId: parcel.parcelId,
      zoneId: parcel.zoneId,
      analysis,
    });
  } catch (error) {
    console.error('[Telemetry] AI analysis failed:', error);
  }
}

export async function seedDemoData(userId: string): Promise<void> {
  const now = new Date().toISOString();
  await upsertParcel(userId, {
    parcelId: 'parcel_001',
    userId,
    cropType: '',
    name: 'North Field',
    ndvi: 0.72,
    healthStatus: 'green',
    zoneId: 'zone_a',
    soilNutrients: { nitrogen: 45, phosphorus: 30, potassium: 55 },
    soilMoisture: 42,
    coordinates: [
      { lat: 19.4326, lng: -99.1332 },
      { lat: 19.4336, lng: -99.1322 },
      { lat: 19.4316, lng: -99.1312 },
    ],
    createdAt: now,
  });

  await upsertDevice(userId, {
    deviceId: 'drone_001',
    userId,
    type: 'drone',
    name: 'Field Drone',
    status: 'online',
    batteryLevel: 87,
    lastSeenAt: now,
  });

  await upsertDevice(userId, {
    deviceId: 'sensor_zone_a',
    userId,
    type: 'sensor',
    name: 'Sensor Zone A',
    status: 'online',
    batteryLevel: 65,
    lastSeenAt: now,
  });

  await upsertDevice(userId, {
    deviceId: 'nest_001',
    userId,
    type: 'nest',
    name: 'Drone Nest',
    status: 'online',
    batteryLevel: 100,
    lastSeenAt: now,
  });
}
