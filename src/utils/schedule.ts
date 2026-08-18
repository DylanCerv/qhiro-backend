export type RepeatUnit = 'day' | 'week' | 'month';

type RepeatLike = {
  scheduleId?: string;
  startTime: string;
  repeatEvery?: number;
  repeatUnit?: RepeatUnit;
  frequencyDays?: number;
};

export function toFrequencyDays(repeatEvery: number, repeatUnit: RepeatUnit): number {
  if (repeatUnit === 'week') return repeatEvery * 7;
  if (repeatUnit === 'month') return repeatEvery * 30;
  return repeatEvery;
}

export function addRepeatInterval(from: Date, repeatEvery: number, repeatUnit: RepeatUnit): Date {
  const next = new Date(from);
  if (repeatUnit === 'week') {
    next.setDate(next.getDate() + repeatEvery * 7);
    return next;
  }
  if (repeatUnit === 'month') {
    next.setMonth(next.getMonth() + repeatEvery);
    return next;
  }
  next.setDate(next.getDate() + repeatEvery);
  return next;
}

export function toMinute(date: Date): number {
  return Math.floor(date.getTime() / 60_000);
}

export function getNextOccurrence(
  startTime: string,
  repeatEvery?: number,
  repeatUnit?: RepeatUnit,
  frequencyDays?: number,
  from = new Date(),
): Date {
  const repeat = resolveRepeat(repeatEvery, repeatUnit, frequencyDays);
  let cursor = new Date(startTime);
  if (Number.isNaN(cursor.getTime())) return from;

  let guard = 0;
  while (toMinute(cursor) < toMinute(from) && guard < 400) {
    cursor = addRepeatInterval(cursor, repeat.repeatEvery, repeat.repeatUnit);
    guard += 1;
  }
  return cursor;
}

export function withComputedNextRun<T extends RepeatLike>(schedule: T, from = new Date()): T & { nextRunAt: string } {
  return {
    ...schedule,
    nextRunAt: getNextOccurrence(
      schedule.startTime,
      schedule.repeatEvery,
      schedule.repeatUnit,
      schedule.frequencyDays,
      from,
    ).toISOString(),
  };
}

export function resolveRepeat(
  repeatEvery?: number,
  repeatUnit?: RepeatUnit,
  frequencyDays?: number,
): { repeatEvery: number; repeatUnit: RepeatUnit; frequencyDays: number } {
  const unit = repeatUnit ?? 'day';
  const every = Math.max(1, repeatEvery ?? frequencyDays ?? 1);
  return {
    repeatEvery: every,
    repeatUnit: unit,
    frequencyDays: toFrequencyDays(every, unit),
  };
}

function occurrenceKey(date: Date): string {
  return date.toISOString().slice(0, 16);
}

export function listScheduleOccurrences(schedule: RepeatLike, horizonMonths = 24): Set<string> {
  const start = new Date(schedule.startTime);
  const keys = new Set<string>();
  if (Number.isNaN(start.getTime())) return keys;

  const repeat = resolveRepeat(schedule.repeatEvery, schedule.repeatUnit, schedule.frequencyDays);
  const limit = new Date(start);
  limit.setMonth(limit.getMonth() + horizonMonths);

  let cursor = new Date(start);
  let guard = 0;
  while (cursor <= limit && guard < 400) {
    keys.add(occurrenceKey(cursor));
    cursor = addRepeatInterval(cursor, repeat.repeatEvery, repeat.repeatUnit);
    guard += 1;
  }
  return keys;
}

export function findOverlappingSchedule(
  candidate: RepeatLike,
  schedules: RepeatLike[],
): RepeatLike | undefined {
  const candidateKeys = listScheduleOccurrences(candidate);
  return schedules.find((schedule) => {
    if (schedule.scheduleId && candidate.scheduleId && schedule.scheduleId === candidate.scheduleId) {
      return false;
    }
    const otherKeys = listScheduleOccurrences(schedule);
    for (const key of candidateKeys) {
      if (otherKeys.has(key)) return true;
    }
    return false;
  });
}

