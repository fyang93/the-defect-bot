import solarLunar from "solarlunar";
import { getUserTimezone } from "bot/app/state";
import { loadConfig } from "bot/app/config";
import type { AppConfig } from "bot/app/types";
import { uiLocaleTag, type Locale } from "bot/app/i18n";
import type {
  EventRecord,
  ReminderInstance,
  EventOccurrence,
  ScheduleRecurrence,
  EventSchedule,
} from "./types";

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const zonedDateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const displayDateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function clampPositiveInteger(value: unknown, fallback = 1): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function uniqueSortedDays(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)))
    .sort((a, b) => a - b);
}

function monthDay(year: number, monthIndex: number, requestedDay: number): number {
  return Math.min(requestedDay, new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate());
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

type LocalDateParts = { year: number; month: number; day: number };
type LocalDateTimeParts = LocalDateParts & { hour: number; minute: number; second?: number };

function zonedFormatter(timezone: string): Intl.DateTimeFormat {
  const existing = zonedDateTimeFormatters.get(timezone);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
  zonedDateTimeFormatters.set(timezone, created);
  return created;
}

function getZonedParts(date: Date, timezone: string): ZonedParts {
  const parts = zonedFormatter(timezone).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: Number(byType.hour),
    minute: Number(byType.minute),
    second: Number(byType.second),
    weekday: WEEKDAY_INDEX[byType.weekday] ?? 0,
  };
}

function displayDateTimeFormatter(config: AppConfig, timezone: string): Intl.DateTimeFormat {
  const key = `${uiLocaleTag(config)}::${timezone}`;
  const existing = displayDateTimeFormatters.get(key);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat(uiLocaleTag(config), {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  displayDateTimeFormatters.set(key, created);
  return created;
}

function formatDisplayDateTime(config: AppConfig, iso: string, timezone: string): string {
  return displayDateTimeFormatter(config, timezone).format(new Date(iso));
}

function compareLocalDateTime(a: LocalDateTimeParts, b: LocalDateTimeParts): number {
  return Date.UTC(a.year, a.month - 1, a.day, a.hour, a.minute, a.second || 0) - Date.UTC(b.year, b.month - 1, b.day, b.hour, b.minute, b.second || 0);
}

function localDateOnly(input: LocalDateTimeParts | LocalDateParts): LocalDateParts {
  return { year: input.year, month: input.month, day: input.day };
}

function addLocalDays(date: LocalDateParts, amount: number): LocalDateParts {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + amount));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function addLocalMonths(date: LocalDateParts, amount: number): LocalDateParts {
  const first = new Date(Date.UTC(date.year, date.month - 1, 1));
  first.setUTCMonth(first.getUTCMonth() + amount);
  return { year: first.getUTCFullYear(), month: first.getUTCMonth() + 1, day: monthDay(first.getUTCFullYear(), first.getUTCMonth(), date.day) };
}

function addLocalYears(date: LocalDateParts, amount: number): LocalDateParts {
  const year = date.year + amount;
  return { year, month: date.month, day: monthDay(year, date.month - 1, date.day) };
}

function localDateWeekday(date: LocalDateParts): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function localStartOfWeek(date: LocalDateParts): number {
  const weekday = localDateWeekday(date);
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day - weekday) / MS_PER_DAY);
}

function localWeeksBetween(a: LocalDateParts, b: LocalDateParts): number {
  return Math.floor((localStartOfWeek(b) - localStartOfWeek(a)) / 7);
}

function zonedLocalDateTimeToUtc(dateTime: LocalDateTimeParts, timezone: string): Date {
  let guess = new Date(Date.UTC(dateTime.year, dateTime.month - 1, dateTime.day, dateTime.hour, dateTime.minute, dateTime.second || 0, 0));
  for (let i = 0; i < 6; i += 1) {
    const actual = getZonedParts(guess, timezone);
    const diff = compareLocalDateTime(dateTime, actual);
    if (diff === 0) return guess;
    guess = new Date(guess.getTime() + diff);
  }
  return guess;
}

