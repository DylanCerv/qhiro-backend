import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { CROP_TYPES } from '../services/crops.js';
import { isFirebaseAuthConfigured } from '../services/firebase-auth.js';
import {
  admin,
  deleteSchedule,
  getActionExecutionLogs,
  getAlerts,
  getDevice,
  getDevices,
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
import type { Device, ScheduleType } from '../types/index.js';

const scheduleSchema = z.object({
  scheduleId: z.string().optional(),
  parcelId: z.string(),
  scheduleType: z.enum(['routine', 'inspection', 'emergency']).default('routine'),
  startTime: z.string(),
  frequencyDays: z.number().min(1),
  enabled: z.boolean(),
});

const deviceSchema = z.object({
  name: z.string().min(2),
  type: z.enum(['drone', 'sensor', 'nest', 'sentinel']),
  status: z.enum(['online', 'offline', 'lowBattery']).optional(),
  parcelId: z.string().optional(),
  zoneId: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.type !== 'sentinel') return;
  if (!value.parcelId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['parcelId'], message: 'Sentinel parcelId is required' });
  }
});

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
  const schedules = await getSchedules(user.uid);
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
  const startTimeChanged = Boolean(existing && existing.startTime !== parsed.data.startTime);

  const schedule = {
    scheduleId,
    userId: user.uid,
    parcelId: parsed.data.parcelId,
    scheduleType: parsed.data.scheduleType as ScheduleType,
    startTime: parsed.data.startTime,
    frequencyDays: parsed.data.frequencyDays,
    enabled: parsed.data.enabled,
    lastRunAt: existing?.lastRunAt ?? null,
    nextRunAt: existing && parsed.data.scheduleId && !startTimeChanged
      ? existing.nextRunAt
      : parsed.data.startTime,
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
    const existingSentinel = (await getDevices(user.uid)).find(
      (device) => device.type === 'sentinel' && device.parcelId === parsed.data.parcelId,
    );
    if (existingSentinel) {
      return c.json({ error: 'This parcel already has a registered sentinel.' }, 409);
    }
  }

  const device: Device = {
    deviceId: randomUUID(),
    userId: user.uid,
    name: parsed.data.name,
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
    const existingSentinel = (await getDevices(user.uid)).find(
      (device) =>
        device.type === 'sentinel' &&
        device.parcelId === parsed.data.parcelId &&
        device.deviceId !== deviceId,
    );
    if (existingSentinel) {
      return c.json({ error: 'This parcel already has a registered sentinel.' }, 409);
    }
  }

  const device: Device = {
    ...existing,
    name: parsed.data.name,
    type: parsed.data.type,
    status: parsed.data.status ?? existing.status,
    parcelId: parsed.data.type === 'sentinel' ? parsed.data.parcelId : undefined,
    zoneId: parsed.data.type === 'sentinel' ? parsed.data.zoneId : undefined,
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
