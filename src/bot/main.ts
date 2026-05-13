import { Bot } from "grammy";
import { loadConfig } from "bot/app/config";
import { DEFAULT_CONFIG_PATH, startConfigWatcher } from "bot/app/config_runtime";
import { configureLogger, logger } from "bot/app/logger";
import { AiService } from "bot/ai";
import { currentModel, loadPersistentState, persistState, state } from "bot/app/state";
import { pruneExpiredPendingAuthorizationsFromState } from "bot/operations/access/authorizations";
import { ensureAdminUserAccessLevel } from "bot/operations/access/roles";
import { handleScheduleCallback, prewarmScheduleDeliveryTexts, pruneInactiveEventRecords, startScheduleLoop } from "bot/operations/events";
import {
  buildProviderKeyboard,
  buildProviderModelKeyboard,
  providersFromModels,
  resolveDisplayedModel,
} from "bot/telegram/model-selection/menu";
import { tForLocale, tForUser, userLocale, type Locale } from "bot/app/i18n";
import { replyFormatted, sendMessageFormatted } from "bot/telegram/format";
import { accessLevelForUserId, hasUserAccessLevel, isAddressedToBot, isAdminUserId, unauthorizedGuard } from "bot/operations/access/control";
import { handleModelCallback } from "bot/telegram/model-selection/callback";
import { ConversationController } from "bot/runtime/conversations/controller";
import { createMaintainerRunner } from "bot/runtime";
import { shouldGenerateScheduledTaskOnDelivery, scheduledTaskPromptForEvent } from "bot/operations/events";

