import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { AppConfig } from "bot/app/types";
import { logger } from "bot/app/logger";
import { persistState, state } from "bot/app/state";
import type { AiService } from "bot/ai";
import { ScheduleEngine, resolveScheduleDisplayTimezone, scheduledTaskPromptForEvent, scheduleEventScheduleSummary, shouldGenerateScheduledTaskOnDelivery } from "bot/operations/events";
import { createMaintainerRunner } from "bot/runtime/maintainer";
import type { ConversationController } from "bot/runtime/conversations/controller";

export function createBotLifecycle(input: { config: AppConfig; channel: LarkChannel; agentService: AiService; scheduleEngine: ScheduleEngine; conversationController: ConversationController }) {
  const { config, channel, agentService, scheduleEngine, conversationController } = input;
  async function ensureUsableStartupModel(): Promise<void> {
    if (!state.model) return;
    try { const { models } = await agentService.listModels(); if (!models.includes(state.model)) { state.model = null; await persistState(config.paths.stateFile); } }
    catch (error) { await logger.warn(`failed to validate startup model: ${error instanceof Error ? error.message : String(error)}`); }
  }
  async function warmAssistantResources(): Promise<void> { try { await agentService.warmAssistantResources(); } catch (error) { await logger.warn(`failed to warm assistant resources: ${error instanceof Error ? error.message : String(error)}`); } }
  function createMaintainerRunnerWithoutNotifications() { return createMaintainerRunner(config, agentService, { isBusy: () => conversationController.hasActiveTask() }); }
  async function startScheduleLoop() {
    return scheduleEngine.startLoop(channel, { renderMessage: async (event, instance, fallback) => {
      if (shouldGenerateScheduledTaskOnDelivery(event)) {
        const prompt = scheduledTaskPromptForEvent(event).trim();
        return prompt ? (await agentService.generateScheduledTaskContent(prompt)).trim() || fallback : fallback;
      }
      return (await agentService.generateReminderText(event.title, instance.notifyAt, scheduleEventScheduleSummary(config, event), resolveScheduleDisplayTimezone(config, event), { eventScheduledAt: event.deliveryState?.currentOccurrence?.scheduledAt, reminderLabel: instance.label, reminderOffsetMinutes: instance.offsetMinutes, specialKind: event.specialKind, category: event.category })).trim() || fallback;
    } });
  }
  return { ensureUsableStartupModel, warmAssistantResources, createMaintainerRunnerWithoutNotifications, startScheduleLoop };
}