function cloneDate(date: Date): Date {
  return new Date(date.getTime());
}

function addMonths(base: Date, amount: number): Date {
  const next = cloneDate(base);
  const originalDay = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + amount);
  next.setDate(monthDay(next.getFullYear(), next.getMonth(), originalDay));
  return next;
}

function addYears(base: Date, amount: number): Date {
  const next = cloneDate(base);
  const month = next.getMonth();
  const day = next.getDate();
  next.setDate(1);
  next.setFullYear(next.getFullYear() + amount);
  next.setMonth(month);
  next.setDate(monthDay(next.getFullYear(), month, day));
  return next;
}

function startOfWeek(date: Date): Date {
  const next = cloneDate(date);
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() - next.getDay());
  return next;
}

function weeksBetween(a: Date, b: Date): number {
  const diff = startOfWeek(b).getTime() - startOfWeek(a).getTime();
  return Math.floor(diff / (7 * MS_PER_DAY));
}

function nthWeekdayOfMonth(year: number, monthIndex: number, weekOfMonth: number, dayOfWeek: number, hour: number, minute: number): Date | null {
  if (weekOfMonth === -1) {
    const lastDay = new Date(year, monthIndex + 1, 0);
    const offset = (lastDay.getDay() - dayOfWeek + 7) % 7;
    const candidate = new Date(year, monthIndex, lastDay.getDate() - offset, hour, minute, 0, 0);
    return candidate.getMonth() === monthIndex ? candidate : null;
  }
  const firstDay = new Date(year, monthIndex, 1);
  const offset = (dayOfWeek - firstDay.getDay() + 7) % 7;
  const day = 1 + offset + (weekOfMonth - 1) * 7;
  const candidate = new Date(year, monthIndex, day, hour, minute, 0, 0);
  return candidate.getMonth() === monthIndex ? candidate : null;
}

function lunarMonthLabel(month: number, isLeapMonth = false): string {
  return `${isLeapMonth ? "闰" : ""}${solarLunar.toChinaMonth(month)}`;
}

function lunarDayLabel(day: number): string {
  return solarLunar.toChinaDay(day);
}

function eventTime(schedule: EventSchedule, timezone?: string): { hour: number; minute: number } {
  if (schedule.kind === "once") {
    const date = new Date(schedule.scheduledAt);
    if (timezone) {
      const parts = getZonedParts(date, timezone);
      return { hour: parts.hour, minute: parts.minute };
    }
    return { hour: date.getHours(), minute: date.getMinutes() };
  }
  if (schedule.kind === "interval") {
    const date = new Date(schedule.anchorAt);
    if (timezone) {
      const parts = getZonedParts(date, timezone);
      return { hour: parts.hour, minute: parts.minute };
    }
    return { hour: date.getHours(), minute: date.getMinutes() };
  }
  return schedule.time;
}

