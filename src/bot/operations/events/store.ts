import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "bot/app/types";
import { getAccurateNow } from "bot/app/time";
import { getUserTimezone } from "bot/app/state";
import { buildScheduledTaskPrompt } from "./automation";
import { getCurrentOccurrence, scheduleEventScheduleSummary } from "./schedule";
import { normalizeStoredEventSchedule } from "./schedule_parser";
import type { EventRecord, Reminder, EventSchedule, ScheduleSpecialKind, EventStore, EventTarget, EventTimeSemantics } from "./types";

export type EventRecordDraft = {
  title: string;
  note?: string;
  schedule: EventSchedule;
  category?: "routine" | "special" | "automation";
  specialKind?: ScheduleSpecialKind;
  timeSemantics?: EventTimeSemantics;
  createdByUserId?: string;
  reminders?: Reminder[];
  status?: EventRecord["status"];
  createdAt?: string;
  updatedAt?: string;
  targets?: EventTarget[];
  deliveryText?: string;
  deliveryTextGeneratedAt?: string;
  deliveryPreparedReminderId?: string;
  deliveryPreparedNotifyAt?: string;
  deliveryState?: EventRecord["deliveryState"];
};

let eventStoreWriteQueue: Promise<void> = Promise.resolve();

function defaultScheduleTimezone(config: AppConfig): string {
  return config.bot.defaultTimezone;
}

export function isValidScheduleTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function resolveScheduleTimezone(
  _config: AppConfig,
  input: {
    explicitTimezone?: string;
    subjectTimezone?: string;
    messageTime?: string;
    timeSemantics?: EventTimeSemantics;
    recipientUserId?: string;
    userId?: string;
  },
): string {
  const explicitTimezone = input.explicitTimezone?.trim();
  if (explicitTimezone && isValidScheduleTimezone(explicitTimezone)) {
    return explicitTimezone;
  }

  if (input.timeSemantics === "local") {
    const subjectTimezone = input.subjectTimezone?.trim();
    if (subjectTimezone && isValidScheduleTimezone(subjectTimezone)) {
      return subjectTimezone;
    }

    const recipientTimezone = getUserTimezone(input.recipientUserId);
    if (recipientTimezone && isValidScheduleTimezone(recipientTimezone)) {
      return recipientTimezone;
    }
  }

  const rememberedTimezone = getUserTimezone(input.userId);
  if (rememberedTimezone && isValidScheduleTimezone(rememberedTimezone)) {
    return rememberedTimezone;
  }
  if (input.messageTime) {
    return defaultScheduleTimezone(_config);
  }
  return defaultScheduleTimezone(_config);
}

export function defaultEventTimeSemantics(schedule: EventSchedule): EventTimeSemantics {
  if (schedule.kind === "once") return "absolute";
  return "local";
}

export function buildDefaultReminders(_config: AppConfig, input: { category?: "routine" | "special" | "automation"; specialKind?: ScheduleSpecialKind }): Reminder[] {
  if (input.category === "automation") {
    return [];
  }
  if (input.specialKind === "birthday" || input.specialKind === "anniversary" || input.specialKind === "festival" || input.specialKind === "memorial") {
    return [
      { id: "default-2w", offsetMinutes: -14 * 24 * 60, enabled: true, label: "提前2周" },
      { id: "default-1w", offsetMinutes: -7 * 24 * 60, enabled: true, label: "提前1周" },
      { id: "default-1d", offsetMinutes: -24 * 60, enabled: true, label: "提前1天" },
      { id: "default-now", offsetMinutes: 0, enabled: true, label: "当天" },
    ];
  }
  return [{ id: "default-now", offsetMinutes: 0, enabled: true, label: "准时" }];
}

function eventsPath(config: AppConfig): string {
  return path.join(config.paths.repoRoot, "system", "events.json");
}

function normalizeTarget(raw: unknown): EventTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const targetKind = record.targetKind === "chat" ? "chat" : record.targetKind === "user" ? "user" : null;
  const targetId = typeof record.targetId === "string" || typeof record.targetId === "number" ? String(record.targetId).trim() : "";
  if (!targetKind || !targetId) return null;
  return { targetKind, targetId };
}

function normalizeReminder(raw: unknown): Reminder | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "";
  const offsetMinutes = Number(record.offsetMinutes);
  const enabled = record.enabled !== false;
  const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : undefined;
  if (!id || !Number.isInteger(offsetMinutes)) return null;
  return { id, offsetMinutes, enabled, label };
}

function normalizeEventSchedule(raw: unknown): EventSchedule | null {
  return normalizeStoredEventSchedule(raw);
}

