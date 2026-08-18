import cron, { type ScheduledTask } from 'node-cron';
import { randomUUID } from 'node:crypto';
import {
  createFlight,
  getAllEnabledSchedules,
  getDevices,
  upsertSchedule,
} from './firebase.js';
import { sendDroneCommand } from './mqtt.js';
import { getNextOccurrence, resolveRepeat, toMinute } from '../utils/schedule.js';

let scheduledTask: ScheduledTask | null = null;

export function stopFlightScheduler(): void {
  scheduledTask?.stop();
  scheduledTask = null;
}

export function startFlightScheduler(): void {
  scheduledTask = cron.schedule('* * * * *', async () => {
    try {
      await processDueFlights();
    } catch (error) {
      console.error('[Scheduler] Error processing flights:', error);
    }
  });

  console.log('[Scheduler] Flight scheduler started (every minute)');
}

async function processDueFlights(): Promise<void> {
  const schedules = await getAllEnabledSchedules();
  const now = new Date();

  for (const schedule of schedules) {
    const nextRun = getNextOccurrence(
      schedule.startTime,
      schedule.repeatEvery,
      schedule.repeatUnit,
      schedule.frequencyDays,
      now,
    );
    if (toMinute(nextRun) > toMinute(now)) {
      const storedNext = schedule.nextRunAt ? new Date(schedule.nextRunAt) : null;
      const storedMinute = storedNext && !Number.isNaN(storedNext.getTime())
        ? toMinute(storedNext)
        : null;
      if (storedMinute !== toMinute(nextRun)) {
        await upsertSchedule(schedule.userId, {
          ...schedule,
          nextRunAt: nextRun.toISOString(),
        });
      }
      continue;
    }
    const lastRun = schedule.lastRunAt ? new Date(schedule.lastRunAt) : null;
    if (lastRun && toMinute(lastRun) >= toMinute(nextRun)) {
      const upcoming = getNextOccurrence(
        schedule.startTime,
        schedule.repeatEvery,
        schedule.repeatUnit,
        schedule.frequencyDays,
        new Date(now.getTime() + 60_000),
      );
      await upsertSchedule(schedule.userId, {
        ...schedule,
        nextRunAt: upcoming.toISOString(),
      });
      continue;
    }

    const flightId = randomUUID();
    const startedAt = now.toISOString();
    const drone = (await getDevices(schedule.userId)).find(
      (device) => device.type === 'drone' && device.status !== 'offline',
    );

    if (!drone) {
      console.warn(`[Scheduler] No available drone for user ${schedule.userId}. Skipping schedule ${schedule.scheduleId}`);
      continue;
    }

    const parcelIds = schedule.parcelIds?.length
      ? schedule.parcelIds
      : schedule.parcelId
        ? [schedule.parcelId]
        : [];

    await createFlight(schedule.userId, {
      flightId,
      userId: schedule.userId,
      parcelId: parcelIds[0] ?? schedule.parcelId,
      status: 'started',
      scheduledAt: nextRun.toISOString(),
      startedAt,
      completedAt: null,
      reportId: null,
    });

    sendDroneCommand({
      action: 'startFlight',
      flightId,
      userId: schedule.userId,
      deviceId: drone.deviceId,
      parcelId: parcelIds[0] ?? schedule.parcelId,
      parcelIds,
      scheduleType: schedule.scheduleType ?? 'routine',
      timestamp: startedAt,
    });

    const repeat = resolveRepeat(
      schedule.repeatEvery,
      schedule.repeatUnit,
      schedule.frequencyDays,
    );
    const nextRunAt = getNextOccurrence(
      schedule.startTime,
      repeat.repeatEvery,
      repeat.repeatUnit,
      repeat.frequencyDays,
      new Date(now.getTime() + 60_000),
    );
    await upsertSchedule(schedule.userId, {
      ...schedule,
      lastRunAt: startedAt,
      nextRunAt: nextRunAt.toISOString(),
      repeatEvery: repeat.repeatEvery,
      repeatUnit: repeat.repeatUnit,
      frequencyDays: repeat.frequencyDays,
    });

    console.log(`[Scheduler] Flight ${flightId} started for route ${parcelIds.join(' -> ') || schedule.parcelId}`);
  }
}
