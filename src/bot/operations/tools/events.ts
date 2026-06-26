import { formatIsoInTimezoneLocalString } from "bot/app/time";
import { logger } from "bot/app/logger";
import { canManageAllSchedules, canManageOwnSchedules, canReadSchedules, canRequesterCreateEventTargets } from "bot/operations/access/control";
import { accessLevelForUser } from "bot/operations/access/roles";
import { resolveUser } from "bot/operations/context/store";
import { getCurrentOccurrence, listReminderInstances, resolveScheduleDisplayTimezone, resolveEventsByMatch, scheduleEventScheduleSummary, eventMatchesFilters, type EventRecord } from "bot/operations/events";
import { buildEventScheduleFromExternal } from "bot/operations/events/schedule_parser";
import { createEventRecordWithDefaults, readEventRecords } from "bot/operations/events/store";
import type { Reminder } from "bot/operations/events/types";
import type { ToolContext } from "bot/operations/tools/runtime";

function requesterTimezoneForTool(context: ToolContext): string | undefined {
  const requesterUserId = context.asInt(context.args.requesterUserId);
  if (!requesterUserId) return context.config.bot.defaultTimezone;
  return resolveUser(context.config.paths.repoRoot, requesterUserId, { defaultTimezone: context.config.bot.defaultTimezone })?.timezone?.trim() || context.config.bot.defaultTimezone;
}

function effectiveRequesterTimezoneForTool(context: ToolContext): string {
  return requesterTimezoneForTool(context) || context.config.bot.defaultTimezone;
}

function localScheduledAt(event: EventRecord, timezone: string): string | undefined {
  if (event.schedule.kind !== "once") return undefined;
  return formatIsoInTimezoneLocalString(event.schedule.scheduledAt, timezone);
}

function parseRemindersArg(raw: unknown): Reminder[] | undefined {
  const parsed = Array.isArray(raw)
    ? raw
    : typeof raw === "string" && raw.trim()
      ? (() => {
          try {
            const value = JSON.parse(raw);
            return Array.isArray(value) ? value : undefined;
          } catch {
            return undefined;
          }
        })()
      : undefined;
  if (!parsed) return undefined;

  const reminders = parsed.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const offsetMinutes = Number(record.offsetMinutes);
    if (!Number.isInteger(offsetMinutes)) return [];
    return [{
      id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : `n${index + 1}`,
      offsetMinutes,
      enabled: record.enabled !== false,
      label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : undefined,
    } satisfies Reminder];
  });

  return reminders.length > 0 ? reminders : undefined;
}

function serializeEventForTool(context: ToolContext, event: EventRecord): Record<string, unknown> {
  const displayTimezone = resolveScheduleDisplayTimezone(context.config, event);
  const requesterTimezone = requesterTimezoneForTool(context);
  const effectiveRequesterTimezone = effectiveRequesterTimezoneForTool(context);
  const occurrence = getCurrentOccurrence(event);
  const reminders = occurrence ? listReminderInstances(event, occurrence) : [];
  return {
    ...event,
    scheduleSummary: scheduleEventScheduleSummary(context.config, event),
    displayTimezone,
    requesterTimezone: requesterTimezone || null,
    effectiveRequesterTimezone,
    scheduledAtDisplayLocal: localScheduledAt(event, displayTimezone),
    scheduledAtRequesterLocal: localScheduledAt(event, effectiveRequesterTimezone),
    currentOccurrence: occurrence ? {
      scheduledAt: occurrence.scheduledAt,
      scheduledAtDisplayLocal: formatIsoInTimezoneLocalString(occurrence.scheduledAt, displayTimezone),
      scheduledAtRequesterLocal: formatIsoInTimezoneLocalString(occurrence.scheduledAt, effectiveRequesterTimezone),
    } : null,
    remindersDetailed: reminders.map((reminder) => ({
      reminderId: reminder.reminderId,
      label: reminder.label,
      offsetMinutes: reminder.offsetMinutes,
      notifyAt: reminder.notifyAt,
      notifyAtDisplayLocal: formatIsoInTimezoneLocalString(reminder.notifyAt, displayTimezone),
      notifyAtRequesterLocal: formatIsoInTimezoneLocalString(reminder.notifyAt, effectiveRequesterTimezone),
    })),
  };
}