function normalizeEvent(raw: unknown, _fallbackTimezone?: string): EventRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "";
  const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : "";
  const rawNote = typeof record.note === "string" && record.note.trim() ? record.note.trim() : undefined;
  const timeSemantics = record.timeSemantics === "absolute" || record.timeSemantics === "local" ? record.timeSemantics : undefined;
  const schedule = normalizeEventSchedule(record.schedule);
  const createdByUserId = typeof record.createdByUserId === "string" || typeof record.createdByUserId === "number"
    ? String(record.createdByUserId)
    : Array.isArray(record.targets)
      ? record.targets
          .map(normalizeTarget)
          .filter((item): item is EventTarget => Boolean(item))
          .find((item) => item.targetKind === "user")
          ?.targetId
      : undefined;
  const rawReminders = Array.isArray(record.reminders) ? record.reminders : [];
  const reminders = rawReminders.map(normalizeReminder).filter((item): item is Reminder => Boolean(item));
  const status = record.status === "active" || record.status === "paused" || record.status === "deleted" ? record.status : "active";
  const createdAt = typeof record.createdAt === "string" && record.createdAt.trim() ? record.createdAt.trim() : "";
  const updatedAt = typeof record.updatedAt === "string" && record.updatedAt.trim() ? record.updatedAt.trim() : undefined;
  const specialKind = record.specialKind === "birthday" || record.specialKind === "festival" || record.specialKind === "anniversary" || record.specialKind === "memorial"
    ? record.specialKind
    : undefined;
  const category = record.category === "automation" ? "automation" : record.category === "special" || specialKind ? "special" : "routine";
  const note = category === "automation" ? buildScheduledTaskPrompt(title, rawNote) : rawNote;
  const targets = Array.isArray(record.targets)
    ? record.targets.map(normalizeTarget).filter((item): item is EventTarget => Boolean(item))
    : [];
  const deliveryText = typeof record.deliveryText === "string" && record.deliveryText.trim() ? record.deliveryText.trim() : undefined;
  const deliveryTextGeneratedAt = typeof record.deliveryTextGeneratedAt === "string" && record.deliveryTextGeneratedAt.trim() ? record.deliveryTextGeneratedAt.trim() : undefined;
  const deliveryPreparedReminderId = typeof record.deliveryPreparedReminderId === "string" && record.deliveryPreparedReminderId.trim()
    ? record.deliveryPreparedReminderId.trim()
    : undefined;
  const deliveryPreparedNotifyAt = typeof record.deliveryPreparedNotifyAt === "string" && record.deliveryPreparedNotifyAt.trim() ? record.deliveryPreparedNotifyAt.trim() : undefined;
  const deliveryState = record.deliveryState && typeof record.deliveryState === "object"
    ? (() => {
        const state = record.deliveryState as Record<string, unknown>;
        const current = state.currentOccurrence && typeof state.currentOccurrence === "object"
          ? state.currentOccurrence as Record<string, unknown>
          : undefined;
        return current
          ? {
              currentOccurrence: {
                scheduledAt: typeof current.scheduledAt === "string" ? current.scheduledAt : "",
                sentReminderIds: Array.isArray(current.sentReminderIds)
                  ? current.sentReminderIds.filter((item): item is string => typeof item === "string")
                  : [],
              },
            }
          : undefined;
      })()
    : undefined;
  if (!id || !title || !schedule || !createdAt || targets.length === 0) return null;
  if (category !== "automation" && reminders.length === 0) return null;
  return {
    id,
    title,
    note,
    timeSemantics: timeSemantics || defaultEventTimeSemantics(schedule),
    createdByUserId,
    schedule,
    reminders,
    category,
    specialKind,
    status,
    createdAt,
    updatedAt,
    targets,
    deliveryText,
    deliveryTextGeneratedAt,
    deliveryPreparedReminderId,
    deliveryPreparedNotifyAt,
    deliveryState,
  };
}

function parseEventStore(raw: unknown, fallbackTimezone?: string): EventStore {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => normalizeEvent(item, fallbackTimezone)).filter((item): item is EventRecord => Boolean(item));
}

async function loadEventStore(config: AppConfig): Promise<EventStore> {
  try {
    const rawText = await readFile(eventsPath(config), "utf8");
    const parsed = JSON.parse(rawText) as unknown;
    return parseEventStore(parsed, defaultScheduleTimezone(config));
  } catch {
    return [];
  }
}

