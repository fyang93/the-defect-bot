import { createLarkChannel, LoggerLevel, type CardActionEvent, type EventDispatcher, type NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { loadConfig } from "bot/app/config";
import { DEFAULT_CONFIG_PATH, startConfigWatcher } from "bot/app/config_runtime";
import { configureLogger, logger } from "bot/app/logger";
import { migrateSystemStateForFeishu } from "bot/app/migrate";
import { currentModel, loadPersistentState, persistState, state } from "bot/app/state";
import { AiService } from "bot/ai";
import { currentRemindersText, ScheduleEngine, type ScheduleLoopHandle } from "bot/operations/events";
import { ConversationController } from "bot/runtime/conversations/controller";
import { createBotLifecycle } from "bot/runtime/boot";
import { feishuModelPickerCard, feishuModelSelectedCard, isFeishuMessageAddressed, isFeishuMessageGoneError, parseFeishuCommand, parseFeishuMenuEventKey, parseFeishuModelAction } from "bot/feishu/message";
import { rememberFeishuMessage } from "bot/feishu/registry";

const HELP = [
  "Defect Bot 飞书入口。",
  "",
  "私聊可直接发送；群聊中请 @ 机器人。支持文字、图片、文档、音频和视频。",
  "/help - 显示帮助",
  "/new - 新建当前会话",
  "/stop - 中止当前任务",
  "/quota - 查看剩余 Pi 服务商额度",
  "/reminders - 查看当前提醒",
  "/model [provider/model] - 查看或切换模型",
].join("\n");

const config = loadConfig(DEFAULT_CONFIG_PATH);
await migrateSystemStateForFeishu(config);
await loadPersistentState(config.paths.stateFile);
await configureLogger(config.paths.logFile);
const agentService = new AiService(config);
const channel = createLarkChannel({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  source: "the-defect-bot",
  loggerLevel: LoggerLevel.warn,
  policy: { requireMention: false, dmMode: "open" },
  outbound: { allowedFileDirs: [config.paths.repoRoot, config.paths.tmpDir], streamInitialText: "思考中…" },
});
const controller = new ConversationController({ config, channel, agentService });
const scheduleEngine = new ScheduleEngine(config, agentService);
const lifecycle = createBotLifecycle({ config, channel, agentService, scheduleEngine, conversationController: controller });
const chatInfoCache = new Map<string, { title?: string; mode: "p2p" | "group" | "topic" }>();

async function modelsCard(provider?: string, page = 0): Promise<object> {
  const { models } = await agentService.listModels();
  return feishuModelPickerCard(models, currentModel(), provider, page, config.feishu.menuPageSize);
}
async function applyModel(key: string): Promise<void> {
  const { models } = await agentService.listModels();
  if (!models.includes(key)) throw new Error(`模型不可用：${key}`);
  await controller.interruptActiveTask("model changed");
  await agentService.resetSessions();
  state.model = key;
  await persistState(config.paths.stateFile);
}
async function reply(message: NormalizedMessage, text: string): Promise<void> {
  await channel.send(message.chatId, { markdown: text }, { replyTo: message.messageId, replyInThread: Boolean(message.threadId) });
}

async function handleCommand(message: NormalizedMessage, command: { name: string; arg: string }): Promise<boolean> {
  if (command.name === "help" || command.name === "start") { await reply(message, HELP); return true; }
  if (command.name === "stop") { await controller.interruptActiveTask("stop command", message.chatType === "group" ? `chat:${message.chatId}` : `user:${message.senderId}`); await reply(message, "已中止当前任务。"); return true; }
  if (command.name === "new") { await controller.resetSession(message); await reply(message, "已开启新的飞书 agent 会话。"); return true; }
  if (command.name === "quota") { await reply(message, await agentService.quotaText() || "暂时无法获取额度，请稍后再试。"); return true; }
  if (command.name === "reminders") { await reply(message, await currentRemindersText(config)); return true; }
  if (command.name === "model") {
    if (command.arg) { await applyModel(command.arg); await reply(message, `当前 Pi 模型：${command.arg}`); }
    else await channel.send(message.chatId, { card: await modelsCard() }, { replyTo: message.messageId, replyInThread: Boolean(message.threadId) });
    return true;
  }
  if (message.content.trim().startsWith("/")) { await reply(message, `未知命令：/${command.name}\n\n${HELP}`); return true; }
  return false;
}

async function handleMessage(message: NormalizedMessage): Promise<void> {
  let info = chatInfoCache.get(message.chatId);
  if (!info) {
    const fetched = await channel.getChatInfo(message.chatId).catch(() => undefined);
    const mode = message.chatType === "p2p" ? "p2p" : await channel.getChatMode(message.chatId).catch(() => "group" as const);
    info = { title: fetched?.name, mode }; chatInfoCache.set(message.chatId, info);
  }
  rememberFeishuMessage(config, message, info.title, info.mode);
  const addressed = isFeishuMessageAddressed(message);
  if (!addressed) { await controller.stash(message); return; }
  const command = parseFeishuCommand(message.content);
  if (command && await handleCommand(message, command)) return;
  await controller.handleMessage(message);
}

type FeishuMenuEvent = { event_key?: string; operator?: { operator_id?: { open_id?: string } } };
async function handleMenuEvent(event: FeishuMenuEvent): Promise<void> {
  const openId = event.operator?.operator_id?.open_id;
  const command = parseFeishuMenuEventKey(event.event_key);
  if (!openId || !command) {
    await logger.warn(`ignored Feishu menu event key=${JSON.stringify(event.event_key || "")} openId=${JSON.stringify(openId || "")}`);
    return;
  }
  await logger.info(`Feishu menu event command=${command} sender=${openId}`);
  if (command === "new") { await controller.resetUserSession(openId); await channel.send(openId, { markdown: "已开启新的飞书 agent 会话。" }); return; }
  if (command === "quota") { await channel.send(openId, { markdown: await agentService.quotaText() || "暂时无法获取额度，请稍后再试。" }); return; }
  if (command === "reminders") { await channel.send(openId, { markdown: await currentRemindersText(config) }); return; }
  if (command === "model") { await channel.send(openId, { card: await modelsCard() }); return; }
  if (command === "help" || command === "start") await channel.send(openId, { markdown: HELP });
}

(channel as unknown as { dispatcher: EventDispatcher }).dispatcher.register({
  "im.message.recalled_v1": async (event: { message_id?: string }) => controller.handleMessageRecall(event.message_id),
  "application.bot.menu_v6": async (event: FeishuMenuEvent) => handleMenuEvent(event).catch(async (error) => {
    const openId = event.operator?.operator_id?.open_id;
    await logger.error(`Feishu menu event failed key=${JSON.stringify(event.event_key || "")}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    if (openId) await channel.send(openId, { markdown: `菜单操作失败：${error instanceof Error ? error.message : String(error)}` }).catch(() => undefined);
  }),
});

channel.on("message", (message) => { void handleMessage(message).catch(async (error) => {
  if (isFeishuMessageGoneError(error)) return;
  await logger.error(`feishu message failed message=${message.messageId}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  await reply(message, `错误：${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
}); });
channel.on("cardAction", (event: CardActionEvent) => {
  const action = parseFeishuModelAction(event.action.value); if (!action) return;
  setTimeout(() => void (async () => {
    if (action.action === "set_model") { await applyModel(action.key); await channel.updateCard(event.messageId, feishuModelSelectedCard(action.key)); }
    else await channel.updateCard(event.messageId, await modelsCard(action.action === "models" ? action.provider : undefined, action.action === "models" ? action.page : 0));
  })().catch((error) => logger.warn(`model card action failed: ${error instanceof Error ? error.message : String(error)}`)), 300);
});
channel.on("error", (error) => { void logger.error(`feishu channel error: ${error.message}`); });

await logger.info(`bot process starting pid=${process.pid}`);
await channel.connect();
await logger.info(`Feishu bot started as ${channel.botIdentity?.name || config.feishu.appId}`);
await lifecycle.ensureUsableStartupModel();
await lifecycle.warmAssistantResources();
const cleanup = await scheduleEngine.prune();
if (cleanup.removed) await logger.info(`startup pruned ${cleanup.removed} inactive schedules`);
let scheduleLoop: ScheduleLoopHandle = await lifecycle.startScheduleLoop();
let maintainer = lifecycle.createMaintainerRunnerWithoutNotifications();
const watcher = startConfigWatcher(DEFAULT_CONFIG_PATH, config, async (_next, result) => {
  agentService.reloadConfig(config);
  if (maintainer.timer) clearInterval(maintainer.timer);
  maintainer = lifecycle.createMaintainerRunnerWithoutNotifications();
  if (result.restartRequiredKeys.length) await logger.warn(`restart required for: ${result.restartRequiredKeys.join(", ")}`);
});

async function shutdown(): Promise<void> {
  scheduleLoop.stop(); watcher.close(); if (maintainer.timer) clearInterval(maintainer.timer);
  agentService.stop(); await channel.disconnect();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void shutdown().finally(() => process.exit(0)); });