export function normalizeScheduledAt(input: string, timezone?: string): string {
  const trimmed = input.trim();
  if (timezone && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(trimmed)) {
    const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (match) {
      const utc = zonedLocalDateTimeToUtc({
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4]),
        minute: Number(match[5]),
        second: Number(match[6] || "0"),
      }, timezone);
      return utc.toISOString();
    }
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid schedule time: ${input}`);
  }
  return new Date(parsed).toISOString();
}

export function normalizeRecurrence(input: unknown): ScheduleRecurrence {
  if (!input || typeof input !== "object") {
    return { kind: "once" };
  }
  const record = input as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : "once";

  if (kind === "daily") return { kind: "interval", unit: "day", every: 1 };
  if (kind === "weekdays") return { kind: "weekly", every: 1, daysOfWeek: [1, 2, 3, 4, 5] };
  if (kind === "weekends") return { kind: "weekly", every: 1, daysOfWeek: [0, 6] };
  if (kind === "once") return { kind: "once" };

  if (kind === "interval") {
    const unit = record.unit;
    if (unit === "minute" || unit === "hour" || unit === "day" || unit === "week" || unit === "month" || unit === "year") {
      return { kind: "interval", unit, every: clampPositiveInteger(record.every, 1) };
    }
    return { kind: "once" };
  }

  if (kind === "weekly") {
    const daysOfWeek = uniqueSortedDays(record.daysOfWeek);
    if (daysOfWeek.length > 0) {
      return { kind: "weekly", every: clampPositiveInteger(record.every, 1), daysOfWeek };
    }
    return { kind: "once" };
  }

  if (kind === "monthly") {
    const every = clampPositiveInteger(record.every, 1);
    const mode = record.mode;
    if (mode === "nthWeekday") {
      const weekOfMonth = Number(record.weekOfMonth);
      const dayOfWeek = Number(record.dayOfWeek);
      if (Number.isInteger(weekOfMonth) && weekOfMonth >= -1 && weekOfMonth <= 5 && weekOfMonth !== 0 && Number.isInteger(dayOfWeek) && dayOfWeek >= 0 && dayOfWeek <= 6) {
        return { kind: "monthly", every, mode: "nthWeekday", weekOfMonth, dayOfWeek };
      }
      return { kind: "once" };
    }
    const dayOfMonth = Number(record.dayOfMonth);
    if (Number.isInteger(dayOfMonth) && dayOfMonth >= 1 && dayOfMonth <= 31) {
      return { kind: "monthly", every, mode: "dayOfMonth", dayOfMonth };
    }
    return { kind: "once" };
  }

  if (kind === "yearly") {
    const month = Number(record.month);
    const day = Number(record.day);
    if (Number.isInteger(month) && month >= 1 && month <= 12 && Number.isInteger(day) && day >= 1 && day <= 31) {
      return { kind: "yearly", every: clampPositiveInteger(record.every, 1), month, day, offsetDays: Number.isInteger(Number(record.offsetDays)) ? Number(record.offsetDays) : 0 };
    }
  }

  if (kind === "lunarYearly") {
    const month = Number(record.month);
    const day = Number(record.day);
    const isLeapMonth = record.isLeapMonth === true;
    const leapMonthPolicy = record.leapMonthPolicy === "same-leap-only" || record.leapMonthPolicy === "both" || record.leapMonthPolicy === "prefer-non-leap"
      ? record.leapMonthPolicy
      : isLeapMonth ? "same-leap-only" : "prefer-non-leap";
    if (Number.isInteger(month) && month >= 1 && month <= 12 && Number.isInteger(day) && day >= 1 && day <= 30) {
      return { kind: "lunarYearly", month, day, isLeapMonth, leapMonthPolicy, offsetDays: Number.isInteger(Number(record.offsetDays)) ? Number(record.offsetDays) : 0 };
    }
  }

  return { kind: "once" };
}

export function effectiveLunarLeapPolicy(input: { isLeapMonth?: boolean; leapMonthPolicy?: "same-leap-only" | "prefer-non-leap" | "both" }): "same-leap-only" | "prefer-non-leap" | "both" {
  return input.leapMonthPolicy || (input.isLeapMonth ? "same-leap-only" : "prefer-non-leap");
}

export function nextLunarYearlyOccurrence(baseIso: string, now: Date, recurrence: Extract<ScheduleRecurrence, { kind: "lunarYearly" }>): string {
  const base = new Date(baseIso);
  if (!Number.isFinite(base.getTime())) throw new Error(`Invalid schedule time: ${baseIso}`);
  const nowLunar = solarLunar.solar2lunar(now.getFullYear(), now.getMonth() + 1, now.getDate());
  if (nowLunar === -1) throw new Error(`Failed to convert current date to lunar date: ${now.toISOString()}`);
  const offsetDays = recurrence.offsetDays || 0;
  for (let lunarYear = nowLunar.lYear; lunarYear <= nowLunar.lYear + 120; lunarYear += 1) {
    const leapMonth = solarLunar.leapMonth(lunarYear);
    const variants: boolean[] = [];
    if (!recurrence.isLeapMonth) {
      variants.push(false);
    } else if (effectiveLunarLeapPolicy(recurrence) === "same-leap-only") {
      if (leapMonth === recurrence.month) variants.push(true);
    } else if (effectiveLunarLeapPolicy(recurrence) === "both") {
      variants.push(false);
      if (leapMonth === recurrence.month) variants.push(true);
    } else {
      variants.push(false);
    }

    for (const isLeapMonth of Array.from(new Set(variants))) {
      const converted = solarLunar.lunar2solar(lunarYear, recurrence.month, recurrence.day, isLeapMonth);
      if (converted === -1) continue;
      const actualEvent = new Date(converted.cYear, converted.cMonth - 1, converted.cDay, base.getHours(), base.getMinutes(), base.getSeconds(), base.getMilliseconds());
      const candidate = new Date(actualEvent.getTime() + offsetDays * MS_PER_DAY);
      if (candidate.getTime() <= now.getTime()) continue;
      return candidate.toISOString();
    }
  }
  throw new Error(`Failed to compute next lunar schedule from ${baseIso}`);
}

function nextWeeklyEventOccurrence(schedule: Extract<EventSchedule, { kind: "weekly" }>, reference: Date): string {
  const start = cloneDate(reference);
  const anchor = schedule.anchorDate ? new Date(schedule.anchorDate) : start;
  for (let offset = 0; offset <= 366 * Math.max(1, schedule.every); offset += 1) {
    const candidate = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset, schedule.time.hour, schedule.time.minute, 0, 0);
    if (candidate.getTime() < reference.getTime()) continue;
    if (!schedule.daysOfWeek.includes(candidate.getDay())) continue;
    const passedWeeks = weeksBetween(anchor, candidate);
    if (passedWeeks % schedule.every !== 0) continue;
    return candidate.toISOString();
  }
  throw new Error("Failed to compute next weekly event occurrence");
}

function nextMonthlyEventOccurrence(schedule: Extract<EventSchedule, { kind: "monthly" }>, reference: Date): string {
  const startYear = reference.getFullYear();
  const startMonth = reference.getMonth();
  for (let monthOffset = 0; monthOffset <= schedule.every * 120; monthOffset += 1) {
    const year = startYear + Math.floor((startMonth + monthOffset) / 12);
    const monthIndex = (startMonth + monthOffset) % 12;
    let candidate: Date | null;
    if (schedule.mode === "dayOfMonth") {
      candidate = new Date(year, monthIndex, monthDay(year, monthIndex, schedule.dayOfMonth), schedule.time.hour, schedule.time.minute, 0, 0);
    } else {
      candidate = nthWeekdayOfMonth(year, monthIndex, schedule.weekOfMonth, schedule.dayOfWeek, schedule.time.hour, schedule.time.minute);
    }
    if (!candidate || candidate.getTime() < reference.getTime()) continue;
    return candidate.toISOString();
  }
  throw new Error("Failed to compute next monthly event occurrence");
}

function nextYearlyEventOccurrence(schedule: Extract<EventSchedule, { kind: "yearly" }>, reference: Date): string {
  for (let year = reference.getFullYear(); year <= reference.getFullYear() + schedule.every * 100; year += 1) {
    const candidate = new Date(year, schedule.month - 1, monthDay(year, schedule.month - 1, schedule.day), schedule.time.hour, schedule.time.minute, 0, 0);
    if (candidate.getTime() < reference.getTime()) continue;
    return candidate.toISOString();
  }
  throw new Error("Failed to compute next yearly event occurrence");
}

function nextLunarEventOccurrence(schedule: Extract<EventSchedule, { kind: "lunarYearly" }>, reference: Date): string {
  const base = new Date(reference);
  base.setHours(schedule.time.hour, schedule.time.minute, 0, 0);
  return nextLunarYearlyOccurrence(base.toISOString(), new Date(reference.getTime() - 1000), {
    kind: "lunarYearly",
    month: schedule.month,
    day: schedule.day,
    isLeapMonth: schedule.isLeapMonth,
    leapMonthPolicy: schedule.leapMonthPolicy,
  });
}

function nextIntervalEventOccurrence(schedule: Extract<EventSchedule, { kind: "interval" }>, reference: Date): string {
  let candidate = new Date(schedule.anchorAt);
  if (!Number.isFinite(candidate.getTime())) throw new Error(`Invalid schedule time: ${schedule.anchorAt}`);
  while (candidate.getTime() < reference.getTime()) {
    if (schedule.unit === "minute") candidate = new Date(candidate.getTime() + schedule.every * MS_PER_MINUTE);
    else if (schedule.unit === "hour") candidate = new Date(candidate.getTime() + schedule.every * MS_PER_HOUR);
    else if (schedule.unit === "day") candidate = new Date(candidate.getTime() + schedule.every * MS_PER_DAY);
    else if (schedule.unit === "week") candidate = new Date(candidate.getTime() + schedule.every * 7 * MS_PER_DAY);
    else if (schedule.unit === "month") candidate = addMonths(candidate, schedule.every);
    else candidate = addYears(candidate, schedule.every);
  }
  return candidate.toISOString();
}

function nextLocalWeeklyOccurrence(schedule: Extract<EventSchedule, { kind: "weekly" }>, reference: Date, timezone: string): string {
  const start = getZonedParts(reference, timezone);
  const startDate = localDateOnly(start);
  const anchor = schedule.anchorDate
    ? (() => {
        const [year, month, day] = schedule.anchorDate.split("-").map(Number);
        return { year, month, day } satisfies LocalDateParts;
      })()
    : startDate;
  for (let offset = 0; offset <= 366 * Math.max(1, schedule.every); offset += 1) {
    const candidateDate = addLocalDays(startDate, offset);
    const candidateWeekday = localDateWeekday(candidateDate);
    if (!schedule.daysOfWeek.includes(candidateWeekday)) continue;
    const passedWeeks = localWeeksBetween(anchor, candidateDate);
    if (passedWeeks % schedule.every !== 0) continue;
    const candidateUtc = zonedLocalDateTimeToUtc({ ...candidateDate, hour: schedule.time.hour, minute: schedule.time.minute }, timezone);
    if (candidateUtc.getTime() < reference.getTime()) continue;
    return candidateUtc.toISOString();
  }
  throw new Error("Failed to compute next local weekly event occurrence");
}

function nthWeekdayOfMonthLocal(year: number, month: number, weekOfMonth: number, dayOfWeek: number): LocalDateParts | null {
  if (weekOfMonth === -1) {
    const last = { year, month, day: monthDay(year, month - 1, 31) };
    const offset = (localDateWeekday(last) - dayOfWeek + 7) % 7;
    return addLocalDays(last, -offset);
  }
  const first = { year, month, day: 1 };
  const offset = (dayOfWeek - localDateWeekday(first) + 7) % 7;
  const day = 1 + offset + (weekOfMonth - 1) * 7;
  if (day > monthDay(year, month - 1, 31)) return null;
  return { year, month, day };
}

function nextLocalMonthlyOccurrence(schedule: Extract<EventSchedule, { kind: "monthly" }>, reference: Date, timezone: string): string {
  const start = getZonedParts(reference, timezone);
  const startMonth = { year: start.year, month: start.month, day: 1 };
  const anchor = schedule.anchorDate
    ? (() => {
        const [year, month, day] = schedule.anchorDate.split("-").map(Number);
        return { year, month, day } satisfies LocalDateParts;
      })()
    : localDateOnly(start);
  for (let monthOffset = 0; monthOffset <= schedule.every * 120; monthOffset += 1) {
    const monthBase = addLocalMonths(startMonth, monthOffset);
    const monthsSinceAnchor = (monthBase.year - anchor.year) * 12 + (monthBase.month - anchor.month);
    if (monthsSinceAnchor < 0 || monthsSinceAnchor % schedule.every !== 0) continue;
    const candidateDate = schedule.mode === "dayOfMonth"
      ? { year: monthBase.year, month: monthBase.month, day: monthDay(monthBase.year, monthBase.month - 1, schedule.dayOfMonth) }
      : nthWeekdayOfMonthLocal(monthBase.year, monthBase.month, schedule.weekOfMonth, schedule.dayOfWeek);
    if (!candidateDate) continue;
    const candidateUtc = zonedLocalDateTimeToUtc({ ...candidateDate, hour: schedule.time.hour, minute: schedule.time.minute }, timezone);
    if (candidateUtc.getTime() < reference.getTime()) continue;
    return candidateUtc.toISOString();
  }
  throw new Error("Failed to compute next local monthly event occurrence");
}

function nextLocalYearlyOccurrence(schedule: Extract<EventSchedule, { kind: "yearly" }>, reference: Date, timezone: string): string {
  const start = getZonedParts(reference, timezone);
  for (let year = start.year; year <= start.year + schedule.every * 100; year += 1) {
    const candidateDate = { year, month: schedule.month, day: monthDay(year, schedule.month - 1, schedule.day) };
    const candidateUtc = zonedLocalDateTimeToUtc({ ...candidateDate, hour: schedule.time.hour, minute: schedule.time.minute }, timezone);
    if (candidateUtc.getTime() < reference.getTime()) continue;
    return candidateUtc.toISOString();
  }
  throw new Error("Failed to compute next local yearly event occurrence");
}

function nextLocalLunarOccurrence(schedule: Extract<EventSchedule, { kind: "lunarYearly" }>, reference: Date, timezone: string): string {
  const referenceLocal = getZonedParts(reference, timezone);
  const nowLunar = solarLunar.solar2lunar(referenceLocal.year, referenceLocal.month, referenceLocal.day);
  if (nowLunar === -1) throw new Error(`Failed to convert current date to lunar date: ${reference.toISOString()}`);
  for (let lunarYear = nowLunar.lYear; lunarYear <= nowLunar.lYear + 120; lunarYear += 1) {
    const leapMonth = solarLunar.leapMonth(lunarYear);
    const variants: boolean[] = [];
    if (!schedule.isLeapMonth) {
      variants.push(false);
    } else if (effectiveLunarLeapPolicy(schedule) === "same-leap-only") {
      if (leapMonth === schedule.month) variants.push(true);
    } else if (effectiveLunarLeapPolicy(schedule) === "both") {
      variants.push(false);
      if (leapMonth === schedule.month) variants.push(true);
    } else {
      variants.push(false);
    }
    for (const isLeapMonth of Array.from(new Set(variants))) {
      const converted = solarLunar.lunar2solar(lunarYear, schedule.month, schedule.day, isLeapMonth);
      if (converted === -1) continue;
      let candidateDate: LocalDateParts = { year: converted.cYear, month: converted.cMonth, day: converted.cDay };
      if (candidateDate.year < referenceLocal.year - 1) continue;
      const candidateUtc = zonedLocalDateTimeToUtc({ ...candidateDate, hour: schedule.time.hour, minute: schedule.time.minute }, timezone);
      if (candidateUtc.getTime() < reference.getTime()) continue;
      return candidateUtc.toISOString();
    }
  }
  throw new Error("Failed to compute next local lunar event occurrence");
}

function nextLocalIntervalOccurrence(schedule: Extract<EventSchedule, { kind: "interval" }>, reference: Date, timezone: string): string {
  if (schedule.unit === "minute" || schedule.unit === "hour") {
    return nextIntervalEventOccurrence(schedule, reference);
  }
  const anchorUtc = new Date(schedule.anchorAt);
  if (!Number.isFinite(anchorUtc.getTime())) throw new Error(`Invalid schedule time: ${schedule.anchorAt}`);
  const anchorLocal = getZonedParts(anchorUtc, timezone);
  let candidateDate = localDateOnly(anchorLocal);
  let candidateUtc = zonedLocalDateTimeToUtc({ ...candidateDate, hour: anchorLocal.hour, minute: anchorLocal.minute, second: anchorLocal.second }, timezone);
  while (candidateUtc.getTime() < reference.getTime()) {
    if (schedule.unit === "day") candidateDate = addLocalDays(candidateDate, schedule.every);
    else if (schedule.unit === "week") candidateDate = addLocalDays(candidateDate, schedule.every * 7);
    else if (schedule.unit === "month") candidateDate = addLocalMonths(candidateDate, schedule.every);
    else candidateDate = addLocalYears(candidateDate, schedule.every);
    candidateUtc = zonedLocalDateTimeToUtc({ ...candidateDate, hour: anchorLocal.hour, minute: anchorLocal.minute, second: anchorLocal.second }, timezone);
  }
  return candidateUtc.toISOString();
}

function nextEventOccurrence(schedule: EventSchedule, reference = new Date()): string | null {
  if (schedule.kind === "once") {
    return schedule.scheduledAt;
  }
  if (schedule.kind === "interval") return nextIntervalEventOccurrence(schedule, reference);
  if (schedule.kind === "weekly") return nextWeeklyEventOccurrence(schedule, reference);
  if (schedule.kind === "monthly") return nextMonthlyEventOccurrence(schedule, reference);
  if (schedule.kind === "yearly") return nextYearlyEventOccurrence(schedule, reference);
  return nextLunarEventOccurrence(schedule, reference);
}

function configuredDefaultTimezone(): string {
  return loadConfig().bot.defaultTimezone;
}

function nextLocalEventOccurrence(event: EventRecord, reference = new Date(), timezoneOverride?: string): string | null {
  const timezone = timezoneOverride || getUserTimezone(event.createdByUserId) || configuredDefaultTimezone();
  if (event.schedule.kind === "once") return event.schedule.scheduledAt;
  if (event.schedule.kind === "interval") return nextLocalIntervalOccurrence(event.schedule, reference, timezone);
  if (event.schedule.kind === "weekly") return nextLocalWeeklyOccurrence(event.schedule, reference, timezone);
  if (event.schedule.kind === "monthly") return nextLocalMonthlyOccurrence(event.schedule, reference, timezone);
  if (event.schedule.kind === "yearly") return nextLocalYearlyOccurrence(event.schedule, reference, timezone);
  return nextLocalLunarOccurrence(event.schedule, reference, timezone);
}

export function resolveScheduleDisplayTimezone(config: AppConfig, event: Pick<EventRecord, "createdByUserId" | "timeSemantics">): string {
  if (event.timeSemantics === "local") {
    const timezone = getUserTimezone(event.createdByUserId);
    if (timezone) return timezone;
  }
  return config.bot.defaultTimezone;
}

export function getCurrentOccurrence(event: EventRecord, now = new Date(), timezoneOverride?: string): EventOccurrence | null {
  const existing = event.deliveryState?.currentOccurrence?.scheduledAt;
  if (existing) return { scheduledAt: existing };
  const scheduledAt = event.timeSemantics === "local"
    ? nextLocalEventOccurrence(event, now, timezoneOverride)
    : nextEventOccurrence(event.schedule, now);
  return scheduledAt ? { scheduledAt } : null;
}

export function listReminderInstances(event: EventRecord, occurrence: EventOccurrence): ReminderInstance[] {
  const enabled = event.reminders.filter((item) => item.enabled);
  if (enabled.length === 0 && event.category === "automation") {
    return [{
      reminderId: "automation-run",
      offsetMinutes: 0,
      notifyAt: occurrence.scheduledAt,
    }];
  }
  return enabled
    .map((reminder) => ({
      reminderId: reminder.id,
      offsetMinutes: reminder.offsetMinutes,
      notifyAt: new Date(new Date(occurrence.scheduledAt).getTime() + reminder.offsetMinutes * MS_PER_MINUTE).toISOString(),
      label: reminder.label,
    }))
    .sort((a, b) => a.notifyAt.localeCompare(b.notifyAt));
}

export function allRemindersSent(event: EventRecord): boolean {
  const current = event.deliveryState?.currentOccurrence;
  if (!current) return false;
  const enabledIds = event.reminders.filter((item) => item.enabled).map((item) => item.id).sort();
  const effectiveIds = enabledIds.length === 0 && event.category === "automation"
    ? ["automation-run"]
    : enabledIds;
  const sentIds = Array.from(new Set(current.sentReminderIds)).sort();
  return effectiveIds.length > 0 && effectiveIds.every((id, index) => sentIds[index] === id);
}

function scheduleTimeLabel(schedule: EventSchedule, timezone?: string): string {
  const time = eventTime(schedule, timezone);
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

export function scheduleEventScheduleSummary(config: AppConfig, event: EventRecord, _locale?: Locale): string {
  const schedule = event.schedule;
  const displayTimezone = resolveScheduleDisplayTimezone(config, event);
  if (schedule.kind === "once") {
    return formatDisplayDateTime(config, schedule.scheduledAt, displayTimezone);
  }
  if (schedule.kind === "interval") {
    return `interval/${schedule.unit}/${schedule.every} @ ${scheduleTimeLabel(schedule, displayTimezone)}`;
  }
  if (schedule.kind === "weekly") {
    return `weekly/${schedule.every} [${schedule.daysOfWeek.join(",")}] @ ${scheduleTimeLabel(schedule, displayTimezone)}`;
  }
  if (schedule.kind === "monthly") {
    if (schedule.mode === "dayOfMonth") {
      return `monthly/${schedule.every} day ${schedule.dayOfMonth} @ ${scheduleTimeLabel(schedule, displayTimezone)}`;
    }
    return `monthly/${schedule.every} week ${schedule.weekOfMonth} day ${schedule.dayOfWeek} @ ${scheduleTimeLabel(schedule, displayTimezone)}`;
  }
  if (schedule.kind === "yearly") {
    return `yearly/${schedule.every} ${schedule.month}/${schedule.day} @ ${scheduleTimeLabel(schedule, displayTimezone)}`;
  }
  return `lunar-yearly ${lunarMonthLabel(schedule.month, schedule.isLeapMonth)}${lunarDayLabel(schedule.day)} @ ${scheduleTimeLabel(schedule, displayTimezone)}`;
}

function reminderLabel(_config: AppConfig, instance: ReminderInstance, _locale?: Locale): string {
  if (instance.label) return instance.label;
  if (instance.offsetMinutes === 0) return "0m";
  const abs = Math.abs(instance.offsetMinutes);
  if (abs % 1440 === 0) return `${abs / 1440}d`;
  if (abs % 60 === 0) return `${abs / 60}h`;
  return `${abs}m`;
}

export function formatEventRecord(config: AppConfig, event: EventRecord, locale?: Locale): string {
  const displayTimezone = resolveScheduleDisplayTimezone(config, event);
  const occurrence = getCurrentOccurrence(event, new Date(), displayTimezone);
  const when = occurrence
    ? formatDisplayDateTime(config, occurrence.scheduledAt, displayTimezone).slice(0, 16)
    : scheduleEventScheduleSummary(config, event, locale);
  const reminders = occurrence
    ? listReminderInstances(event, occurrence).map((item) => reminderLabel(config, item, locale)).join("、")
    : event.reminders.map((item) => item.label || String(item.offsetMinutes)).join("、");
  return `${when} ${event.title}${reminders ? ` [${reminders}]` : ""}`;
}

