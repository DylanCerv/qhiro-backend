import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adminMiddleware } from '../middleware/admin.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  admin,
  deleteParcel,
  createFlight,
  getActionExecutionLogs,
  getAllClients,
  getDevice,
  getDevices,
  getParcels,
  getTelemetryProcessingLogs,
  getUserProfile,
  updateClientAccountStatus,
  upsertParcel,
} from '../services/firebase.js';
import { getMqttStatus, publishActionAck, publishMqttDiagnostic, publishTelemetry } from '../services/mqtt.js';
import type { AccountStatus, Parcel } from '../types/index.js';

const parcelSchema = z.object({
  name: z.string().min(2),
  cropType: z
    .string()
    .optional()
    .refine((value) => !value || value.length >= 2, { message: 'Invalid crop type' }),
  zoneId: z.string().min(1),
  coordinates: z
    .array(
      z.object({
        lat: z.number(),
        lng: z.number(),
      }),
    )
    .min(3),
});

const accountStatusSchema = z.object({
  accountStatus: z.enum(['active', 'suspended', 'disabled']),
});

const mqttDiagnosticSchema = z.object({
  message: z.string().min(1).max(500).default('Qhiro MQTT diagnostic ping'),
});

const adminTelemetrySchema = z.object({
  userId: z.string().min(1),
  deviceId: z.string().min(1),
  deviceType: z.enum(['drone', 'sensor', 'nest', 'sentinel']),
  payload: z.record(z.unknown()),
});

const testFlightSchema = z.object({
  userId: z.string().min(1),
  parcelId: z.string().min(1),
  deviceId: z.string().min(1),
});

const actionAckSchema = z.object({
  userId: z.string().min(1),
  deviceId: z.string().min(1),
  actionId: z.string().min(1),
  status: z.enum(['completed', 'failed']),
  details: z.string().optional(),
  error: z.string().optional(),
  missingResource: z.string().optional(),
});

export const parcelRoutes = new Hono();
export const adminRoutes = new Hono();

parcelRoutes.use('/*', authMiddleware);

parcelRoutes.get('/', async (c) => {
  const user = c.get('user');
  const parcels = await getParcels(user.uid);
  return c.json({ parcels });
});

parcelRoutes.post('/', async (c) => {
  const user = c.get('user');
  if (user.role !== 'client') {
    return c.json({ error: 'Only clients can create parcels' }, 403);
  }

  const body = await c.req.json();
  const parsed = parcelSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid parcel payload', details: parsed.error.flatten() }, 400);
  }

  const parcel: Parcel = {
    parcelId: randomUUID(),
    userId: user.uid,
    name: parsed.data.name,
    cropType: parsed.data.cropType?.trim() || '',
    zoneId: parsed.data.zoneId,
    coordinates: parsed.data.coordinates,
    ndvi: 0,
    healthStatus: 'green',
    soilMoisture: 0,
    soilNutrients: { nitrogen: 0, phosphorus: 0, potassium: 0 },
    createdAt: new Date().toISOString(),
  };

  await upsertParcel(user.uid, parcel);
  return c.json({ parcel }, 201);
});

parcelRoutes.put('/:parcelId', async (c) => {
  const user = c.get('user');
  const parcelId = c.req.param('parcelId');
  const body = await c.req.json();
  const parsed = parcelSchema.partial().safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid parcel payload', details: parsed.error.flatten() }, 400);
  }

  if (parsed.data.coordinates && parsed.data.coordinates.length < 3) {
    return c.json({ error: 'Parcel polygon must have at least 3 points' }, 400);
  }

  const parcels = await getParcels(user.uid);
  const existing = parcels.find((p) => p.parcelId === parcelId);
  if (!existing) {
    return c.json({ error: 'Parcel not found' }, 404);
  }

  const updated: Parcel = { ...existing, ...parsed.data };
  await upsertParcel(user.uid, updated);
  return c.json({ parcel: updated });
});

parcelRoutes.delete('/:parcelId', async (c) => {
  const user = c.get('user');
  const parcelId = c.req.param('parcelId');
  const deleted = await deleteParcel(user.uid, parcelId);
  if (!deleted) {
    return c.json({ error: 'Parcel not found' }, 404);
  }
  return c.json({ success: true });
});

adminRoutes.use('/*', authMiddleware, adminMiddleware);

adminRoutes.get('/clients', async (c) => {
  const clients = await getAllClients();
  const enriched = await Promise.all(
    clients.map(async (client) => {
      const parcels = await getParcels(client.userId);
      return { ...client, parcelCount: parcels.length };
    }),
  );
  return c.json({ clients: enriched });
});

adminRoutes.patch('/clients/:userId/account-status', async (c) => {
  const userId = c.req.param('userId');
  const body = await c.req.json();
  const parsed = accountStatusSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid account status payload', details: parsed.error.flatten() }, 400);
  }

  const profile = await getUserProfile(userId);
  if (!profile) {
    return c.json({ error: 'Client not found' }, 404);
  }

  const updated = await updateClientAccountStatus(
    userId,
    parsed.data.accountStatus as AccountStatus,
  );
  if (!updated) {
    return c.json({ error: 'Unable to update client account' }, 400);
  }

  if (admin.apps.length) {
    await admin.auth().updateUser(userId, { disabled: parsed.data.accountStatus === 'disabled' });
  }

  return c.json({ client: updated });
});

adminRoutes.get('/clients/:userId/devices', async (c) => {
  const userId = c.req.param('userId');
  const profile = await getUserProfile(userId);
  if (!profile || profile.role !== 'client') {
    return c.json({ error: 'Client not found' }, 404);
  }

  const devices = await getDevices(userId);
  return c.json({ client: profile, devices });
});

