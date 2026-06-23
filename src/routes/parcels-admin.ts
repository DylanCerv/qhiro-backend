import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adminMiddleware } from '../middleware/admin.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  admin,
  deleteParcel,
  getAllClients,
  getParcels,
  getUserProfile,
  updateClientAccountStatus,
  upsertParcel,
} from '../services/firebase.js';
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
