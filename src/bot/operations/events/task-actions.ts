import { formatIsoInTimezoneLocalString } from "bot/app/time";
import type { AppConfig } from "bot/app/types";
import { buildEventScheduleFromExternal } from "./schedule_parser";
import { buildScheduledTaskPrompt } from "./automation";
import { createEventRecordWithDefaults, deleteEventRecord, getCurrentOccurrence, readEventRecords, resolveScheduleDisplayTimezone, resolveScheduleTimezone, updateEventRecord } from ".";
import type { EventRecord, Reminder, EventTarget } from ".";

export type TaskRecord = {
  id: string;
  state: "queued" | "running" | "blocked" | "done" | "failed" | "cancelled" | "superseded";
  domain: string;
  operation: string;
  subject?: {
    kind?: string;
    id?: string;
    scope?: Record<string, string | number | boolean>;
  };
  payload: Record<string, unknown>;
  source?: {
    requesterUserId?: string;
    chatId?: string;
    messageId?: string;
  };
  createdAt: string;
  updatedAt: string;
};

function normalizeDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function extractScheduledDate(event: EventRecord): string | undefined {
  if (event.schedule.kind !== "once") return undefined;
  return event.schedule.scheduledAt.slice(0, 10);
}

function extractLocalScheduledDate(event: EventRecord, fallbackTimezone: string): string | undefined {
  const local = extractLocalScheduledAt(event, fallbackTimezone);
  return local ? local.slice(0, 10) : undefined;
}

function extractScheduledAt(event: EventRecord): string | undefined {
  if (event.schedule.kind !== "once") return undefined;
  return event.schedule.scheduledAt;
}

function extractLocalScheduledAt(event: EventRecord, fallbackTimezone: string): string | undefined {
  if (event.schedule.kind !== "once") return undefined;
  const timezone = event.timeSemantics === "local"
    ? resolveScheduleDisplayTimezone({ bot: { defaultTimezone: fallbackTimezone } } as AppConfig, event)
    : fallbackTimezone;
  return formatIsoInTimezoneLocalString(event.schedule.scheduledAt, timezone);
}

function normalizeEventTargets(raw: unknown): EventTarget[] {
  return Array.isArray(raw)
    ? raw.filter((target): target is EventTarget => Boolean(target) && typeof target === "object" && ((target as EventTarget).targetKind === "user" || (target as EventTarget).targetKind === "chat") && typeof (target as EventTarget).targetId === "string" && Boolean((target as EventTarget).targetId))
    : [];
}

function scheduleTargetsFromPayload(task: TaskRecord): EventTarget[] {
  const payloadTargets = normalizeEventTargets(task.payload.targets);
  if (payloadTargets.length > 0) return payloadTargets;
  if (task.source?.requesterUserId) return [{ targetKind: "user", targetId: task.source.requesterUserId }];
  if (task.source?.chatId) return [{ targetKind: "chat", targetId: task.source.chatId }];
  return [];
}

function scheduleTargetsFromUpdateChanges(changes: Record<string, unknown>): EventTarget[] | undefined {
  const explicitTargets = normalizeEventTargets(changes.targets);
  if (explicitTargets.length > 0) return explicitTargets;
  const targetUserId = typeof changes.targetUserId === "string" && changes.targetUserId ? changes.targetUserId : undefined;
  if (targetUserId) {
    return [{ targetKind: "user", targetId: targetUserId }];
  }
  const targetChatId = typeof changes.targetChatId === "string" && changes.targetChatId ? changes.targetChatId : undefined;
  if (targetChatId) {
    return [{ targetKind: "chat", targetId: targetChatId }];
  }
  return undefined;
}

function titleMatches(event: EventRecord, match: Record<string, unknown>): boolean {
  const title = event.title.trim().toLowerCase();
  const exact = typeof match.title === "string" && match.title.trim() ? match.title.trim().toLowerCase() : "";
  const contains = typeof match.titleContains === "string" && match.titleContains.trim() ? match.titleContains.trim().toLowerCase() : "";
  if (exact && title !== exact) return false;
  if (contains && !title.includes(contains)) return false;
  return true;
}

