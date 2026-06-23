import admin from 'firebase-admin';
import { env, loadServiceAccount } from '../config/env.js';
import type {
  Alert,
  AccountStatus,
  Device,
  Flight,
  FlightSchedule,
  Parcel,
  Report,
  UserProfile,
} from '../types/index.js';

let initialized = false;

export function initFirebase(): void {
  if (initialized) return;

  const serviceAccount = loadServiceAccount();
  if (serviceAccount && env.firebaseProjectId) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
      projectId: env.firebaseProjectId,
      storageBucket: `${env.firebaseProjectId}.appspot.com`,
    });
    console.log(`[Firebase] Connected to project "${env.firebaseProjectId}"`);
    console.log('[Firebase] Using Cloud Firestore for application data.');
  } else {
    console.warn('[Firebase] Running without credentials — using in-memory fallback');
  }

  initialized = true;
}

function firestore() {
  if (!admin.apps.length) return null;
  return admin.firestore();
}

function storage() {
  if (!admin.apps.length) return null;
  return admin.storage();
}

const memoryStore: Record<string, unknown> = {};

function memGet<T>(path: string): T | null {
  return (memoryStore[path] as T) ?? null;
}

function memSet(path: string, value: unknown): void {
  memoryStore[path] = value;
}

export const ADMIN_SEED = {
  email: 'qhiro-symbiotic@qhiro-symbiotic.com',
  password: '123456789',
  displayName: 'Qhiro Symbiotic Admin',
  demoUserId: 'admin_demo',
} as const;