export async function handleEventsList(context: ToolContext): Promise<void> {
  const requesterUserId = context.asInt(context.args.requesterUserId);
  const accessLevel = accessLevelForUser(context.config, requesterUserId);
  context.logInfo(`event_list: loading visible events for requester ${requesterUserId ?? "unknown"}`);
  if (!canReadSchedules(accessLevel)) context.output({ ok: false, error: "schedule-read-not-allowed" });
  const events = (await readEventRecords(context.config)).filter((event) => event.status !== "deleted");
  const visible = canManageAllSchedules(accessLevel)
    ? events
    : events.filter((event) => canManageOwnSchedules(accessLevel) && event.createdByUserId === requesterUserId);
  const match = context.parseObjectArg(context.args.match) || {};
  const filtered = Object.keys(match).length > 0
    ? visible.filter((event) => eventMatchesFilters(event, match, effectiveRequesterTimezoneForTool(context)))
    : visible;
  context.output({ ok: true, events: filtered.map((event) => serializeEventForTool(context, event)) });
}

export async function handleEventsGet(context: ToolContext): Promise<void> {
  const eventId = context.cleanText(context.args.eventId);
  const requesterUserId = context.asInt(context.args.requesterUserId);
  const accessLevel = accessLevelForUser(context.config, requesterUserId);
  context.logInfo(`event_get: resolving event${eventId ? ` ${eventId}` : " by match"}`);
  if (!canReadSchedules(accessLevel)) context.output({ ok: false, error: "schedule-read-not-allowed" });
  if (eventId) {
    const events = await readEventRecords(context.config);
    const event = events.find((item) => item.id === eventId) || null;
    if (!event) {
      context.output({ ok: false, error: "event-not-resolved", event: null });
    }
    if (!canManageAllSchedules(accessLevel) && event.createdByUserId !== requesterUserId) {
      context.output({ ok: false, error: "event-read-not-allowed" });
    }
    context.output({ ok: true, event: serializeEventForTool(context, event) });
  }

  const match = context.parseObjectArg(context.args.match) || {};
  const result = await resolveEventsByMatch(context.config, {
    match,
    requesterUserId,
    allowedStatuses: ["active", "paused"],
  });
  if (result.events.length !== 1) {
    context.output({
      ok: false,
      error: result.reason || "event-not-resolved",
      events: result.events.map((event) => serializeEventForTool(context, event)),
    });
  }
  context.output({ ok: true, event: serializeEventForTool(context, result.events[0]) });
}

export async function handleEventsCreate(context: ToolContext): Promise<void> {
  const { args, cleanText, asInt, parseObjectArg, output, logTextContent } = context;
  const title = cleanText(args.title);
  const note = cleanText(args.note);
  const requesterUserId = asInt(args.requesterUserId);
  const targetUserId = asInt(args.targetUserId) || requesterUserId;
  const targetChatId = asInt(args.targetChatId);
  const schedule = parseObjectArg(args.schedule);
  context.logInfo(`event_create: creating ${title || "untitled event"}`);
  await logger.info(`system tool schedules_create request hasTitle=${title ? "yes" : "no"} hasSchedule=${schedule ? "yes" : "no"} scheduleKind=${typeof schedule?.kind === "string" ? schedule.kind : typeof schedule?.datetime === "string" ? "datetime" : "unknown"} targetUserId=${targetUserId ?? "unknown"} targetChatId=${targetChatId ?? "unknown"} note=${note ? logTextContent(note) : '""'}`);
  if (!title || !schedule || (!targetUserId && targetChatId == null)) output({ ok: false, error: "missing-title-schedule-or-target", details: { hasTitle: Boolean(title), hasSchedule: Boolean(schedule), hasTarget: Boolean(targetUserId || targetChatId != null) } });

  const targets = targetChatId != null ? [{ targetKind: "chat" as const, targetId: targetChatId }] : [{ targetKind: "user" as const, targetId: targetUserId! }];
  if (!canRequesterCreateEventTargets(context.config, requesterUserId, targets)) {
    output({ ok: false, error: "schedule-create-not-allowed" });
  }

  const timezone = cleanText(args.timezone) || context.config.bot.defaultTimezone;
  const category = cleanText(args.category);
  const rawSpecialKind = cleanText(args.specialKind);
  const rawTimeSemantics = cleanText(args.timeSemantics);
  const parsedReminders = parseRemindersArg(args.reminders);
  const normalizedCategory = category === "automation"
    ? "automation"
    : category === "special"
      ? "special"
      : category === "routine"
        ? "routine"
        : undefined;
  const normalizedSpecialKind = rawSpecialKind === "birthday" || rawSpecialKind === "festival" || rawSpecialKind === "anniversary" || rawSpecialKind === "memorial"
    ? rawSpecialKind as "birthday" | "festival" | "anniversary" | "memorial"
    : undefined;
  const reminders = normalizedCategory === "automation" ? [] : parsedReminders;

  const event = await createEventRecordWithDefaults(context.config, {
    title: title as string,
    note,
    schedule: buildEventScheduleFromExternal(schedule as Record<string, unknown>, timezone),
    category: normalizedCategory,
    createdByUserId: requesterUserId,
    timeSemantics: rawTimeSemantics === "absolute" || rawTimeSemantics === "local" ? rawTimeSemantics : undefined,
    specialKind: normalizedSpecialKind,
    reminders,
    targets,
  });
  await logger.info(`system tool events_create created eventId=${event.id} title=${logTextContent(event.title)}`);
  output({ ok: true, changed: true, eventId: event.id, event: serializeEventForTool(context, event) });
}

