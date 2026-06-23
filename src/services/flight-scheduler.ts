import cron, { type ScheduledTask } from 'node-cron';
import { randomUUID } from 'node:crypto';
import {
  createFlight,
  getAllEnabledSchedules,
  upsertSchedule,
} from './firebase.js';
import { sendDroneCommand } from './mqtt.js';

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
    const nextRun = new Date(schedule.nextRunAt);
    if (nextRun > now) continue;

    const flightId = randomUUID();
    const startedAt = now.toISOString();

    await createFlight(schedule.userId, {
      flightId,
      userId: schedule.userId,
      parcelId: schedule.parcelId,
      status: 'started',
      scheduledAt: schedule.nextRunAt,
      startedAt,
      completedAt: null,
      reportId: null,
    });

    sendDroneCommand({
      action: 'startFlight',
      flightId,
      userId: schedule.userId,
      parcelId: schedule.parcelId,
      scheduleType: schedule.scheduleType ?? 'routine',
      timestamp: startedAt,
    });

    const nextRunAt = new Date(now.getTime() + schedule.frequencyDays * 24 * 60 * 60 * 1000);
    await upsertSchedule(schedule.userId, {
      ...schedule,
      lastRunAt: startedAt,
      nextRunAt: nextRunAt.toISOString(),
    });

    console.log(`[Scheduler] Flight ${flightId} started for parcel ${schedule.parcelId}`);
  }
}
