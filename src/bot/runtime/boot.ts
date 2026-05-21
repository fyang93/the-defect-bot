import { Bot } from "grammy";
import type { AppConfig } from "bot/app/types";
import { logger } from "bot/app/logger";
import { currentModel, persistState, state } from "bot/app/state";
import type { AiService } from "bot/ai";
import { ScheduleEngine, scheduledTaskPromptForEvent, shouldGenerateScheduledTaskOnDelivery } from "bot/operations/events";
import { createMaintainerRunner } from "bot/runtime";
import type { ConversationController } from "bot/runtime/conversations/controller";
import { sendMessageFormatted } from "bot/telegram/format";
import { buildProviderKeyboard, buildProviderModelKeyboard, providersFromModels, resolveDisplayedModel } from "bot/telegram/model-selection/menu";
import { tForUser, userLocale } from "bot/app/i18n";

export function createBotLifecycle(input: {
  config: AppConfig;
  bot: Bot;
  agentService: AiService;
  scheduleEngine: ScheduleEngine;
  conversationController: ConversationController;
}) {
  const { config, bot, agentService, scheduleEngine, conversationController } = input;

  async function sendAdminMessage(text: string): Promise<void> {
    const adminUserId = config.telegram.adminUserId;
    if (!adminUserId) return;
    await logger.info(`sending admin message length=${text.trim().length}`);
    await sendMessageFormatted(bot, adminUserId, text);
  }

  async function ensureUsableStartupModel(): Promise<void> {
    if (!state.model) return;
    try {
      const { models } = await agentService.listModels();
      if (models.includes(state.model)) return;
      await logger.warn(`configured model ${state.model} is unavailable; falling back to the default OpenCode model`);
      state.model = null;
      await persistState(config.paths.stateFile);
    } catch (error) {
      await logger.warn(`failed to validate configured model at startup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function sendStartupGreeting(): Promise<void> {
    try {
      const adminUserId = config.telegram.adminUserId;
      if (!adminUserId) {
        await logger.warn("telegram.admin_user_id is not configured; skipping startup greeting");
        return;
      }
      const greeting = await agentService.generateStartupGreeting({ requesterUserId: adminUserId, preferredLanguage: userLocale(config, adminUserId) });
      if (!greeting) {
        await logger.warn("startup greeting returned empty output; skipping greet");
        return;
      }
      await sendAdminMessage(greeting);
      await logger.info("Sent startup greeting to admin_user_id only");
    } catch (error) {
      await logger.warn(`failed to send startup greeting: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function createMaintainerRunnerWithNotifications() {
    return createMaintainerRunner(config, agentService, {
      isBusy: () => conversationController.hasActiveTask(),
      onChange: async (summary) => {
        await sendAdminMessage(summary);
      },
    });
  }

  async function openModelPicker(ctx: any): Promise<void> {
    const { defaults, models } = await agentService.listModels();
    const activeModel = resolveDisplayedModel(state.model, defaults, currentModel());
    const providers = providersFromModels(models);
    const activeProvider = activeModel.split("/", 1)[0] || providers[0];
    if (providers.length === 1 || providers.includes(activeProvider)) {
      await ctx.reply(tForUser(config, ctx.from?.id, "choose_model_under_provider", { provider: activeProvider }), {
        reply_markup: buildProviderModelKeyboard(activeProvider, models, activeModel, config.telegram.menuPageSize, tForUser(config, ctx.from?.id, "ui_back"), 0),
      });
      return;
    }
    await ctx.reply(tForUser(config, ctx.from?.id, "choose_provider"), {
      reply_markup: buildProviderKeyboard(models, activeModel, config.telegram.menuPageSize, tForUser(config, ctx.from?.id, "ui_back"), 0),
    });
  }

  async function startScheduleLoop() {
    return scheduleEngine.startLoop(bot as any, {
      renderMessage: async (event, _instance, fallback) => {
        if (!shouldGenerateScheduledTaskOnDelivery(event)) return fallback;
        const prompt = scheduledTaskPromptForEvent(event).trim();
        if (!prompt) return fallback;
        const generated = await agentService.generateScheduledTaskContent(prompt);
        return generated.trim() || fallback;
      },
    });
  }

  return {
    sendAdminMessage,
    ensureUsableStartupModel,
    sendStartupGreeting,
    createMaintainerRunnerWithNotifications,
    openModelPicker,
    startScheduleLoop,
  };
}