const configPath = DEFAULT_CONFIG_PATH;
const config = loadConfig(configPath);
await loadPersistentState(config.paths.stateFile);
await ensureAdminUserAccessLevel(config);
await configureLogger(config.paths.logFile);
await logger.info(`bot process starting pid=${process.pid}`);
const bot = new Bot(config.telegram.botToken);
const agentService = new AiService(config);
let botUsername: string | null = null;
let botUserId: number | null = null;
const pendingAuthorizationCleanup = setInterval(() => {
  void (async () => {
    const removed = await pruneExpiredPendingAuthorizationsFromState(config);
    if (removed <= 0) return;
    await logger.info(`removed ${removed} expired pending authorizations`);
  })().catch(async (error) => {
    await logger.warn(`pending authorization cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}, 60_000);

const conversationController = new ConversationController({
  config,
  bot,
  agentService,
  isAddressedToBot: (ctx) => isAddressedToBot(ctx, botUsername, botUserId),
});

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

bot.use((ctx, next) => unauthorizedGuard(config, ctx, next));

bot.command("new", async (ctx) => {
  const sessionId = await conversationController.resetSession(ctx);
  await persistState(config.paths.stateFile);
  await replyFormatted(ctx, tForUser(config, ctx.from?.id, "new_session", { sessionId }));
});

bot.command("model", async (ctx) => {
  if (!isAdminUserId(config, ctx.from?.id)) {
    await replyFormatted(ctx, tForUser(config, ctx.from?.id, "admin_only_command"));
    return;
  }
  try {
    const { defaults, models } = await agentService.listModels();
    const activeModel = resolveDisplayedModel(state.model, defaults, currentModel());
    const providers = providersFromModels(models);
    const activeProvider = activeModel.split("/", 1)[0] || providers[0];
    if (providers.length === 1 || providers.includes(activeProvider)) {
      await replyFormatted(ctx, tForUser(config, ctx.from?.id, "choose_model_under_provider", { provider: activeProvider }), {
        reply_markup: buildProviderModelKeyboard(activeProvider, models, activeModel, config.telegram.menuPageSize, tForUser(config, ctx.from?.id, "schedule_back"), 0),
      });
    } else {
      await replyFormatted(ctx, tForUser(config, ctx.from?.id, "choose_provider"), {
        reply_markup: buildProviderKeyboard(models, activeModel, config.telegram.menuPageSize, tForUser(config, ctx.from?.id, "schedule_back"), 0),
      });
    }
  } catch (error) {
    await replyFormatted(ctx, tForUser(config, ctx.from?.id, "fetch_models_failed", { error: error instanceof Error ? error.message : String(error) }));
  }
});

bot.command("help", async (ctx) => {
  const userId = ctx.from?.id;
  const accessLevel = accessLevelForUserId(config, userId);
  const lines: string[] = ["/help — " + tForUser(config, userId, "command_help"), "/new — " + tForUser(config, userId, "command_new")];
  if (accessLevel === "admin") lines.push("/model — " + tForUser(config, userId, "command_model"));
  await replyFormatted(ctx, lines.join("\n"));
});

bot.on("callback_query:data", async (ctx) => {
  if (await handleScheduleCallback(config, ctx)) {
    return;
  }

  if (!hasUserAccessLevel(config, ctx.from?.id, "trusted")) {
    await ctx.answerCallbackQuery({ text: tForUser(config, ctx.from?.id, "trusted_only_command"), show_alert: true });
    return;
  }

  if (await handleModelCallback(ctx, {
    config,
    listModels: () => agentService.listModels(),
    currentModelLabel: () => currentModel(),
    persistState: () => persistState(config.paths.stateFile),
    interruptActiveTask: (reason) => conversationController.interruptActiveTask(reason),
    editMessageTextFormattedSafe: (innerCtx, chatId, messageId, text, options) => conversationController.editMessageTextFormattedSafe(innerCtx, chatId, messageId, text, options),
  })) {
    return;
  }

  await ctx.answerCallbackQuery();
});

bot.on("message:text", (ctx) => conversationController.handleIncomingText(ctx));
bot.on("message:document", (ctx) => conversationController.handleIncomingFile(ctx));
bot.on("message:photo", (ctx) => conversationController.handleIncomingFile(ctx));
bot.on("message:voice", (ctx) => conversationController.handleIncomingFile(ctx));
bot.on("message:audio", (ctx) => conversationController.handleIncomingFile(ctx));
bot.on("message:video", (ctx) => conversationController.handleIncomingFile(ctx));
bot.on("message:contact", (ctx) => conversationController.handleIncomingContact(ctx));

bot.catch(async (error) => {
  const message = error.error instanceof Error ? error.error.stack || error.error.message : String(error.error);
  await logger.error(`unhandled bot error for update ${error.ctx.update.update_id}: ${message}`);
  try {
    if (error.ctx.chat?.id) {
      await replyFormatted(error.ctx, tForUser(config, error.ctx.from?.id, "task_failed", { error: "internal error" }));
    }
  } catch {
    // ignore secondary reply failures
  }
});

function buildBotCommands(locale: Locale) {
  const commandKeys = [
    { command: "help", key: "command_help" },
    { command: "new", key: "command_new" },
    { command: "model", key: "command_model" },
  ] as const;

  return commandKeys.map(({ command, key }) => ({
    command,
    description: tForLocale(locale, key),
  }));
}

async function syncBotCommands(): Promise<void> {
  await Promise.all([
    bot.api.setMyCommands(buildBotCommands(config.bot.language)),
    bot.api.setMyCommands(buildBotCommands("zh-CN"), { language_code: "zh" }),
    bot.api.setMyCommands(buildBotCommands("en"), { language_code: "en" }),
  ]);
}

await logger.info("bot starting");
let scheduleLoop = await startScheduleLoop(
  config,
  bot,
  async (event, _instance, fallback) => {
    if (!shouldGenerateScheduledTaskOnDelivery(event)) return fallback;
    const prompt = scheduledTaskPromptForEvent(event).trim();
    if (!prompt) return fallback;
    const generated = await agentService.generateScheduledTaskContent(prompt);
    return generated.trim() || fallback;
  },
);
let maintainerRunner = createMaintainerRunnerWithNotifications();
const configWatcher = startConfigWatcher(configPath, config, async (_reloadedConfig, result) => {
  configureLogger(config.paths.logFile);
  await ensureAdminUserAccessLevel(config);
  agentService.reloadConfig(config);
  if (maintainerRunner.timer) clearInterval(maintainerRunner.timer);
  maintainerRunner = createMaintainerRunnerWithNotifications();
  await syncBotCommands();
  if (config.telegram.adminUserId && (result.reloadedKeys.length > 0 || result.restartRequiredKeys.length > 0)) {
    const adminUserId = config.telegram.adminUserId;
    const lines = [tForUser(config, adminUserId, "config_reload_notice")];
    if (result.reloadedKeys.length > 0) {
      lines.push(tForUser(config, adminUserId, "config_reload_applied", { keys: result.reloadedKeys.join(", ") }));
    }
    if (result.restartRequiredKeys.length > 0) {
      lines.push(tForUser(config, adminUserId, "config_reload_restart_required", { keys: result.restartRequiredKeys.join(", ") }));
      lines.push(tForUser(config, adminUserId, "config_reload_restart_hint"));
    }
    await sendAdminMessage(lines.join("\n"));
  }
});

await bot.start({
  drop_pending_updates: true,
  onStart: async (botInfo) => {
    await syncBotCommands();
    botUsername = botInfo.username || null;
    botUserId = botInfo.id;
    await logger.info(`bot started as @${botInfo.username}`);
    await ensureUsableStartupModel();
    const inactiveScheduleCleanup = await pruneInactiveEventRecords(config);
    if (inactiveScheduleCleanup.removed > 0) {
      await logger.info(`startup pruned ${inactiveScheduleCleanup.removed} inactive schedules: ${inactiveScheduleCleanup.removedIds.join(", ")}`);
    }
    await prewarmScheduleDeliveryTexts(config, agentService);
    void sendStartupGreeting();
  },
});

function shutdown(): void {
  clearInterval(scheduleLoop);
  clearInterval(pendingAuthorizationCleanup);
  configWatcher.close();
  if (maintainerRunner.timer) clearInterval(maintainerRunner.timer);
  agentService.stop();
  bot.stop();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
