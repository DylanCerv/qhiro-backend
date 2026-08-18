import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { CROP_TYPES } from '../services/crops.js';
import { isFirebaseAuthConfigured } from '../services/firebase-auth.js';
import { ERROR_LOG_FILE } from '../services/error-logger.js';
import {
  admin,
  deleteSchedule,
  getActionExecutionLogs,
  getAlerts,
  getDevice,
  getDevices,
  deleteDevice,
  getFlights,
  getParcels,
  getReportPdfBuffer,
  getReports,
  getSchedules,
  getTelemetryProcessingLogs,
  saveActionExecutionLog,
  upsertDevice,
  upsertSchedule,
} from '../services/firebase.js';
import { publishTelemetry, sendSensorCommand } from '../services/mqtt.js';
import type { Device, GeoPoint, Parcel, RepeatUnit } from '../types/index.js';
import { findParcelAtPoint } from '../utils/geo.js';
import { findOverlappingSchedule, getNextOccurrence, resolveRepeat, withComputedNextRun } from '../utils/schedule.js';

const scheduleSchema = z.object({
  scheduleId: z.string().optional(),
  parcelId: z.string().optional(),
  parcelIds: z.array(z.string().min(1)).optional(),
  scheduleType: z.string().trim().max(48).optional(),
  startTime: z.string().min(1),
  frequencyDays: z.number().min(1).max(365).optional(),
  repeatEvery: z.number().min(1).max(365).optional(),
  repeatUnit: z.enum(['day', 'week', 'month']).optional(),
  enabled: z.boolean(),
}).superRefine((value, ctx) => {
  const parcelIds = value.parcelIds?.filter(Boolean) ?? [];
  if (!parcelIds.length && !value.parcelId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['parcelIds'],
      message: 'At least one parcel is required',
    });
  }
  if (!value.repeatUnit && !value.frequencyDays && !value.repeatEvery) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repeatUnit'],
      message: 'Repeat interval is required',
    });
  }
});

function resolveScheduleParcelIds(parcelIds?: string[], parcelId?: string): string[] {
  const unique = [...new Set((parcelIds ?? []).filter(Boolean))];
  if (unique.length) return unique;
  return parcelId ? [parcelId] : [];
}

const geoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const deviceSchema = z.object({
  name: z.string().trim().optional(),
  type: z.enum(['drone', 'nest', 'sentinel']),
  status: z.enum(['online', 'offline', 'lowBattery']).optional(),
  parcelId: z.string().optional(),
  zoneId: z.string().optional(),
  coordinates: geoPointSchema.optional(),
  sentinelLabel: z.string().regex(/^c\d+$/i).optional(),
}).superRefine((value, ctx) => {
  if (value.type !== 'sentinel') return;
  if (!value.coordinates) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coordinates'], message: 'Sentinel coordinates are required' });
  }
});

function getNextSentinelLabel(sentinels: Device[]): string {
  const used = new Set(
    sentinels
      .map((sentinel) => sentinel.sentinelLabel?.toLowerCase())
      .filter(Boolean),
  );

  for (let index = 1; index <= 99; index += 1) {
    const label = `c${index}`;
    if (!used.has(label)) return label;
  }

  return `c${sentinels.length + 1}`;
}

function resolveDeviceName(
  type: Device['type'],
  name: string | undefined,
  sentinelLabel?: string,
): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;

  if (type === 'sentinel' && sentinelLabel) {
    return `Centinela ${sentinelLabel.toLowerCase()}`;
  }
  if (type === 'drone') return 'Dron';
  if (type === 'nest') return 'Nido';
  return 'Dispositivo';
}

function findSentinelLabelConflict(
  devices: Device[],
  sentinelLabel: string | undefined,
  excludeDeviceId?: string,
): Device | undefined {
  if (!sentinelLabel) return undefined;
  const normalized = sentinelLabel.toLowerCase();
  return devices.find(
    (device) =>
      device.type === 'sentinel' &&
      device.deviceId !== excludeDeviceId &&
      device.sentinelLabel?.toLowerCase() === normalized,
  );
}