function idMatches(event: EventRecord, match: Record<string, unknown>): boolean {
  const rawId = match.id ?? match.eventId;
  const id = typeof rawId === "string" && rawId.trim() ? rawId.trim() : "";
  if (id && event.id !== id) return false;
  return true;
}

function explicitEventIds(match: Record<string, unknown>): string[] {
  const raw = Array.isArray(match.ids)
    ? match.ids
    : [];
  return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

export function eventMatchesFilters(event: EventRecord, match: Record<string, unknown>, defaultTimezone: string): boolean {
  if (!idMatches(event, match)) return false;
  if (!titleMatches(event, match)) return false;
  const scheduledDate = typeof match.scheduledDate === "string" && match.scheduledDate.trim() ? match.scheduledDate.trim() : undefined;
  if (scheduledDate && extractScheduledDate(event) !== scheduledDate && extractLocalScheduledDate(event, defaultTimezone) !== scheduledDate) return false;
  const scheduledAt = typeof match.scheduledAt === "string" && match.scheduledAt.trim() ? match.scheduledAt.trim() : undefined;
  if (scheduledAt) {
    const normalizedScheduledAt = scheduledAt.replace(/\.000Z$/, "").replace(/Z$/, "");
    const eventScheduledAt = extractScheduledAt(event)?.replace(/\.000Z$/, "").replace(/Z$/, "");
    const localScheduledAt = extractLocalScheduledAt(event, defaultTimezone);
    if (eventScheduledAt !== normalizedScheduledAt && localScheduledAt !== normalizedScheduledAt) return false;
  }
  if (match.timeframe === "tomorrow") {
    const timezone = resolveScheduleDisplayTimezone({ bot: { defaultTimezone } } as AppConfig, event);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    if (extractScheduledDate(event) !== normalizeDateKey(tomorrow, timezone)) return false;
  }
  return true;
}

export async function resolveEventsByMatch(
  config: AppConfig,
  input: {
    match?: Record<string, unknown>;
    requesterUserId?: string;
    allowedStatuses?: EventRecord["status"][];
  },
): Promise<{ mode: "single" | "batch"; events: EventRecord[]; reason?: string }> {
  const match = input.match && typeof input.match === "object" && !Array.isArray(input.match)
    ? input.match
    : {};
  const allowedStatuses = input.allowedStatuses || ["active"];
  const allEvents = (await readEventRecords(config)).filter((event) => allowedStatuses.includes(event.status));
  const matchedEvents = allEvents.filter((event) => eventMatchesFilters(event, match, config.bot.defaultTimezone));

  const batchIds = explicitEventIds(match);
  if (batchIds.length > 0) {
    const byId = new Map(allEvents.map((event) => [event.id, event]));
    const resolved = batchIds.map((id) => byId.get(id)).filter((event): event is EventRecord => Boolean(event));
    if (resolved.length !== batchIds.length) return { mode: "batch", events: [], reason: "schedule-batch-not-resolved" };
    return { mode: "batch", events: resolved };
  }

  if (matchedEvents.length === 1) return { mode: "single", events: [matchedEvents[0]] };
  if (matchedEvents.length > 1) return { mode: "single", events: matchedEvents, reason: "schedule-ambiguous" };
  return { mode: "single", events: [], reason: "schedule-not-resolved" };
}

async function resolveEventsForMutation(
  config: AppConfig,
  task: TaskRecord,
  allowedStatuses: EventRecord["status"][] = ["active"],
): Promise<{ mode: "single" | "batch"; events: EventRecord[]; reason?: string }> {
  const payload = task.payload;
  const match = payload.match && typeof payload.match === "object" && !Array.isArray(payload.match)
    ? payload.match as Record<string, unknown>
    : {};
  const supportedKeys = new Set(["id", "eventId", "ids", "title", "titleContains", "scheduledDate", "scheduledAt", "timeframe"]);
  if (Object.keys(match).length === 0 || Object.keys(match).some((key) => !supportedKeys.has(key))) {
    return { mode: "single", events: [], reason: "invalid-schedule-match" };
  }
  const resolved = await resolveEventsByMatch(config, {
    match,
    requesterUserId: task.source?.requesterUserId,
    allowedStatuses,
  });
  if (resolved.mode === "single" && resolved.events.length !== 1) return { ...resolved, events: [] };
  return resolved;
}

export async function runEventTask(config: AppConfig, task: TaskRecord): Promise<{ changed?: boolean; eventId?: string; eventIds?: string[]; skipped?: boolean; reason?: string }> {
  if (task.operation === "create") {
    const payload = task.payload;
    const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "";
    const schedule = payload.schedule && typeof payload.schedule === "object" && !Array.isArray(payload.schedule)
      ? payload.schedule as Record<string, unknown>
      : null;
    const targets = scheduleTargetsFromPayload(task);
    const reminders = Array.isArray(payload.reminders)
      ? payload.reminders.filter((item): item is Reminder => Boolean(item) && typeof item === "object" && typeof (item as Reminder).id === "string" && Number.isInteger((item as Reminder).offsetMinutes))
      : undefined;
    if (!title || !schedule || targets.length === 0) return { skipped: true, reason: "invalid-create-payload" };
    const specialKind = payload.specialKind === "birthday" || payload.specialKind === "festival" || payload.specialKind === "anniversary" || payload.specialKind === "memorial"
      ? payload.specialKind
      : undefined;
    const category = payload.category === "automation"
      ? "automation"
        : payload.category === "special" || specialKind
          ? "special"
          : payload.category === "routine"
            ? "routine"
            : undefined;
    const resolvedTimezone = typeof payload.timezone === "string" && payload.timezone.trim()
      ? payload.timezone.trim()
      : resolveScheduleTimezone(config, { userId: task.source?.requesterUserId, recipientUserId: task.source?.requesterUserId, timeSemantics: payload.timeSemantics === "absolute" || payload.timeSemantics === "local" ? payload.timeSemantics : undefined });
    const effectiveReminders = category === "automation" ? [] : reminders;
    const event = await createEventRecordWithDefaults(config, {
      title,
      note: typeof payload.note === "string" ? payload.note.trim() || undefined : undefined,
      schedule: buildEventScheduleFromExternal(schedule, resolvedTimezone),
      category,
      specialKind,
      timeSemantics: payload.timeSemantics === "absolute" || payload.timeSemantics === "local" ? payload.timeSemantics : undefined,
      createdByUserId: task.source?.requesterUserId,
      reminders: effectiveReminders,
      targets,
    });
    return { changed: true, eventId: event.id };
  }

  if (task.operation === "upsert") {
    const payload = task.payload;
    const hasMatch = Boolean(payload.match && typeof payload.match === "object" && !Array.isArray(payload.match));
    const hasChanges = Boolean(payload.changes && typeof payload.changes === "object" && !Array.isArray(payload.changes));
    if (hasMatch || hasChanges) {
      return runEventTask(config, { ...task, operation: "update" });
    }
    return runEventTask(config, { ...task, operation: "create" });
  }

  if (task.operation === "update") {
    const resolved = await resolveEventsForMutation(config, task);
    if (resolved.events.length === 0) return { skipped: true, reason: resolved.reason || "schedule-not-resolved" };
    const changes = task.payload.changes && typeof task.payload.changes === "object" && !Array.isArray(task.payload.changes)
      ? task.payload.changes as Record<string, unknown>
      : {};

    const changedIds: string[] = [];
    for (const event of resolved.events) {
      if (typeof changes.title === "string" && changes.title.trim()) event.title = changes.title.trim();
      if (typeof changes.note === "string") event.note = changes.note.trim() || undefined;

      const nextTimeSemantics = changes.timeSemantics === "absolute" || changes.timeSemantics === "local" ? changes.timeSemantics : undefined;
      const timeSemanticsChanged = Boolean(nextTimeSemantics);
      if (nextTimeSemantics) event.timeSemantics = nextTimeSemantics;

      const nextCategory = changes.category === "routine" || changes.category === "special" || changes.category === "automation"
        ? changes.category
        : undefined;
      if (nextCategory) event.category = nextCategory;

      const nextSpecialKind = changes.specialKind === "birthday" || changes.specialKind === "festival" || changes.specialKind === "anniversary" || changes.specialKind === "memorial"
        ? changes.specialKind
        : undefined;
      if (nextSpecialKind) event.specialKind = nextSpecialKind;
      else if (changes.specialKind === null) event.specialKind = undefined;

      const remindersChanged = Array.isArray(changes.reminders);
      if (remindersChanged) {
        const reminderItems = changes.reminders as unknown[];
        event.reminders = reminderItems.filter((item: unknown): item is Reminder => Boolean(item) && typeof item === "object" && typeof (item as Reminder).id === "string" && Number.isInteger((item as Reminder).offsetMinutes));
      }

      if (event.specialKind && event.category !== "special") {
        event.category = "special";
      }

      if (event.category === "automation") {
        event.reminders = [];
      }

      const updatedTargets = scheduleTargetsFromUpdateChanges(changes);
      if (updatedTargets && updatedTargets.length > 0) {
        event.targets = updatedTargets;
      }

      const scheduleChanged = Boolean(changes.schedule && typeof changes.schedule === "object" && !Array.isArray(changes.schedule));
      if (scheduleChanged) {
        const resolvedTimezone = resolveScheduleTimezone(config, { userId: event.createdByUserId || task.source?.requesterUserId });
        event.schedule = buildEventScheduleFromExternal(changes.schedule as Record<string, unknown>, resolvedTimezone);
      }

      const shouldRefreshDeliveryState = scheduleChanged || timeSemanticsChanged || remindersChanged;
      if (shouldRefreshDeliveryState) {
        event.deliveryState = undefined;
        event.deliveryText = undefined;
        event.deliveryTextGeneratedAt = undefined;
        event.deliveryPreparedReminderId = undefined;
        event.deliveryPreparedNotifyAt = undefined;
        if (event.status === "active") {
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
      }
      if (event.category === "automation") {
        event.note = buildScheduledTaskPrompt(event.title, event.note);
      }
      event.updatedAt = new Date().toISOString();
      await updateEventRecord(config, event);
      changedIds.push(event.id);
    }
    return { changed: true, eventId: changedIds[0], eventIds: changedIds };
  }

  if (task.operation === "delete") {
    const resolved = await resolveEventsForMutation(config, task, ["active"]);
    if (resolved.events.length === 0) return { skipped: true, reason: resolved.reason || "schedule-not-resolved" };
    const changedIds: string[] = [];
    for (const event of resolved.events) {
      const changed = await deleteEventRecord(config, event.id);
      if (changed) changedIds.push(event.id);
    }
    return { changed: changedIds.length > 0, eventId: changedIds[0], eventIds: changedIds };
  }

  if (task.operation === "pause") {
    const resolved = await resolveEventsForMutation(config, task, ["active"]);
    if (resolved.events.length === 0) return { skipped: true, reason: resolved.reason || "schedule-not-resolved" };
    const changedIds: string[] = [];
    for (const event of resolved.events) {
      event.status = "paused";
      event.updatedAt = new Date().toISOString();
      event.deliveryText = undefined;
      event.deliveryTextGeneratedAt = undefined;
      event.deliveryPreparedReminderId = undefined;
      event.deliveryPreparedNotifyAt = undefined;
      await updateEventRecord(config, event);
      changedIds.push(event.id);
    }
    return { changed: true, eventId: changedIds[0], eventIds: changedIds };
  }

  if (task.operation === "resume") {
    const resolved = await resolveEventsForMutation(config, task, ["paused"]);
    if (resolved.events.length === 0) return { skipped: true, reason: resolved.reason || "schedule-not-resolved" };
    const changedIds: string[] = [];
    for (const event of resolved.events) {
      event.status = "active";
      event.updatedAt = new Date().toISOString();
      event.deliveryText = undefined;
      event.deliveryTextGeneratedAt = undefined;
      event.deliveryPreparedReminderId = undefined;
      event.deliveryPreparedNotifyAt = undefined;
      event.deliveryState = undefined;
      await updateEventRecord(config, event);
      changedIds.push(event.id);
    }
    return { changed: true, eventId: changedIds[0], eventIds: changedIds };
  }

  return { skipped: true, reason: "unsupported-schedule-operation" };
}
