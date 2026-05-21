import { Bot } from "grammy";
import { loadConfig } from "bot/app/config";
import { DEFAULT_CONFIG_PATH, startConfigWatcher } from "bot/app/config_runtime";
import { configureLogger, logger } from "bot/app/logger";
import { AiService } from "bot/ai";
import { currentModel, loadPersistentState, persistState } from "bot/app/state";
import { pruneExpiredPendingAuthorizationsFromState } from "bot/operations/access/authorizations";
import { ensureAdminUserAccessLevel } from "bot/operations/access/roles";
import { ScheduleEngine } from "bot/operations/events";
import { tForLocale, tForUser, type Locale } from "bot/app/i18n";
import { replyFormatted } from "bot/telegram/format";
import { accessLevelForUserId, hasUserAccessLevel, isAddressedToBot, isAdminUserId, unauthorizedGuard } from "bot/operations/access/control";
import { handleModelCallback } from "bot/telegram/model-selection/callback";
import { ConversationController } from "bot/runtime/conversations/controller";
import { createBotLifecycle } from "bot/runtime/boot";

const configPath = DEFAULT_CONFIG_PATH;
const config = loadConfig(configPath);
await loadPersistentState(config.paths.stateFile);
await ensureAdminUserAccessLevel(config);
await configureLogger(config.paths.logFile);
await logger.info(`bot process starting pid=${process.pid}`);
const bot = new Bot(config.telegram.botToken);
const agentService = new AiService(config);
const scheduleEngine = new ScheduleEngine(config, agentService);
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

const lifecycle = createBotLifecycle({
  config,
  bot,
  agentService,
  scheduleEngine,
  conversationController,
});

bot.use((ctx, next) => unauthorizedGuard(config, ctx, next));

bot.command("new", async (ctx) => {
  const sessionId = await conversationController.resetSession(ctx);
  await persistState(config.paths.stateFile);
  await replyFormatted(ctx, tForUser(config, ctx.from?.id, "new_session", { sessionId }));
});

bot.command("model", async (ctx) => {
  if (!isAdminUserId(config, ctx.from?.id)) {
    return;
  }
  try {
    await lifecycle.openModelPicker(ctx);
  } catch (error) {
    await logger.warn(`failed to fetch model list: ${error instanceof Error ? error.message : String(error)}`);
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
  if (!hasUserAccessLevel(config, ctx.from?.id, "trusted")) {
    await ctx.answerCallbackQuery({ show_alert: true });
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
      await logger.warn("reply to user skipped after unhandled bot error");
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
let scheduleLoop = await lifecycle.startScheduleLoop();
let maintainerRunner = lifecycle.createMaintainerRunnerWithNotifications();
const configWatcher = startConfigWatcher(configPath, config, async (_reloadedConfig, result) => {
  configureLogger(config.paths.logFile);
  await ensureAdminUserAccessLevel(config);
  agentService.reloadConfig(config);
  if (maintainerRunner.timer) clearInterval(maintainerRunner.timer);
  maintainerRunner = lifecycle.createMaintainerRunnerWithNotifications();
  await syncBotCommands();
  if (config.telegram.adminUserId && (result.reloadedKeys.length > 0 || result.restartRequiredKeys.length > 0)) {
    await logger.info(`config reloaded applied=${result.reloadedKeys.join(",")} restartRequired=${result.restartRequiredKeys.join(",")}`);
  }
});

await bot.start({
  drop_pending_updates: true,
  onStart: async (botInfo) => {
    await logger.info("startup phase: sync bot commands");
    await syncBotCommands();
    botUsername = botInfo.username || null;
    botUserId = botInfo.id;
    await logger.info(`bot started as @${botInfo.username}`);
    await logger.info("startup phase: ensure usable startup model");
    await lifecycle.ensureUsableStartupModel();
    await logger.info("startup phase: prune inactive schedules");
    const inactiveScheduleCleanup = await scheduleEngine.prune();
    if (inactiveScheduleCleanup.removed > 0) {
      await logger.info(`startup pruned ${inactiveScheduleCleanup.removed} inactive schedules: ${inactiveScheduleCleanup.removedIds.join(", ")}`);
    }
    await logger.info("startup phase: schedule prewarm queued in background");
    void scheduleEngine.prepare().then(async () => {
      await logger.info("startup phase: schedule prewarm finished");
    }).catch(async (error) => {
      await logger.warn(`startup schedule prewarm failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await logger.info("startup phase: startup greeting queued");
    void lifecycle.sendStartupGreeting();
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