async function resolveSentinelPlacement(
  userId: string,
  coordinates: GeoPoint,
  parcelId?: string,
): Promise<{ parcel: Parcel; zoneId?: string } | null> {
  const parcels = await getParcels(userId);
  const parcel = parcelId
    ? parcels.find((item) => item.parcelId === parcelId)
    : findParcelAtPoint(coordinates, parcels);

  if (!parcel || !isPointInsideParcel(coordinates, parcel)) {
    return null;
  }

  return { parcel, zoneId: parcel.zoneId };
}

function isPointInsideParcel(point: GeoPoint, parcel: Parcel): boolean {
  return findParcelAtPoint(point, [parcel]) !== undefined;
}

const telemetryPayloadSchema = z.object({
  deviceId: z.string().min(1),
  deviceType: z.enum(['drone', 'sensor', 'nest', 'sentinel']),
  payload: z.record(z.unknown()),
});

export const apiRoutes = new Hono();

apiRoutes.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'qhiro-backend',
    serverTime: new Date().toISOString(),
    errorLogFile: ERROR_LOG_FILE,
    authMode:
      admin.apps.length && isFirebaseAuthConfigured()
        ? 'firebase'
        : admin.apps.length
          ? 'firebase-missing-api-key'
          : 'demo',
  }),
);

apiRoutes.get('/crops', (c) => c.json({ crops: CROP_TYPES }));

apiRoutes.use('/*', authMiddleware);

apiRoutes.get('/alerts', async (c) => {
  const user = c.get('user');
  const alerts = await getAlerts(user.uid);
  return c.json({ alerts });
});

apiRoutes.get('/telemetry-logs', async (c) => {
  const user = c.get('user');
  const logs = await getTelemetryProcessingLogs(user.uid);
  return c.json({ logs });
});

apiRoutes.get('/action-logs', async (c) => {
  const user = c.get('user');
  const logs = await getActionExecutionLogs(user.uid);
  return c.json({ logs });
});