export async function handleEventMutation(context: ToolContext, operation: "update" | "delete" | "pause" | "resume"): Promise<void> {
  const requesterUserId = context.asInt(context.args.requesterUserId);
  const match = context.parseObjectArg(context.args.match) || {};
  const changes = context.parseObjectArg(context.args.changes) || {};
  context.logInfo(`event:${operation}: applying request`);
  if (operation === "update") {
    const title = context.cleanText(context.args.title);
    const note = context.cleanText(context.args.note);
    const timezone = context.cleanText(context.args.timezone);
    const timeSemantics = context.cleanText(context.args.timeSemantics);
    const category = context.cleanText(context.args.category);
    const specialKind = context.cleanText(context.args.specialKind);
    const targetUserId = context.asInt(context.args.targetUserId);
    const targetChatId = context.asInt(context.args.targetChatId);
    const schedule = context.parseObjectArg(context.args.schedule);
    const targets = context.parseObjectArg(context.args.targets)?.targets;
    if (title && changes.title == null) changes.title = title;
    if (note !== undefined && changes.note == null) changes.note = note;
    if (timezone && changes.timezone == null) changes.timezone = timezone;
    if ((timeSemantics === "absolute" || timeSemantics === "local") && changes.timeSemantics == null) changes.timeSemantics = timeSemantics;
    if ((category === "routine" || category === "special" || category === "automation") && changes.category == null) {
      changes.category = category;
    }
    if ((specialKind === "birthday" || specialKind === "festival" || specialKind === "anniversary" || specialKind === "memorial") && changes.specialKind == null) changes.specialKind = specialKind;
    if (schedule && changes.schedule == null) changes.schedule = schedule;
    if (Array.isArray(targets) && changes.targets == null) changes.targets = targets;
    if (typeof targetUserId === "number" && changes.targetUserId == null) changes.targetUserId = targetUserId;
    if (typeof targetChatId === "number" && changes.targetChatId == null) changes.targetChatId = targetChatId;
  }
  const payload = operation === "update"
    ? { match, changes }
    : { match };
  const result = await context.scheduleEngine.applyTask({
    id: `tool_${Date.now().toString(36)}`,
    state: "queued",
    domain: "events",
    operation,
    payload,
    source: requesterUserId ? { requesterUserId } : undefined,
    createdAt: context.nowIso(),
    updatedAt: context.nowIso(),
  });
  if (result.skipped) {
    context.logWarn(`event:${operation}: skipped`);
    context.output({ ok: false, error: typeof result.reason === "string" && result.reason ? result.reason : `schedule-${operation}-failed`, ...result });
  }
  const events = result.eventIds && result.eventIds.length > 0
    ? (await readEventRecords(context.config)).filter((event) => result.eventIds?.includes(event.id)).map((event) => serializeEventForTool(context, event))
    : undefined;
  const event = events && events.length > 0
    ? events.find((item) => item.id === result.eventId) || events[0]
    : undefined;
  context.output({ ok: true, ...result, event, events });
}
