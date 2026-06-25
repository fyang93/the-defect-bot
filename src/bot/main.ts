import { Bot } from "grammy";
import { loadConfig } from "bot/app/config";
import { DEFAULT_CONFIG_PATH, startConfigWatcher } from "bot/app/config_runtime";
import { configureLogger, logger } from "bot/app/logger";
import { AiService } from "bot/ai";
import { currentModel, loadPersistentState, persistState } from "bot/app/state";
import { pruneExpiredPendingAuthorizationsFromState } from "bot/operations/access/authorizations";
import { ensureAdminUserAccessLevel } from "bot/operations/access/roles";
import { ScheduleEngine, type ScheduleLoopHandle } from "bot/operations/events";
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
const TELEGRAM_API_TIMEOUT_SECONDS = 15;
const TELEGRAM_POLL_TIMEOUT_SECONDS = 10;
const configuredBotId = Number(config.telegram.botToken.split(":", 1)[0]);
const bot = new Bot(config.telegram.botToken, {
  client: {
    timeoutSeconds: TELEGRAM_API_TIMEOUT_SECONDS,
  },
  // Avoid a blocking getMe call during startup. grammY will otherwise fetch bot
  // info before onStart, which can make startup appear frozen when Telegram is
  // slow/unreachable. The bot id is encoded in the token prefix.
  botInfo: {
    id: configuredBotId,
    is_bot: true,
    first_name: "a_defect_bot",
    username: "a_defect_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
  },
});
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

const BOT_COMMAND_SYNC_TIMEOUT_MS = 5_000;
const BOT_STARTUP_TELEGRAM_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const details: string[] = [error.message];
  const grammYHttpError = error as Error & { error?: unknown };
  const wrappedError = grammYHttpError.error;
  const cause = wrappedError instanceof Error ? wrappedError.cause : undefined;
  if (cause && typeof cause === "object") {
    const code = "code" in cause ? String(cause.code) : null;
    if (code) details.push(`cause=${code}`);
    const nestedErrors = "errors" in cause && Array.isArray(cause.errors) ? cause.errors : [];
    const nestedCodes = nestedErrors
      .map((nested) => (nested && typeof nested === "object" && "code" in nested ? String(nested.code) : null))
      .filter((code): code is string => Boolean(code));
    if (nestedCodes.length > 0) details.push(`nested=${[...new Set(nestedCodes)].join(",")}`);
  }
  return details.join(" ");
}

async function logBotCommandState(reason: string): Promise<void> {
  try {
    const commands = await bot.api.getMyCommands();
    const defaultMenuButton = await bot.api.getChatMenuButton();
    const adminMenuButton = config.telegram.adminUserId
      ? await bot.api.getChatMenuButton({ chat_id: config.telegram.adminUserId }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
      : null;
    await logger.info(`telegram command state reason=${reason} defaultMenuButton=${JSON.stringify(defaultMenuButton)} adminMenuButton=${JSON.stringify(adminMenuButton)} commands=${JSON.stringify(commands.map((command) => command.command))}`);
  } catch (error) {
    await logger.warn(`telegram command state unavailable reason=${reason}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function syncBotCommands(): Promise<void> {
  await bot.api.setMyCommands(buildBotCommands(config.bot.language));
  await bot.api.setChatMenuButton({ menu_button: { type: "commands" } });
  if (config.telegram.adminUserId) {
    // Clear any admin chat-specific menu button so the default commands menu is used.
    await bot.api.setChatMenuButton({ chat_id: config.telegram.adminUserId, menu_button: { type: "default" } });
  }
  await logBotCommandState("after sync");
}

async function syncBotCommandsSafe(reason: string): Promise<void> {
  try {
    await withTimeout(syncBotCommands(), BOT_COMMAND_SYNC_TIMEOUT_MS, "sync bot commands");
  } catch (error) {
    await logger.warn(`sync bot commands skipped reason=${reason}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await logger.info("bot starting");
let scheduleLoop: ScheduleLoopHandle = await lifecycle.startScheduleLoop();
let maintainerRunner = lifecycle.createMaintainerRunnerWithNotifications();
const configWatcher = startConfigWatcher(configPath, config, async (_reloadedConfig, result) => {
  configureLogger(config.paths.logFile);
  await ensureAdminUserAccessLevel(config);
  agentService.reloadConfig(config);
  if (maintainerRunner.timer) clearInterval(maintainerRunner.timer);
  maintainerRunner = lifecycle.createMaintainerRunnerWithNotifications();
  await syncBotCommandsSafe("config reload");
  if (config.telegram.adminUserId && (result.reloadedKeys.length > 0 || result.restartRequiredKeys.length > 0)) {
    await logger.info(`config reloaded applied=${result.reloadedKeys.join(",")} restartRequired=${result.restartRequiredKeys.join(",")}`);
  }
});

await logger.info("startup phase: start grammY polling");
try {
  await logger.info("startup phase: drop pending updates");
  await withTimeout(bot.api.deleteWebhook({ drop_pending_updates: true }), BOT_STARTUP_TELEGRAM_TIMEOUT_MS, "drop pending updates");
} catch (error) {
  await logger.warn(`drop pending updates skipped: ${formatError(error)}`);
}

async function runPostPollingStartupTasks(): Promise<void> {
  await logger.info("startup phase: sync bot commands");
  await syncBotCommandsSafe("startup");
  await logger.info("startup phase: ensure usable startup model");
  await lifecycle.ensureUsableStartupModel();
  await lifecycle.warmAssistantResources();
  await logger.info("startup phase: prune inactive schedules");
  const inactiveScheduleCleanup = await scheduleEngine.prune();
  if (inactiveScheduleCleanup.removed > 0) {
    await logger.info(`startup pruned ${inactiveScheduleCleanup.removed} inactive schedules: ${inactiveScheduleCleanup.removedIds.join(", ")}`);
  }
  await logger.info("startup phase: startup greeting queued");
  void lifecycle.sendStartupGreeting();
}

const pollingPromise = bot.start({
  timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
  onStart: async (botInfo) => {
    botUsername = botInfo.username || null;
    botUserId = botInfo.id;
    await logger.info(`bot started as @${botInfo.username}`);
  },
}).catch(async (error) => {
  await logger.error(`grammY polling stopped: ${formatError(error)}`);
});
await logger.info("startup phase: grammY polling setup running in background");
await runPostPollingStartupTasks();

function shutdown(): void {
  scheduleLoop.stop();
  clearInterval(pendingAuthorizationCleanup);
  configWatcher.close();
  if (maintainerRunner.timer) clearInterval(maintainerRunner.timer);
  agentService.stop();
  bot.stop();
  void pollingPromise;
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
