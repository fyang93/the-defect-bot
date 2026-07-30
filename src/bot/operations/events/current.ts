import type { AppConfig } from "bot/app/types";
import { formatEventRecord, getCurrentOccurrence } from "./schedule";
import { readEventRecords } from "./store";

export async function currentRemindersText(config: AppConfig, now = new Date()): Promise<string> {
  const reminders = (await readEventRecords(config))
    .filter((event) => event.status === "active" && event.category !== "automation" && event.reminders.some((item) => item.enabled))
    .map((event) => ({ event, occurrence: getCurrentOccurrence(event, now) }))
    .sort((left, right) => {
      const leftTime = left.occurrence ? Date.parse(left.occurrence.scheduledAt) : Number.MAX_SAFE_INTEGER;
      const rightTime = right.occurrence ? Date.parse(right.occurrence.scheduledAt) : Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime || left.event.title.localeCompare(right.event.title);
    });

  if (reminders.length === 0) return "当前没有启用的提醒。";
  return ["当前提醒：", ...reminders.map(({ event }, index) => `${index + 1}. ${formatEventRecord(config, event)}`)].join("\n");
}
