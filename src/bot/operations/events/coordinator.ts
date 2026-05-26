import type { Bot, Context } from "grammy";
import type { AppConfig } from "bot/app/types";
import { logger } from "bot/app/logger";
import type { EventRecord, ReminderInstance } from "./types";
import { deliverDueSchedules } from "./delivery";
import { isPreparedScheduleDeliveryTextUsable, nextPendingScheduleInstance, shouldGenerateScheduledTaskOnDelivery } from "./preparation";
import { readEventRecords } from "./store";

const MAX_TIMER_DELAY_MS = 60 * 60_000;
const DELIVERY_RETRY_DELAY_MS = 30_000;
const PREPARATION_RETRY_DELAY_MS = 10 * 60_000;
const SAFETY_SWEEP_INTERVAL_MS = 10 * 60_000;
const PERIODIC_PREPARE_WINDOW_MS = 24 * 60 * 60_000;

export type ScheduleLoopHandle = {
  stop(): void;
  requestReschedule(reason?: string): void;
};

type ScheduleCoordinatorHooks = {
  renderMessage?: (event: EventRecord, instance: ReminderInstance, fallback: string) => Promise<string>;
  afterDelivery?: (event: EventRecord, instance: ReminderInstance) => Promise<void>;
  prepareDeliveryTexts?: () => Promise<void>;
};

function earliestTime(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return finite.length > 0 ? Math.min(...finite) : null;
}

function nextDeliveryAt(events: EventRecord[], now: Date): number | null {
  return earliestTime(events
    .filter((event) => event.status === "active")
    .map((event) => {
      const instance = nextPendingScheduleInstance(event, now);
      if (!instance) return null;
      const notifyAt = Date.parse(instance.notifyAt);
      return Number.isFinite(notifyAt) ? notifyAt : null;
    }));
}

function nextPreparationAt(events: EventRecord[], now: Date): number | null {
  return earliestTime(events
    .filter((event) => event.status === "active" && !shouldGenerateScheduledTaskOnDelivery(event))
    .map((event) => {
      const instance = nextPendingScheduleInstance(event, now);
      if (!instance || isPreparedScheduleDeliveryTextUsable(event, instance)) return null;
      if (event.schedule.kind === "once") return now.getTime();
      const notifyAt = Date.parse(instance.notifyAt);
      if (!Number.isFinite(notifyAt)) return null;
      return notifyAt - PERIODIC_PREPARE_WINDOW_MS;
    }));
}

function clampedDelayUntil(targetAt: number, nowMs: number, recentAttemptAt: number, retryDelayMs: number): number {
  if (targetAt <= nowMs && recentAttemptAt > 0 && nowMs - recentAttemptAt < retryDelayMs) {
    return retryDelayMs - (nowMs - recentAttemptAt);
  }
  return Math.max(0, Math.min(targetAt - nowMs, MAX_TIMER_DELAY_MS));
}

export class ScheduleCoordinator implements ScheduleLoopHandle {
  private deliveryTimer: NodeJS.Timeout | null = null;
  private preparationTimer: NodeJS.Timeout | null = null;
  private safetySweepTimer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private rescheduleRequested = false;
  private lastDeliveryAttemptAt = 0;
  private lastPreparationAttemptAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly bot: Bot<Context>,
    private readonly hooks: ScheduleCoordinatorHooks = {},
  ) {}

  start(): void {
    this.stopped = false;
    this.requestReschedule("start");
    this.safetySweepTimer = setInterval(() => {
      void this.runExclusive("safety sweep", async () => {
        this.lastDeliveryAttemptAt = Date.now();
        const sent = await deliverDueSchedules(this.config, this.bot, this.hooks.renderMessage, this.hooks.afterDelivery);
        if (sent > 0) await logger.info(`sent ${sent} schedules`);
        if (this.hooks.prepareDeliveryTexts) {
          this.lastPreparationAttemptAt = Date.now();
          await this.hooks.prepareDeliveryTexts();
        }
      });
    }, SAFETY_SWEEP_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.safetySweepTimer) clearInterval(this.safetySweepTimer);
    this.safetySweepTimer = null;
  }

  requestReschedule(reason = "unspecified"): void {
    if (this.stopped) return;
    if (this.running) {
      this.rescheduleRequested = true;
      return;
    }
    void this.armTimers(reason);
  }

  private clearTimers(): void {
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    if (this.preparationTimer) clearTimeout(this.preparationTimer);
    this.deliveryTimer = null;
    this.preparationTimer = null;
  }

  private async armTimers(reason: string): Promise<void> {
    if (this.stopped || this.running) return;
    this.clearTimers();
    const now = new Date();
    const events = await readEventRecords(this.config);
    const deliveryAt = nextDeliveryAt(events, now);
    const preparationAt = this.hooks.prepareDeliveryTexts ? nextPreparationAt(events, now) : null;
    const nowMs = now.getTime();

    if (deliveryAt != null) {
      const delay = clampedDelayUntil(deliveryAt, nowMs, this.lastDeliveryAttemptAt, DELIVERY_RETRY_DELAY_MS);
      this.deliveryTimer = setTimeout(() => {
        void this.runExclusive("delivery timer", async () => {
          this.lastDeliveryAttemptAt = Date.now();
          const sent = await deliverDueSchedules(this.config, this.bot, this.hooks.renderMessage, this.hooks.afterDelivery);
          if (sent > 0) await logger.info(`sent ${sent} schedules`);
        });
      }, delay);
    }

    if (preparationAt != null) {
      const delay = clampedDelayUntil(preparationAt, nowMs, this.lastPreparationAttemptAt, PREPARATION_RETRY_DELAY_MS);
      this.preparationTimer = setTimeout(() => {
        void this.runExclusive("preparation timer", async () => {
          if (this.hooks.prepareDeliveryTexts) {
            this.lastPreparationAttemptAt = Date.now();
            await this.hooks.prepareDeliveryTexts();
          }
        });
      }, delay);
    }

    await logger.info(`schedule coordinator armed reason=${JSON.stringify(reason)} nextDeliveryAt=${deliveryAt ? new Date(deliveryAt).toISOString() : "none"} nextPreparationAt=${preparationAt ? new Date(preparationAt).toISOString() : "none"}`);
  }

  private async runExclusive(label: string, work: () => Promise<void>): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.rescheduleRequested = true;
      await logger.warn(`skipping schedule ${label} because another schedule operation is running`);
      return;
    }
    this.running = true;
    this.clearTimers();
    try {
      await work();
    } catch (error) {
      await logger.error(`schedule ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
      const reason = this.rescheduleRequested ? `${label} completed with pending reschedule` : `${label} completed`;
      this.rescheduleRequested = false;
      this.requestReschedule(reason);
    }
  }
}

export async function startScheduleLoop(
  config: AppConfig,
  bot: Bot<Context>,
  hooks: ScheduleCoordinatorHooks = {},
): Promise<ScheduleLoopHandle> {
  const coordinator = new ScheduleCoordinator(config, bot, hooks);
  coordinator.start();
  return coordinator;
}
