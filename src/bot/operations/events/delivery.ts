import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { AppConfig } from "bot/app/types";
import { logger } from "bot/app/logger";
import { getAccurateNow } from "bot/app/time";
import { listKnownFeishuUsers } from "bot/feishu/registry";
import type { EventRecord, ReminderInstance } from "./types";
import { isPreparedScheduleDeliveryTextUsable } from "./preparation";
import { allRemindersSent, getCurrentOccurrence, listReminderInstances } from "./schedule";
import { readEventRecords, writeEventRecords } from "./store";

function ensureOccurrence(event: EventRecord, now: Date): EventRecord | null {
  if (event.status !== "active") return null;
  const occurrence = getCurrentOccurrence(event, now); if (!occurrence) return null;
  if (event.deliveryState?.currentOccurrence?.scheduledAt !== occurrence.scheduledAt) event.deliveryState = { currentOccurrence: { scheduledAt: occurrence.scheduledAt, sentReminderIds: [] } };
  return event;
}
function advance(event: EventRecord, now: Date): void {
  if (event.schedule.kind === "once") { event.status = "paused"; event.updatedAt = now.toISOString(); return; }
  const reference = new Date(Date.parse(event.deliveryState?.currentOccurrence?.scheduledAt || now.toISOString()) + 1000);
  const next = getCurrentOccurrence({ ...event, deliveryState: undefined }, reference);
  if (!next) { event.status = "paused"; event.updatedAt = now.toISOString(); return; }
  event.deliveryState = { currentOccurrence: { scheduledAt: next.scheduledAt, sentReminderIds: [] } }; event.updatedAt = now.toISOString();
}
function targets(config: AppConfig, event: EventRecord): string[] {
  const explicit = event.targets.map((target) => target.targetId).filter(Boolean);
  return explicit.length ? Array.from(new Set(explicit)) : listKnownFeishuUsers(config).map((user) => user.id);
}

export async function deliverDueSchedules(config: AppConfig, channel: LarkChannel, renderMessage?: (event: EventRecord, instance: ReminderInstance, fallback: string) => Promise<string>, afterDelivery?: (event: EventRecord, instance: ReminderInstance) => Promise<void>): Promise<number> {
  const events = await readEventRecords(config); const now = await getAccurateNow(); let sent = 0; let changed = false;
  for (const event of events) {
    const active = ensureOccurrence(event, now); if (!active?.deliveryState?.currentOccurrence) continue;
    const due = listReminderInstances(active, { scheduledAt: active.deliveryState.currentOccurrence.scheduledAt }).filter((item) => !active.deliveryState?.currentOccurrence?.sentReminderIds.includes(item.reminderId) && Date.parse(item.notifyAt) <= now.getTime());
    for (const instance of due) {
      const prepared = active.category !== "automation" && isPreparedScheduleDeliveryTextUsable(active, instance) ? active.deliveryText : undefined;
      let delivered = false;
      for (const targetId of targets(config, active)) {
        let text = prepared || active.title.trim();
        if (!prepared && renderMessage) { try { text = await renderMessage(active, instance, text); } catch (error) { await logger.warn(`schedule render fallback event=${active.id}: ${error instanceof Error ? error.message : String(error)}`); } }
        try { await channel.send(targetId, { markdown: text }); delivered = true; } catch (error) { await logger.warn(`failed to deliver schedule ${active.id} to ${targetId}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (!delivered) continue;
      active.deliveryState.currentOccurrence.sentReminderIds.push(instance.reminderId); active.updatedAt = now.toISOString();
      active.deliveryText = undefined; active.deliveryTextGeneratedAt = undefined; active.deliveryPreparedReminderId = undefined; active.deliveryPreparedNotifyAt = undefined;
      if (afterDelivery) await afterDelivery(active, instance); sent += 1; changed = true;
    }
    if (allRemindersSent(active)) { advance(active, now); changed = true; }
  }
  if (changed) await writeEventRecords(config, events); return sent;
}
