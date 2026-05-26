import type { Bot, Context } from "grammy";
import type { AppConfig } from "bot/app/types";
import { logger } from "bot/app/logger";
import type { AiService } from "bot/ai";
import type { EventRecord, ReminderInstance } from "./types";
import { deliverDueSchedules } from "./delivery";
import { startScheduleLoop, type ScheduleLoopHandle } from "./coordinator";
import { prepareScheduleDeliveryTextAndPersistIfUnchanged, prewarmScheduleDeliveryTexts } from "./preparation";
import { pruneInactiveEventRecords, readEventRecords, getEventRecord } from "./store";
import { runEventTask, type TaskRecord } from "./task-actions";
import { scheduleEventScheduleSummary } from "./schedule";

export type ScheduleEngineDeliverHooks = {
  renderMessage?: (event: EventRecord, instance: ReminderInstance, fallback: string) => Promise<string>;
  afterDelivery?: (event: EventRecord, instance: ReminderInstance) => Promise<void>;
};

export class ScheduleEngine {
  private scheduleLoop: ScheduleLoopHandle | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly agentService: AiService,
  ) {}

  async applyTask(task: TaskRecord): Promise<{ changed?: boolean; eventId?: string; eventIds?: string[]; skipped?: boolean; reason?: string }> {
    const result = await runEventTask(this.config, task);
    if (result.changed) this.scheduleLoop?.requestReschedule("event task changed schedule state");
    return result;
  }

  async prepare(input?: { eventId?: string; now?: Date }): Promise<{ changed: boolean; skipped?: boolean; reason?: string }> {
    if (input?.eventId) {
      const event = await getEventRecord(this.config, input.eventId);
      if (!event) return { changed: false, skipped: true, reason: "missing-event" };
      const result = await prepareScheduleDeliveryTextAndPersistIfUnchanged(this.config, this.agentService, event, input.now || new Date());
      if (result.changed) this.scheduleLoop?.requestReschedule("single event preparation changed schedule state");
      return result;
    }
    const events = await readEventRecords(this.config);
    const activeCount = events.filter((event) => event.status === "active").length;
    await logger.info(`schedule engine prepare start activeEvents=${activeCount}`);
    await prewarmScheduleDeliveryTexts(this.config, this.agentService);
    await logger.info(`schedule engine prepare end activeEvents=${activeCount}`);
    this.scheduleLoop?.requestReschedule("bulk preparation checked schedule state");
    return { changed: true };
  }

  async deliver(bot: Bot<Context>, hooks?: ScheduleEngineDeliverHooks): Promise<number> {
    return deliverDueSchedules(this.config, bot, hooks?.renderMessage, hooks?.afterDelivery);
  }

  async startLoop(bot: Bot<Context>, hooks?: ScheduleEngineDeliverHooks): Promise<ScheduleLoopHandle> {
    this.scheduleLoop = await startScheduleLoop(this.config, bot, {
      renderMessage: hooks?.renderMessage,
      afterDelivery: hooks?.afterDelivery,
      prepareDeliveryTexts: async () => {
        await this.prepare();
      },
    });
    return this.scheduleLoop;
  }

  async prune(): Promise<{ removed: number; removedIds: string[]; removedSummaries: string[] }> {
    return pruneInactiveEventRecords(this.config);
  }

  async list(): Promise<EventRecord[]> {
    return readEventRecords(this.config);
  }

  describe(event: EventRecord): string {
    return scheduleEventScheduleSummary(this.config, event);
  }
}
