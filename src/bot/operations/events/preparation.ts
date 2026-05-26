import type { AppConfig } from "bot/app/types";
import { logger } from "bot/app/logger";
import type { AiService } from "bot/ai";
import type { EventRecord, ReminderInstance } from "./types";
import { getCurrentOccurrence, listReminderInstances, resolveScheduleDisplayTimezone, scheduleEventScheduleSummary } from "./schedule";
import { scheduledTaskPromptForEvent, buildScheduledTaskPrompt } from "./automation";
import { readEventRecords, writeEventRecords } from "./store";

const PERIODIC_PREWARM_WINDOW_MS = 24 * 60 * 60 * 1000;

export { buildScheduledTaskPrompt, scheduledTaskPromptForEvent };

export function shouldGenerateScheduledTaskOnDelivery(event: EventRecord): boolean {
  return event.category === "automation";
}

export function clearPreparedScheduleDeliveryText(event: EventRecord): boolean {
  const changed = Boolean(
    event.deliveryText
    || event.deliveryTextGeneratedAt
    || event.deliveryPreparedReminderId
    || event.deliveryPreparedNotifyAt,
  );
  event.deliveryText = undefined;
  event.deliveryTextGeneratedAt = undefined;
  event.deliveryPreparedReminderId = undefined;
  event.deliveryPreparedNotifyAt = undefined;
  return changed;
}

export function isPreparedScheduleDeliveryTextUsable(event: EventRecord, instance: ReminderInstance): boolean {
  return Boolean(
    event.deliveryText
    && event.deliveryPreparedReminderId === instance.reminderId
    && event.deliveryPreparedNotifyAt === instance.notifyAt,
  );
}

export function nextPendingScheduleInstance(event: EventRecord, now = new Date()): ReminderInstance | null {
  const currentOccurrence = getCurrentOccurrence(event, now);
  if (currentOccurrence) {
    const sentIds = event.deliveryState?.currentOccurrence?.sentReminderIds || [];
    const currentNext = listReminderInstances(event, currentOccurrence).find((item) => !sentIds.includes(item.reminderId));
    if (currentNext) return currentNext;
  }
  if (event.schedule.kind === "once") return null;
  const reference = currentOccurrence ? new Date(new Date(currentOccurrence.scheduledAt).getTime() + 1000) : now;
  const nextOccurrence = getCurrentOccurrence({ ...event, deliveryState: undefined }, reference);
  if (!nextOccurrence) return null;
  return listReminderInstances({ ...event, deliveryState: undefined }, nextOccurrence)[0] || null;
}

export function shouldPrepareScheduleDeliveryText(event: EventRecord, now = new Date()): boolean {
  if (shouldGenerateScheduledTaskOnDelivery(event)) return false;
  const nextInstance = nextPendingScheduleInstance(event, now);
  if (!nextInstance) return false;
  if (event.schedule.kind === "once") return true;
  const notifyAt = Date.parse(nextInstance.notifyAt);
  return Number.isFinite(notifyAt) && notifyAt - now.getTime() <= PERIODIC_PREWARM_WINDOW_MS;
}

export async function prepareScheduleDeliveryText(config: AppConfig, agentService: AiService, event: EventRecord, now = new Date()): Promise<boolean> {
  if (shouldGenerateScheduledTaskOnDelivery(event)) {
    return clearPreparedScheduleDeliveryText(event);
  }
  const nextInstance = nextPendingScheduleInstance(event, now);
  if (!nextInstance) {
    return clearPreparedScheduleDeliveryText(event);
  }
  if (event.schedule.kind !== "once") {
    const notifyAt = Date.parse(nextInstance.notifyAt);
    if (!Number.isFinite(notifyAt) || notifyAt - now.getTime() > PERIODIC_PREWARM_WINDOW_MS) {
      return clearPreparedScheduleDeliveryText(event);
    }
  }
  if (isPreparedScheduleDeliveryTextUsable(event, nextInstance)) {
    return false;
  }
  const currentOccurrence = getCurrentOccurrence(event, now);
  const message = await agentService.generateReminderText(
    event.title,
    nextInstance.notifyAt,
    scheduleEventScheduleSummary(config, event),
    resolveScheduleDisplayTimezone(config, event),
    {
      eventScheduledAt: currentOccurrence?.scheduledAt,
      reminderLabel: nextInstance.label,
      reminderOffsetMinutes: nextInstance.offsetMinutes,
      specialKind: event.specialKind,
      category: event.category,
    },
  );
  const trimmed = message.trim();
  if (!trimmed) return false;
  event.deliveryText = trimmed;
  event.deliveryTextGeneratedAt = new Date().toISOString();
  event.deliveryPreparedReminderId = nextInstance.reminderId;
  event.deliveryPreparedNotifyAt = nextInstance.notifyAt;
  return true;
}

function schedulePreparationFingerprint(event: EventRecord): string {
  return JSON.stringify({
    title: event.title,
    note: event.note,
    category: event.category,
    specialKind: event.specialKind,
    timeSemantics: event.timeSemantics,
    createdByUserId: event.createdByUserId,
    schedule: event.schedule,
    reminders: event.reminders,
    targets: event.targets,
    status: event.status,
    currentOccurrenceScheduledAt: event.deliveryState?.currentOccurrence?.scheduledAt,
    sentReminderIds: event.deliveryState?.currentOccurrence?.sentReminderIds || [],
  });
}

export async function prepareScheduleDeliveryTextAndPersistIfUnchanged(config: AppConfig, agentService: AiService, event: EventRecord, now = new Date()): Promise<{ changed: boolean; skipped?: boolean; reason?: string }> {
  const fingerprintBefore = schedulePreparationFingerprint(event);
  const changed = await prepareScheduleDeliveryText(config, agentService, event, now);
  if (!changed) return { changed: false };

  const events = await readEventRecords(config);
  const index = events.findIndex((item) => item.id === event.id);
  if (index < 0) return { changed: false, skipped: true, reason: "missing-event-after-prepare" };
  if (schedulePreparationFingerprint(events[index]!) !== fingerprintBefore) {
    return { changed: false, skipped: true, reason: "event-changed-during-prepare" };
  }

  events[index] = {
    ...events[index]!,
    deliveryText: event.deliveryText,
    deliveryTextGeneratedAt: event.deliveryTextGeneratedAt,
    deliveryPreparedReminderId: event.deliveryPreparedReminderId,
    deliveryPreparedNotifyAt: event.deliveryPreparedNotifyAt,
  };
  await writeEventRecords(config, events);
  return { changed: true };
}

export async function prewarmScheduleDeliveryTexts(config: AppConfig, agentService: AiService): Promise<void> {
  const events = await readEventRecords(config);
  let changed = false;
  const now = new Date();
  for (const event of events) {
    if (event.status !== "active") continue;
    try {
      if (await prepareScheduleDeliveryText(config, agentService, event, now)) changed = true;
    } catch (error) {
      await logger.warn(`failed to prewarm schedule message for ${event.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (changed) {
    await writeEventRecords(config, events);
    await logger.info("prewarmed schedule delivery texts");
  }
}
