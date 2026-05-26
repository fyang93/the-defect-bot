import type { Bot, Context } from "grammy";
import type { AppConfig } from "bot/app/types";
import { logger } from "bot/app/logger";
import { userLocale, type Locale } from "bot/app/i18n";
import { getAccurateNow } from "bot/app/time";
import { sendMessageFormatted } from "bot/telegram/format";
import { listAuthorizedUserIds } from "bot/operations/access/roles";
import type { EventRecord, ReminderInstance } from "./types";
import { isPreparedScheduleDeliveryTextUsable } from "./preparation";
import { allRemindersSent, getCurrentOccurrence, listReminderInstances } from "./schedule";
import { readEventRecords, writeEventRecords } from "./store";

function fallbackDeliveryMessage(_config: AppConfig, event: EventRecord, _instance: ReminderInstance, _locale: Locale): string {
  return event.title.trim();
}

function markReminderSent(event: EventRecord, reminderId: string): void {
  const current = event.deliveryState?.currentOccurrence;
  if (!current) return;
  if (!current.sentReminderIds.includes(reminderId)) {
    current.sentReminderIds.push(reminderId);
  }
}

function ensureOccurrenceState(event: EventRecord, now: Date): EventRecord | null {
  if (event.status !== "active") return null;
  const occurrence = getCurrentOccurrence(event, now);
  if (!occurrence) return null;
  if (!event.deliveryState?.currentOccurrence || event.deliveryState.currentOccurrence.scheduledAt !== occurrence.scheduledAt) {
    event.deliveryState = {
      currentOccurrence: {
        scheduledAt: occurrence.scheduledAt,
        sentReminderIds: [],
      },
    };
  }
  return event;
}

function advanceOccurrence(event: EventRecord, now: Date): void {
  if (event.schedule.kind === "once") {
    event.status = "paused";
    event.updatedAt = now.toISOString();
    return;
  }
  const nextReference = new Date(new Date(event.deliveryState?.currentOccurrence?.scheduledAt || now.toISOString()).getTime() + 1000);
  const nextOccurrence = getCurrentOccurrence({ ...event, deliveryState: undefined }, nextReference);
  if (!nextOccurrence) {
    event.status = "paused";
    event.updatedAt = now.toISOString();
    return;
  }
  event.deliveryState = {
    currentOccurrence: {
      scheduledAt: nextOccurrence.scheduledAt,
      sentReminderIds: [],
    },
  };
  event.updatedAt = now.toISOString();
}

function scheduleTargets(config: AppConfig, event: EventRecord): number[] {
  const targets = event.targets
    .map((item) => item.targetId)
    .filter((item) => Number.isInteger(item));
  return targets.length > 0 ? Array.from(new Set(targets)) : listAuthorizedUserIds(config);
}

export async function deliverDueSchedules(
  config: AppConfig,
  bot: Bot<Context>,
  renderMessage?: (event: EventRecord, instance: ReminderInstance, fallback: string) => Promise<string>,
  afterDelivery?: (event: EventRecord, instance: ReminderInstance) => Promise<void>,
): Promise<number> {
  const events = await readEventRecords(config);
  const now = await getAccurateNow();
  let sent = 0;
  let changed = false;

  for (const event of events) {
    if (event.status !== "active") continue;
    const activeEvent = ensureOccurrenceState(event, now);
    if (!activeEvent?.deliveryState?.currentOccurrence) continue;

    const instances = listReminderInstances(activeEvent, { scheduledAt: activeEvent.deliveryState.currentOccurrence.scheduledAt });
    const dueInstances = instances.filter((instance) => {
      const alreadySent = activeEvent.deliveryState?.currentOccurrence?.sentReminderIds.includes(instance.reminderId) || false;
      return !alreadySent && Date.parse(instance.notifyAt) <= now.getTime();
    });

    for (const instance of dueInstances) {
      const preparedMessage = activeEvent.category === "automation"
        ? undefined
        : isPreparedScheduleDeliveryTextUsable(activeEvent, instance) ? activeEvent.deliveryText : undefined;
      const targets = scheduleTargets(config, activeEvent);
      let delivered = false;
      for (const targetId of targets) {
        const locale = targetId > 0 ? userLocale(config, targetId) : config.bot.language;
        const fallbackMessage = fallbackDeliveryMessage(config, activeEvent, instance, locale);
        let deliveryMessage = preparedMessage || fallbackMessage;
        if (!preparedMessage && renderMessage) {
          try {
            deliveryMessage = await renderMessage(activeEvent, instance, fallbackMessage);
          } catch (error) {
            await logger.warn(`schedule render fallback event=${activeEvent.id} reminder=${instance.reminderId} error=${error instanceof Error ? error.message : String(error)}`);
            deliveryMessage = fallbackMessage;
          }
        }
        try {
          await logger.info(`schedule delivery attempt event=${activeEvent.id} title=${JSON.stringify(activeEvent.title)} target=${targetId} reminder=${instance.reminderId} notifyAt=${instance.notifyAt} chars=${deliveryMessage.length}`);
          await sendMessageFormatted(bot, targetId, deliveryMessage);
          await logger.info(`schedule delivery sent event=${activeEvent.id} title=${JSON.stringify(activeEvent.title)} target=${targetId} reminder=${instance.reminderId}`);
          delivered = true;
        } catch (error) {
          await logger.warn(`failed to deliver schedule ${activeEvent.id} to target=${targetId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!delivered) continue;
      markReminderSent(activeEvent, instance.reminderId);
      activeEvent.updatedAt = now.toISOString();
      activeEvent.deliveryText = undefined;
      activeEvent.deliveryTextGeneratedAt = undefined;
      activeEvent.deliveryPreparedReminderId = undefined;
      activeEvent.deliveryPreparedNotifyAt = undefined;
      if (afterDelivery) await afterDelivery(activeEvent, instance);
      sent += 1;
      changed = true;
    }

    if (allRemindersSent(activeEvent)) {
      advanceOccurrence(activeEvent, now);
      changed = true;
    }
  }

  if (changed) await writeEventRecords(config, events);
  return sent;
}