adminRoutes.get('/clients/:userId/parcels', async (c) => {
  const userId = c.req.param('userId');
  const profile = await getUserProfile(userId);
  if (!profile || profile.role !== 'client') {
    return c.json({ error: 'Client not found' }, 404);
  }

  const parcels = await getParcels(userId);
  return c.json({ client: profile, parcels });
});

adminRoutes.get('/clients/:userId/telemetry-logs', async (c) => {
  const userId = c.req.param('userId');
  const profile = await getUserProfile(userId);
  if (!profile || profile.role !== 'client') {
    return c.json({ error: 'Client not found' }, 404);
  }

  const logs = await getTelemetryProcessingLogs(userId);
  return c.json({ client: profile, logs });
});

adminRoutes.get('/clients/:userId/action-logs', async (c) => {
  const userId = c.req.param('userId');
  const profile = await getUserProfile(userId);
  if (!profile || profile.role !== 'client') {
    return c.json({ error: 'Client not found' }, 404);
  }

  const logs = await getActionExecutionLogs(userId);
  return c.json({ client: profile, logs });
});

adminRoutes.get('/mqtt/status', (c) => c.json({ mqtt: getMqttStatus() }));

adminRoutes.post('/mqtt/diagnostic', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = mqttDiagnosticSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid MQTT diagnostic payload', details: parsed.error.flatten() }, 400);
  }

  publishMqttDiagnostic({
    message: parsed.data.message,
    adminUserId: c.get('user').uid,
  });

  return c.json({
    published: true,
    topic: 'qhiro/admin/diagnostics',
    mqtt: getMqttStatus(),
  });
});

adminRoutes.post('/mqtt/telemetry', async (c) => {
  const body = await c.req.json();
  const parsed = adminTelemetrySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid admin telemetry payload', details: parsed.error.flatten() }, 400);
  }

  const { userId, deviceId, deviceType, payload } = parsed.data;
  const device = await getDevice(userId, deviceId);
  if (!device) {
    return c.json({ error: 'Device not found for the provided userId' }, 404);
  }
  if (device.type !== deviceType) {
    return c.json({ error: `Device type mismatch. Registered as ${device.type}.` }, 400);
  }

  publishTelemetry(userId, deviceId, deviceType, payload);
  return c.json({
    published: true,
    topic: `qhiro/users/${userId}/devices/${deviceId}/${deviceType}/telemetry`,
    mqtt: getMqttStatus(),
  });
});

adminRoutes.post('/mqtt/action-ack', async (c) => {
  const body = await c.req.json();
  const parsed = actionAckSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid action ACK payload', details: parsed.error.flatten() }, 400);
  }

  const { userId, deviceId, actionId, status, details, error, missingResource } = parsed.data;
  const payload = {
    status,
    finishedAt: new Date().toISOString(),
    details,
    error,
    missingResource,
    source: 'admin-sentinel-simulator',
  };

  publishActionAck(userId, deviceId, actionId, payload);
  return c.json({
    published: true,
    topic: `qhiro/users/${userId}/devices/${deviceId}/actions/${actionId}/ack`,
    payload,
    mqtt: getMqttStatus(),
  });
});

adminRoutes.post('/mqtt/test-flight', async (c) => {
  const body = await c.req.json();
  const parsed = testFlightSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid test flight payload', details: parsed.error.flatten() }, 400);
  }

  const { userId, parcelId, deviceId } = parsed.data;
  const device = await getDevice(userId, deviceId);
  if (!device) {
    return c.json({ error: 'Device not found for the provided userId' }, 404);
  }
  if (device.type !== 'drone') {
    return c.json({ error: `Test flight requires a drone. Registered as ${device.type}.` }, 400);
  }

  const parcel = (await getParcels(userId)).find((item) => item.parcelId === parcelId);
  if (!parcel) {
    return c.json({ error: 'Parcel not found for the provided userId' }, 404);
  }

  const now = new Date().toISOString();
  const flight = {
    flightId: randomUUID(),
    userId,
    parcelId,
    status: 'started' as const,
    scheduledAt: now,
    startedAt: now,
    completedAt: null,
    reportId: null,
  };

  await createFlight(userId, flight);
  return c.json({ flight });
});

adminRoutes.post('/mqtt/test-drone-flow', async (c) => {
  const body = await c.req.json();
  const parsed = z.object({
    userId: z.string().min(1),
    parcelId: z.string().min(1),
    deviceId: z.string().min(1),
    payload: z.record(z.unknown()),
  }).safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid test drone flow payload', details: parsed.error.flatten() }, 400);
  }

  const { userId, parcelId, deviceId } = parsed.data;
  const device = await getDevice(userId, deviceId);
  if (!device) {
    return c.json({ error: 'Device not found for the provided userId' }, 404);
  }
  if (device.type !== 'drone') {
    return c.json({ error: `Full drone flow requires a drone. Registered as ${device.type}.` }, 400);
  }

  const parcel = (await getParcels(userId)).find((item) => item.parcelId === parcelId);
  if (!parcel) {
    return c.json({ error: 'Parcel not found for the provided userId' }, 404);
  }

  const now = new Date().toISOString();
  const flight = {
    flightId: randomUUID(),
    userId,
    parcelId,
    status: 'started' as const,
    scheduledAt: now,
    startedAt: now,
    completedAt: null,
    reportId: null,
  };
  const payload = {
    ...parsed.data.payload,
    parcelId,
    flightId: flight.flightId,
    status: 'completed',
    timestamp: now,
  };

  await createFlight(userId, flight);
  publishTelemetry(userId, deviceId, 'drone', payload);

  return c.json({
    published: true,
    flight,
    payload,
    topic: `qhiro/users/${userId}/devices/${deviceId}/drone/telemetry`,
    mqtt: getMqttStatus(),
  });
});