apiRoutes.get('/activity', async (c) => {
  const user = c.get('user');
  const [flights, reports, alerts, actionLogs, devices, parcels] = await Promise.all([
    getFlights(user.uid),
    getReports(user.uid),
    getAlerts(user.uid),
    getActionExecutionLogs(user.uid, 100),
    getDevices(user.uid),
    getParcels(user.uid),
  ]);

  const activity = [
    ...flights.map((flight) => ({
      kind: 'flight' as const,
      id: flight.flightId,
      date: flight.completedAt ?? flight.startedAt ?? flight.scheduledAt,
      status: flight.status,
      parcelId: flight.parcelId,
      flightId: flight.flightId,
      title: 'Vuelo de dron',
    })),
    ...reports.map((report) => ({
      kind: 'report' as const,
      id: report.reportId,
      date: report.createdAt,
      status: report.severity >= 0.8 ? 'critical' : report.severity >= 0.6 ? 'warning' : 'info',
      parcelId: report.parcelId,
      reportId: report.reportId,
      severity: report.severity,
      title: 'Informe generado',
      diagnosis: report.diagnosis,
    })),
    ...alerts.map((alert) => ({
      kind: 'alert' as const,
      id: alert.alertId,
      date: alert.createdAt,
      status: alert.read ? 'read' : 'unread',
      parcelId: alert.parcelId,
      alertId: alert.alertId,
      title: 'Alerta',
      message: alert.message,
      severity: alert.severity,
    })),
    ...actionLogs.map((action) => ({
      kind: 'action' as const,
      id: action.actionId,
      date: action.completedAt ?? action.startedAt,
      status: action.status,
      parcelId: action.parcelId,
      actionId: action.actionId,
      deviceId: action.deviceId,
      title: 'Intervención del centinela',
      error: action.error,
      queueReason: action.queueReason,
      durationMs: action.durationMs,
    })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return c.json({ activity, flights, reports, alerts, actionLogs, devices, parcels });
});

apiRoutes.post('/action-logs/:actionId/retry', async (c) => {
  const user = c.get('user');
  const actionId = c.req.param('actionId');
  const logs = await getActionExecutionLogs(user.uid, 1000);
  const action = logs.find((item) => item.actionId === actionId);

  if (!action) {
    return c.json({ error: 'Action not found' }, 404);
  }
  if (action.status === 'completed') {
    return c.json({ error: 'Action already completed' }, 409);
  }

  const sentinel = (await getDevices(user.uid)).find(
    (device) =>
      device.type === 'sentinel' &&
      device.status !== 'offline' &&
      device.parcelId === action.parcelId,
  );

  if (!sentinel) {
    return c.json({ error: 'No online sentinel available for this parcel' }, 409);
  }

  const commandPayload = {
    ...action.commandPayload,
    actionId: action.actionId,
    retriedAt: new Date().toISOString(),
    retryCount: Number(action.commandPayload.retryCount ?? 0) + 1,
  };

  const updated = {
    ...action,
    deviceId: sentinel.deviceId,
    commandPayload,
    status: 'pending' as const,
    queueReason: undefined,
    error: undefined,
    startedAt: action.startedAt,
  };

  await saveActionExecutionLog(updated);
  sendSensorCommand(user.uid, sentinel.deviceId, commandPayload);

  return c.json({
    published: true,
    action: updated,
    topic: `qhiro/users/${user.uid}/devices/${sentinel.deviceId}/command`,
  });
});

apiRoutes.get('/schedules', async (c) => {
  const user = c.get('user');
  const schedules = (await getSchedules(user.uid)).map((schedule) => withComputedNextRun(schedule));
  return c.json({ schedules });
});

apiRoutes.put('/schedules', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = scheduleSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid schedule payload', details: parsed.error.flatten() }, 400);
  }

  const scheduleId = parsed.data.scheduleId ?? randomUUID();
  const existingSchedules = await getSchedules(user.uid);
  const existing = existingSchedules.find((s) => s.scheduleId === scheduleId);

  const parcelIds = resolveScheduleParcelIds(parsed.data.parcelIds, parsed.data.parcelId);
  if (!parcelIds.length) {
    return c.json({ error: 'Select at least one parcel for the drone route.' }, 400);
  }

  const startTime = parsed.data.startTime || new Date().toISOString();
  const repeat = resolveRepeat(
    parsed.data.repeatEvery,
    parsed.data.repeatUnit as RepeatUnit | undefined,
    parsed.data.frequencyDays,
  );

  const overlap = findOverlappingSchedule(
    {
      scheduleId,
      startTime,
      repeatEvery: repeat.repeatEvery,
      repeatUnit: repeat.repeatUnit,
      frequencyDays: repeat.frequencyDays,
    },
    existingSchedules,
  );
  if (overlap) {
    return c.json({
      error: 'El dron ya tiene una misión ese día a esa hora. Elige otra fecha u otra hora.',
    }, 409);
  }

  const schedule = {
    scheduleId,
    userId: user.uid,
    parcelId: parcelIds[0],
    parcelIds,
    scheduleType: parsed.data.scheduleType || undefined,
    startTime,
    frequencyDays: repeat.frequencyDays,
    repeatEvery: repeat.repeatEvery,
    repeatUnit: repeat.repeatUnit,
    enabled: parsed.data.enabled,
    lastRunAt: existing?.lastRunAt ?? null,
    nextRunAt: getNextOccurrence(
      startTime,
      repeat.repeatEvery,
      repeat.repeatUnit,
      repeat.frequencyDays,
    ).toISOString(),
  };

  await upsertSchedule(user.uid, schedule);
  return c.json({ schedule });
});

apiRoutes.delete('/schedules/:scheduleId', async (c) => {
  const user = c.get('user');
  const scheduleId = c.req.param('scheduleId');
  const deleted = await deleteSchedule(user.uid, scheduleId);
  if (!deleted) {
    return c.json({ error: 'Schedule not found' }, 404);
  }
  return c.json({ success: true });
});

apiRoutes.get('/flights', async (c) => {
  const user = c.get('user');
  const flights = await getFlights(user.uid);
  return c.json({ flights });
});

apiRoutes.get('/devices', async (c) => {
  const user = c.get('user');
  const devices = await getDevices(user.uid);
  return c.json({ devices });
});