async function writeEventStore(config: AppConfig, store: EventStore): Promise<void> {
  const filePath = eventsPath(config);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function queueEventStoreWrite<T>(operation: () => Promise<T>): Promise<T> {
  const next = eventStoreWriteQueue.then(operation, operation);
  eventStoreWriteQueue = next.then(() => undefined, () => undefined);
  return next;
}

export async function readEventRecords(config: AppConfig): Promise<EventRecord[]> {
  return loadEventStore(config);
}

export async function writeEventRecords(config: AppConfig, events: EventRecord[]): Promise<void> {
  await queueEventStoreWrite(() => writeEventStore(config, events));
}

export function buildEventRecord(config: AppConfig, draft: EventRecordDraft): EventRecord {
  const category = draft.category === "automation" ? "automation" : draft.category === "special" || draft.specialKind ? "special" : "routine";
  const note = category === "automation" ? buildScheduledTaskPrompt(draft.title, draft.note) : draft.note;
  return {
    id: `rmd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: draft.title,
    note,
    timeSemantics: draft.timeSemantics || defaultEventTimeSemantics(draft.schedule),
    createdByUserId: draft.createdByUserId,
    schedule: draft.schedule,
    reminders: draft.reminders ? draft.reminders : buildDefaultReminders(config, { category, specialKind: draft.specialKind }),
    category,
    specialKind: draft.specialKind,
    status: draft.status || "active",
    createdAt: draft.createdAt || new Date().toISOString(),
    updatedAt: draft.updatedAt,
    targets: draft.targets && draft.targets.length > 0 ? draft.targets : [],
    deliveryText: draft.deliveryText,
    deliveryTextGeneratedAt: draft.deliveryTextGeneratedAt,
    deliveryPreparedReminderId: draft.deliveryPreparedReminderId,
    deliveryPreparedNotifyAt: draft.deliveryPreparedNotifyAt,
    deliveryState: draft.deliveryState,
  };
}

export async function createEventRecord(event: EventRecord, config: AppConfig): Promise<EventRecord> {
  await queueEventStoreWrite(async () => {
    const events = await loadEventStore(config);
    events.push(event);
    await writeEventStore(config, events);
  });
  return event;
}

export async function createEventRecordWithDefaults(config: AppConfig, draft: EventRecordDraft): Promise<EventRecord> {
  const event = buildEventRecord(config, draft);
  if (!event.deliveryState && event.status === "active") {
    const occurrence = getCurrentOccurrence(event, new Date());
    if (occurrence) {
      event.deliveryState = {
        currentOccurrence: {
          scheduledAt: occurrence.scheduledAt,
          sentReminderIds: [],
        },
      };
    }
  }
  return createEventRecord(event, config);
}

export async function getEventRecord(config: AppConfig, id: string): Promise<EventRecord | null> {
  const events = await readEventRecords(config);
  return events.find((item) => item.id === id) || null;
}

export async function updateEventRecord(config: AppConfig, event: EventRecord): Promise<void> {
  await queueEventStoreWrite(async () => {
    const events = await loadEventStore(config);
    const next = events.map((item) => (item.id === event.id ? event : item));
    await writeEventStore(config, next);
  });
}

export async function deleteEventRecord(config: AppConfig, id: string): Promise<boolean> {
  return queueEventStoreWrite(async () => {
    const events = await loadEventStore(config);
    let changed = false;
    const next = events.map((item) => {
      if (item.id === id && item.status !== "deleted") {
        changed = true;
        return { ...item, status: "deleted" as const, updatedAt: new Date().toISOString() };
      }
      return item;
    });
    if (changed) await writeEventStore(config, next);
    return changed;
  });
}

export async function pruneInactiveEventRecords(config: AppConfig): Promise<{ removed: number; removedIds: string[]; removedSummaries: string[] }> {
  return queueEventStoreWrite(async () => {
    const events = await loadEventStore(config);
    const now = await getAccurateNow();
    const removedIds: string[] = [];
    const removedSummaries: string[] = [];
    const next = events.filter((event) => {
      if (event.status === "deleted") {
        removedIds.push(event.id);
        removedSummaries.push(`${event.title}（${scheduleEventScheduleSummary(config, event)}）`);
        return false;
      }
      if (event.status === "paused" && event.schedule.kind === "once") {
        const scheduledAt = Date.parse(event.schedule.scheduledAt);
        if (Number.isFinite(scheduledAt) && scheduledAt <= now.getTime()) {
          removedIds.push(event.id);
          removedSummaries.push(`${event.title}（${scheduleEventScheduleSummary(config, event)}）`);
          return false;
        }
      }
      return true;
    });
    if (removedIds.length > 0) await writeEventStore(config, next);
    return { removed: removedIds.length, removedIds, removedSummaries };
  });
}


