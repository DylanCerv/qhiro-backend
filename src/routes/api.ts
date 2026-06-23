import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { isFirebaseAuthConfigured } from '../services/firebase-auth.js';
import {
  admin,
  deleteSchedule,
  getAlerts,
  getDevices,
  getFlights,
  getParcels,
  getReportPdfBuffer,
  getReports,
  getSchedules,
  upsertDevice,
  upsertSchedule,
} from '../services/firebase.js';
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
  type: z.enum(['drone', 'sensor', 'nest']),
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

apiRoutes.use('/*', authMiddleware);

apiRoutes.get('/alerts', async (c) => {
  const user = c.get('user');
  const alerts = await getAlerts(user.uid);
  return c.json({ alerts });
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

  const device: Device = {
    deviceId: randomUUID(),
    userId: user.uid,
    name: parsed.data.name,
    type: parsed.data.type,
    status: 'offline',
    batteryLevel: 100,
    lastSeenAt: new Date().toISOString(),
  };

  await upsertDevice(user.uid, device);
  return c.json({ device }, 201);
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