apiRoutes.post('/devices', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = deviceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid device payload', details: parsed.error.flatten() }, 400);
  }

  if (parsed.data.type === 'sentinel') {
    const placement = await resolveSentinelPlacement(
      user.uid,
      parsed.data.coordinates!,
      parsed.data.parcelId,
    );
    if (!placement) {
      return c.json({ error: 'Coordinates must be inside one of your parcels.' }, 400);
    }

    const { parcel } = placement;
    const allDevices = await getDevices(user.uid);
    const accountSentinels = allDevices.filter((device) => device.type === 'sentinel');
    const sentinelLabel = parsed.data.sentinelLabel?.toLowerCase() ?? getNextSentinelLabel(accountSentinels);
    const conflict = findSentinelLabelConflict(allDevices, sentinelLabel);
    if (conflict) {
      return c.json({ error: `Sentinel label "${sentinelLabel}" is already used on this account.` }, 409);
    }

    const device: Device = {
      deviceId: randomUUID(),
      userId: user.uid,
      name: resolveDeviceName(parsed.data.type, parsed.data.name, sentinelLabel),
      type: parsed.data.type,
      status: parsed.data.status ?? 'online',
      batteryLevel: 100,
      lastSeenAt: new Date().toISOString(),
      parcelId: parcel.parcelId,
      zoneId: parsed.data.zoneId ?? parcel.zoneId,
      coordinates: parsed.data.coordinates,
      sentinelLabel,
    };

    await upsertDevice(user.uid, device);
    return c.json({ device }, 201);
  }

  if (parsed.data.type === 'drone') {
    const existingDrone = (await getDevices(user.uid)).find((device) => device.type === 'drone');
    if (existingDrone) {
      return c.json({ error: 'This account already has a registered drone.' }, 409);
    }
  }

  if (parsed.data.type === 'nest') {
    const existingNest = (await getDevices(user.uid)).find((device) => device.type === 'nest');
    if (existingNest) {
      return c.json({ error: 'This account already has a registered nest.' }, 409);
    }
  }

  const device: Device = {
    deviceId: randomUUID(),
    userId: user.uid,
    name: resolveDeviceName(parsed.data.type, parsed.data.name),
    type: parsed.data.type,
    status: parsed.data.status ?? 'online',
    batteryLevel: 100,
    lastSeenAt: new Date().toISOString(),
    parcelId: parsed.data.type === 'sentinel' ? parsed.data.parcelId : undefined,
    zoneId: parsed.data.type === 'sentinel' ? parsed.data.zoneId : undefined,
  };

  await upsertDevice(user.uid, device);
  return c.json({ device }, 201);
});

apiRoutes.put('/devices/:deviceId', async (c) => {
  const user = c.get('user');
  const deviceId = c.req.param('deviceId');
  const body = await c.req.json();
  const parsed = deviceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid device payload', details: parsed.error.flatten() }, 400);
  }

  const existing = await getDevice(user.uid, deviceId);
  if (!existing) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (parsed.data.type === 'sentinel') {
    const placement = await resolveSentinelPlacement(
      user.uid,
      parsed.data.coordinates!,
      parsed.data.parcelId,
    );
    if (!placement) {
      return c.json({ error: 'Coordinates must be inside one of your parcels.' }, 400);
    }

    const { parcel } = placement;
    const allDevices = await getDevices(user.uid);
    const accountSentinels = allDevices.filter(
      (device) => device.type === 'sentinel' && device.deviceId !== deviceId,
    );
    const sentinelLabel = parsed.data.sentinelLabel?.toLowerCase()
      ?? existing.sentinelLabel
      ?? getNextSentinelLabel(accountSentinels);
    const conflict = findSentinelLabelConflict(allDevices, sentinelLabel, deviceId);
    if (conflict) {
      return c.json({ error: `Sentinel label "${sentinelLabel}" is already used on this account.` }, 409);
    }

    const device: Device = {
      ...existing,
      name: resolveDeviceName(parsed.data.type, parsed.data.name, sentinelLabel),
      type: parsed.data.type,
      status: parsed.data.status ?? existing.status,
      parcelId: parcel.parcelId,
      zoneId: parsed.data.zoneId ?? parcel.zoneId,
      coordinates: parsed.data.coordinates,
      sentinelLabel,
      lastSeenAt: new Date().toISOString(),
    };

    await upsertDevice(user.uid, device);
    return c.json({ device });
  }

  if (parsed.data.type === 'drone' && existing.type !== 'drone') {
    const existingDrone = (await getDevices(user.uid)).find(
      (device) => device.type === 'drone' && device.deviceId !== deviceId,
    );
    if (existingDrone) {
      return c.json({ error: 'This account already has a registered drone.' }, 409);
    }
  }

  if (parsed.data.type === 'nest' && existing.type !== 'nest') {
    const existingNest = (await getDevices(user.uid)).find(
      (device) => device.type === 'nest' && device.deviceId !== deviceId,
    );
    if (existingNest) {
      return c.json({ error: 'This account already has a registered nest.' }, 409);
    }
  }

  const device: Device = {
    ...existing,
    name: resolveDeviceName(parsed.data.type, parsed.data.name),
    type: parsed.data.type,
    status: parsed.data.status ?? existing.status,
    parcelId: undefined,
    zoneId: undefined,
    coordinates: undefined,
    sentinelLabel: undefined,
    lastSeenAt: new Date().toISOString(),
  };

  await upsertDevice(user.uid, device);
  return c.json({ device });
});