const DEMO_USERS: Record<string, UserProfile> = {
  [ADMIN_SEED.demoUserId]: {
    userId: ADMIN_SEED.demoUserId,
    email: ADMIN_SEED.email,
    displayName: ADMIN_SEED.displayName,
    role: 'admin',
    accountStatus: 'active',
    country: 'EC',
    location: { lat: -0.1807, lng: -78.4678 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
};

const demoCredentials: Record<string, { userId: string; password: string }> = {
  [ADMIN_SEED.email.toLowerCase()]: {
    userId: ADMIN_SEED.demoUserId,
    password: ADMIN_SEED.password,
  },
};

function resolveDemoToken(token: string): { uid: string; email?: string } | null {
  if (token === 'demo-admin') {
    return { uid: ADMIN_SEED.demoUserId, email: ADMIN_SEED.email };
  }
  if (token.startsWith('demo-user:')) {
    const uid = token.slice('demo-user:'.length);
    return { uid };
  }
  return null;
}

export async function seedAdminUser(): Promise<void> {
  const now = new Date().toISOString();
  const profileBase = {
    email: ADMIN_SEED.email,
    displayName: ADMIN_SEED.displayName,
    role: 'admin' as const,
    accountStatus: 'active' as const,
    country: 'EC',
    location: { lat: -0.1807, lng: -78.4678 },
    createdAt: now,
    updatedAt: now,
  };

  if (admin.apps.length) {
    const fs = firestore();
    if (fs) {
      for (const legacyId of ['admin_demo', 'client_demo']) {
        await fs.collection('users').doc(legacyId).delete();
      }
    }

    let authUser: admin.auth.UserRecord;
    try {
      authUser = await admin.auth().getUserByEmail(ADMIN_SEED.email);
      await admin.auth().updateUser(authUser.uid, {
        password: ADMIN_SEED.password,
        displayName: ADMIN_SEED.displayName,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'auth/user-not-found') throw error;
      authUser = await admin.auth().createUser({
        email: ADMIN_SEED.email,
        password: ADMIN_SEED.password,
        displayName: ADMIN_SEED.displayName,
        emailVerified: true,
      });
    }

    await upsertUserProfile({ ...profileBase, userId: authUser.uid });
    console.log(`[Seed] Admin user ready: ${ADMIN_SEED.email}`);
    return;
  }

  await upsertUserProfile({ ...profileBase, userId: ADMIN_SEED.demoUserId });
  console.log(`[Seed] Demo admin ready: ${ADMIN_SEED.email}`);
}

export async function loginDemoUser(
  email: string,
  password: string,
): Promise<{ uid: string; email: string; token: string } | null> {
  if (admin.apps.length) return null;
  const cred = demoCredentials[email.toLowerCase()];
  if (cred && cred.password === password) {
    return { uid: cred.userId, email, token: `demo-user:${cred.userId}` };
  }
  const stored = memGet<{ userId: string; password: string }>(`auth/${email.toLowerCase()}`);
  if (stored && stored.password === password) {
    return { uid: stored.userId, email, token: `demo-user:${stored.userId}` };
  }
  return null;
}

export async function verifyIdToken(token: string): Promise<{ uid: string; email?: string }> {
  if (!admin.apps.length) {
    const demo = resolveDemoToken(token);
    if (demo) return demo;
    throw new Error('Invalid demo token');
  }
  const decoded = await admin.auth().verifyIdToken(token);
  return { uid: decoded.uid, email: decoded.email };
}

export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const fs = firestore();
  if (!fs) {
    const profile = DEMO_USERS[userId] ?? memGet<UserProfile>(`users/${userId}`);
    return profile ?? null;
  }
  const snap = await fs.collection('users').doc(userId).get();
  return snap.exists ? (snap.data() as UserProfile) : null;
}

export async function upsertUserProfile(profile: UserProfile): Promise<void> {
  const fs = firestore();
  if (!fs) {
    memSet(`users/${profile.userId}`, profile);
    if (DEMO_USERS[profile.userId]) {
      DEMO_USERS[profile.userId] = profile;
    }
    return;
  }
  await fs.collection('users').doc(profile.userId).set(profile);
}

export async function getAllClients(): Promise<UserProfile[]> {
  const fs = firestore();
  if (!fs) {
    return Object.values(DEMO_USERS)
      .concat(
        Object.entries(memoryStore)
          .filter(([key]) => key.startsWith('users/'))
          .map(([, val]) => val as UserProfile),
      )
      .filter((user, index, arr) => arr.findIndex((u) => u.userId === user.userId) === index)
      .filter((user) => user.role === 'client');
  }
  const snap = await fs.collection('users').where('role', '==', 'client').get();
  return snap.docs.map((doc) => doc.data() as UserProfile);
}

export async function updateClientAccountStatus(
  userId: string,
  accountStatus: AccountStatus,
): Promise<UserProfile | null> {
  const profile = await getUserProfile(userId);
  if (!profile || profile.role !== 'client') return null;

  const updated: UserProfile = {
    ...profile,
    accountStatus,
    updatedAt: new Date().toISOString(),
  };
  await upsertUserProfile(updated);
  return updated;
}

export async function createFirebaseAuthUser(
  email: string,
  password: string,
  displayName: string,
): Promise<{ uid: string; email: string }> {
  if (!admin.apps.length) {
    const uid = `client_${randomId()}`;
    const profile: UserProfile = {
      userId: uid,
      email,
      displayName,
      role: 'client',
      accountStatus: 'active',
      country: 'EC',
      location: { lat: -0.1807, lng: -78.4678 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await upsertUserProfile(profile);
    memSet(`auth/${email.toLowerCase()}`, { userId: uid, password });
    return { uid, email };
  }
  const user = await admin.auth().createUser({ email, password, displayName });
  return { uid: user.uid, email: user.email ?? email };
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function getParcels(userId: string): Promise<Parcel[]> {
  const fs = firestore();
  if (!fs) {
    const data = memGet<Record<string, Parcel>>(`parcels/${userId}`);
    return data ? Object.values(data) : [];
  }
  const snap = await fs.collection('parcels').where('userId', '==', userId).get();
  return snap.docs.map((doc) => doc.data() as Parcel);
}

export async function getParcel(userId: string, parcelId: string): Promise<Parcel | null> {
  const parcels = await getParcels(userId);
  return parcels.find((p) => p.parcelId === parcelId) ?? null;
}

export async function upsertParcel(userId: string, parcel: Parcel): Promise<void> {
  const fs = firestore();
  if (!fs) {
    const existing = memGet<Record<string, Parcel>>(`parcels/${userId}`) ?? {};
    existing[parcel.parcelId] = parcel;
    memSet(`parcels/${userId}`, existing);
    return;
  }
  await fs.collection('parcels').doc(parcel.parcelId).set({ ...parcel, userId });
}

export async function deleteParcel(userId: string, parcelId: string): Promise<boolean> {
  const fs = firestore();
  if (!fs) {
    const existing = memGet<Record<string, Parcel>>(`parcels/${userId}`) ?? {};
    if (!existing[parcelId]) return false;
    delete existing[parcelId];
    memSet(`parcels/${userId}`, existing);
    return true;
  }
  const ref = fs.collection('parcels').doc(parcelId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.userId !== userId) return false;
  await ref.delete();
  return true;
}

export async function getSchedules(userId: string): Promise<FlightSchedule[]> {
  const fs = firestore();
  if (!fs) {
    const data = memGet<Record<string, FlightSchedule>>(`schedules/${userId}`);
    return data ? Object.values(data) : [];
  }
  const snap = await fs.collection('schedules').where('userId', '==', userId).get();
  return snap.docs.map((doc) => doc.data() as FlightSchedule);
}

export async function getAllEnabledSchedules(): Promise<FlightSchedule[]> {
  const fs = firestore();
  if (!fs) {
    return Object.entries(memoryStore)
      .filter(([key]) => key.startsWith('schedules/'))
      .flatMap(([, val]) => Object.values(val as Record<string, FlightSchedule>))
      .filter((s) => s.enabled);
  }
  const snap = await fs.collection('schedules').where('enabled', '==', true).get();
  return snap.docs.map((doc) => doc.data() as FlightSchedule);
}

export async function upsertSchedule(userId: string, schedule: FlightSchedule): Promise<void> {
  const fs = firestore();
  if (!fs) {
    const existing = memGet<Record<string, FlightSchedule>>(`schedules/${userId}`) ?? {};
    existing[schedule.scheduleId] = schedule;
    memSet(`schedules/${userId}`, existing);
    return;
  }
  await fs.collection('schedules').doc(schedule.scheduleId).set({ ...schedule, userId });
}

export async function deleteSchedule(userId: string, scheduleId: string): Promise<boolean> {
  const fs = firestore();
  if (!fs) {
    const existing = memGet<Record<string, FlightSchedule>>(`schedules/${userId}`);
    if (!existing?.[scheduleId]) return false;
    delete existing[scheduleId];
    memSet(`schedules/${userId}`, existing);
    return true;
  }
  const ref = fs.collection('schedules').doc(scheduleId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.userId !== userId) return false;
  await ref.delete();
  return true;
}

export async function getReport(userId: string, reportId: string): Promise<Report | null> {
  const fs = firestore();
  if (!fs) {
    const data = memGet<Record<string, Report>>(`reports/${userId}`);
    return data?.[reportId] ?? null;
  }
  const snap = await fs.collection('reports').doc(reportId).get();
  if (!snap.exists || snap.data()?.userId !== userId) return null;
  return snap.data() as Report;
}

export async function getReportPdfBuffer(userId: string, reportId: string): Promise<Buffer | null> {
  const report = await getReport(userId, reportId);
  if (!report) return null;

  const memData = memGet<string>(`storage/${report.storagePath}`);
  if (memData) return Buffer.from(memData, 'base64');

  const bucket = storage()?.bucket();
  if (!bucket) return null;

  const file = bucket.file(report.storagePath);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [buffer] = await file.download();
  return buffer;
}

export async function createFlight(userId: string, flight: Flight): Promise<void> {
  const fs = firestore();
  if (!fs) {
    const existing = memGet<Record<string, Flight>>(`flights/${userId}`) ?? {};
    existing[flight.flightId] = flight;
    memSet(`flights/${userId}`, existing);
    return;
  }
  await fs.collection('flights').doc(flight.flightId).set({ ...flight, userId });
}

export async function updateFlight(userId: string, flightId: string, patch: Partial<Flight>): Promise<void> {
  const fs = firestore();
  if (!fs) {
    const existing = memGet<Record<string, Flight>>(`flights/${userId}`) ?? {};
    if (existing[flightId]) {
      existing[flightId] = { ...existing[flightId], ...patch };
      memSet(`flights/${userId}`, existing);
    }
    return;
  }
  await fs.collection('flights').doc(flightId).set({ ...patch, userId }, { merge: true });
}

export async function getFlights(userId: string): Promise<Flight[]> {
  const fs = firestore();
  if (!fs) {
    const data = memGet<Record<string, Flight>>(`flights/${userId}`);
    return data ? Object.values(data).sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt)) : [];
  }
  const snap = await fs.collection('flights').where('userId', '==', userId).get();
  return snap.docs
    .map((doc) => doc.data() as Flight)
    .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt));
}

export async function createAlert(userId: string, alert: Alert): Promise<void> {
  const fs = firestore();
  if (!fs) {
    const existing = memGet<Record<string, Alert>>(`alerts/${userId}`) ?? {};
    existing[alert.alertId] = alert;
    memSet(`alerts/${userId}`, existing);
    return;
  }
  await fs.collection('alerts').doc(alert.alertId).set({ ...alert, userId });
}

export async function getAlerts(userId: string): Promise<Alert[]> {
  const fs = firestore();
  if (!fs) {
    const data = memGet<Record<string, Alert>>(`alerts/${userId}`);
    return data ? Object.values(data).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  }
  const snap = await fs.collection('alerts').where('userId', '==', userId).get();
  return snap.docs
    .map((doc) => doc.data() as Alert)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getDevices(userId: string): Promise<Device[]> {
  const fs = firestore();
  if (!fs) {
    const data = memGet<Record<string, Device>>(`devices/${userId}`);
    return data ? Object.values(data) : [];
  }
  const snap = await fs.collection('devices').where('userId', '==', userId).get();
  return snap.docs.map((doc) => doc.data() as Device);
}

export async function upsertDevice(userId: string, device: Device): Promise<void> {
  const fs = firestore();
  if (!fs) {
    const existing = memGet<Record<string, Device>>(`devices/${userId}`) ?? {};
    existing[device.deviceId] = device;
    memSet(`devices/${userId}`, existing);
    return;
  }
  await fs.collection('devices').doc(device.deviceId).set({ ...device, userId });
}

export async function saveReport(userId: string, report: Report): Promise<void> {
  const fs = firestore();
  if (!fs) {
    const existing = memGet<Record<string, Report>>(`reports/${userId}`) ?? {};
    existing[report.reportId] = report;
    memSet(`reports/${userId}`, existing);
    return;
  }
  await fs.collection('reports').doc(report.reportId).set({ ...report, userId });
}

export async function getReports(userId: string): Promise<Report[]> {
  const fs = firestore();
  if (!fs) {
    const data = memGet<Record<string, Report>>(`reports/${userId}`);
    return data ? Object.values(data).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  }
  const snap = await fs.collection('reports').where('userId', '==', userId).get();
  return snap.docs
    .map((doc) => doc.data() as Report)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function uploadReportPdf(userId: string, reportId: string, buffer: Buffer): Promise<string> {
  const bucket = storage()?.bucket();
  const storagePath = `reports/${userId}/${reportId}.pdf`;
  if (!bucket) {
    memSet(`storage/${storagePath}`, buffer.toString('base64'));
    return storagePath;
  }
  const file = bucket.file(storagePath);
  await file.save(buffer, { contentType: 'application/pdf' });
  return storagePath;
}

export { admin };