apiRoutes.post('/devices/:deviceId/toggle-status', async (c) => {
  const user = c.get('user');
  const deviceId = c.req.param('deviceId');
  const body = await c.req.json().catch(() => ({}));
  const status = body.status;
  if (!['online', 'offline', 'lowBattery'].includes(status)) {
    return c.json({ error: 'Invalid status payload' }, 400);
  }

  const existing = await getDevice(user.uid, deviceId);
  if (!existing) {
    return c.json({ error: 'Device not found' }, 404);
  }

  const device: Device = {
    ...existing,
    status,
    lastSeenAt: new Date().toISOString(),
  };

  await upsertDevice(user.uid, device);
  return c.json({ device });
});

apiRoutes.delete('/devices/:deviceId', async (c) => {
  const user = c.get('user');
  const deviceId = c.req.param('deviceId');
  const existing = await getDevice(user.uid, deviceId);
  if (!existing) {
    return c.json({ error: 'Device not found' }, 404);
  }

  const deleted = await deleteDevice(user.uid, deviceId);
  if (!deleted) {
    return c.json({ error: 'Device not found' }, 404);
  }

  return c.json({ success: true });
});

apiRoutes.post('/simulator/telemetry', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = telemetryPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid telemetry payload', details: parsed.error.flatten() }, 400);
  }

  const { deviceId, deviceType, payload } = parsed.data;
  const device = await getDevice(user.uid, deviceId);
  if (!device) {
    return c.json({ error: 'Device not found for current user' }, 404);
  }
  if (device.type !== deviceType) {
    return c.json({ error: `Device type mismatch. Registered as ${device.type}.` }, 400);
  }

  publishTelemetry(user.uid, deviceId, deviceType, payload);
  return c.json({
    published: true,
    topic: `qhiro/users/${user.uid}/devices/${deviceId}/${deviceType}/telemetry`,
  });
});

apiRoutes.get('/reports', async (c) => {
  const user = c.get('user');
  const reports = await getReports(user.uid);
  return c.json({ reports });
});

apiRoutes.get('/reports/:reportId/download', async (c) => {
  const user = c.get('user');
  const reportId = c.req.param('reportId');
  const buffer = await getReportPdfBuffer(user.uid, reportId);
  if (!buffer) {
    return c.json({ error: 'Report not found' }, 404);
  }

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="qhiro-report-${reportId}.pdf"`,
    },
  });
});

apiRoutes.get('/dashboard', async (c) => {
  const user = c.get('user');
  const [parcels, alerts, schedules, flights, devices] = await Promise.all([
    getParcels(user.uid),
    getAlerts(user.uid),
    getSchedules(user.uid),
    getFlights(user.uid),
    getDevices(user.uid),
  ]);

  const nextFlight = schedules
    .filter((s) => s.enabled)
    .map((schedule) => withComputedNextRun(schedule))
    .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))[0] ?? null;

  return c.json({
    user: {
      displayName: user.displayName,
      country: user.country,
      location: user.location,
      role: user.role,
    },
    parcels,
    alerts: alerts.slice(0, 10),
    nextScheduledFlight: nextFlight,
    recentFlights: flights.slice(0, 5),
    devices,
  });
});
