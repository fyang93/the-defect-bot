import { readFileSync } from "node:fs";
import path from "node:path";
import { Bot } from "grammy";
import { sendMessageFormatted } from "bot/telegram/format";
import { sendTelegramLocalFile } from "bot/telegram/delivery";
import { findTelegramChats, findTelegramUsers } from "bot/telegram/registry";
import { accessLevelForUser, listAuthorizedUserIds } from "bot/operations/access/roles";
import { hasAccessLevel } from "bot/operations/access/control";
import { logger } from "bot/app/logger";
import { scheduleRepoToolCommand } from "bot/tools/scheduler";
import type { RepoToolContext } from "bot/tools/runtime";

async function deliverTelegramMessage(context: RepoToolContext, recipientId: number, content: string, recipientLabel?: string): Promise<{ ok: true; delivered: true; recipientId: number; recipientLabel?: string; messageId?: number }> {
  await logger.info(`telegram tool send_message recipient=${recipientLabel || recipientId} chars=${content.length} content=${context.logTextContent(content)}`);
  const bot = new Bot(context.config.telegram.botToken);
  const result = await sendMessageFormatted(bot as any, recipientId, content);
  const messageId = typeof result === "object" && result && "message_id" in (result as Record<string, unknown>) ? Number((result as Record<string, unknown>).message_id) : undefined;
  await logger.info(`telegram tool send_message delivered recipient=${recipientLabel || recipientId} messageId=${messageId ?? "unknown"}`);
  return { ok: true, delivered: true, recipientId, recipientLabel, messageId };
}

async function deliverTelegramFile(context: RepoToolContext, recipientId: number, filePath: string, caption?: string, recipientLabel?: string): Promise<{ ok: true; delivered: true; recipientId: number; recipientLabel?: string; messageId?: number; filePath: string }> {
  await logger.info(`telegram tool send_file recipient=${recipientLabel || recipientId} file=${filePath} captionChars=${caption?.length || 0}`);
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(context.config.paths.repoRoot, filePath);
  const relPath = path.relative(context.config.paths.repoRoot, absPath);
  if (relPath.startsWith("..")) context.output({ ok: false, error: "file-outside-repo" });
  readFileSync(absPath);
  const bot = new Bot(context.config.telegram.botToken);
  const { messageId } = await sendTelegramLocalFile(bot.api as any, recipientId, absPath, { filename: path.basename(absPath), caption });
  await logger.info(`telegram tool send_file delivered recipient=${recipientLabel || recipientId} file=${relPath || path.basename(absPath)} messageId=${messageId ?? "unknown"}`);
  return { ok: true, delivered: true, recipientId, recipientLabel, messageId, filePath: relPath || path.basename(absPath) };
}

export async function scheduleTelegramMessage(
  context: RepoToolContext,
  recipientId: number,
  content: string,
  sendAt: string,
  recipientLabel?: string,
  requesterUserId?: number,
  scheduleCommand: typeof scheduleRepoToolCommand = scheduleRepoToolCommand,
): Promise<never> {
  if (!Number.isFinite(Date.parse(sendAt))) context.output({ ok: false, error: "invalid-sendAt" });
  await logger.info(`telegram tool schedule_message recipient=${recipientLabel || recipientId} sendAt=${sendAt} chars=${content.length} content=${context.logTextContent(content)}`);
  const scheduled = scheduleCommand(context.config, "telegram:send-message", {
    requesterUserId,
    recipientId,
    recipientLabel,
    content,
  }, sendAt);
  if (!scheduled.ok) context.output(scheduled);
  await logger.info(`telegram tool schedule_message delegated recipient=${recipientLabel || recipientId} scheduler=${scheduled.scheduler} handle=${scheduled.handle} sendAt=${sendAt}`);
  context.output({ ok: true, scheduled: true, recipientId, recipientLabel, sendAt, scheduler: scheduled.scheduler, handle: scheduled.handle });
}

function requireOutboundRequester(context: RepoToolContext): number {
  const requesterUserId = context.asInt(context.args.requesterUserId);
  const accessLevel = accessLevelForUser(context.config, requesterUserId);
  if (!requesterUserId || !hasAccessLevel(accessLevel, "trusted")) {
    context.output({ ok: false, error: "outbound-delivery-not-allowed" });
  }
  return requesterUserId;
}

function resolveImmediateMessageRecipient(context: RepoToolContext): { recipientId: number; recipientLabel: string; mode: "outbound" } {
  const directRecipientId = context.asInt(context.args.recipientId);
  if (directRecipientId != null) {
    requireOutboundRequester(context);
    return {
      recipientId: directRecipientId,
      recipientLabel: context.cleanText(context.args.recipientLabel) || String(directRecipientId),
      mode: "outbound",
    };
  }

  context.output({ ok: false, error: "missing-recipientId-for-message" });
}

function resolveTelegramRecipient(context: RepoToolContext): { recipientKind: "user" | "chat"; recipientId: number; recipientLabel: string } {
  const recipientKind = context.cleanText(context.args.recipientKind);
  const recipientId = context.asInt(context.args.recipientId);
  if ((recipientKind !== "user" && recipientKind !== "chat") || !recipientId) context.output({ ok: false, error: "invalid-recipientKind-or-recipientId" });
  return { recipientKind, recipientId, recipientLabel: context.cleanText(context.args.recipientLabel) || `${recipientKind}:${recipientId}` };
}

export async function handleTelegramResolveRecipient(context: RepoToolContext): Promise<never> {
  const directId = context.asInt(context.args.id) ?? context.asInt(context.args.recipientId);
  const username = context.cleanText(context.args.username)?.replace(/^@+/, "");
  const displayName = context.cleanText(context.args.displayName);
  const title = context.cleanText(context.args.title);
  const targetLabel = username ? `@${username}` : displayName || title || (typeof directId === "number" ? String(directId) : "?");
  context.logInfo(`telegram:resolve-recipient: looking up ${targetLabel}`);
  const matchedChats = findTelegramChats({ id: directId, username, title, displayName }).filter((chat) => chat.type !== "private");
  const matchedUsers = findTelegramUsers({ id: directId, username, displayName }, listAuthorizedUserIds(context.config));
  const candidates = [
    ...matchedChats.map((chat) => ({ recipientKind: "chat" as const, recipientId: chat.id, recipientLabel: chat.title || String(chat.id) })),
    ...matchedUsers.map((user) => ({ recipientKind: "user" as const, recipientId: user.id, recipientLabel: user.username ? `${user.displayName} (@${user.username})` : user.displayName })),
  ];
  if (candidates.length === 1) {
    context.output({ ok: true, status: "resolved", ...candidates[0] });
  }
  if (candidates.length > 1) {
    context.logWarn(`telegram:resolve-recipient: ambiguous match for ${targetLabel}`);
    context.output({ ok: false, status: "ambiguous", error: "ambiguous-recipient", targetLabel, candidates: candidates.slice(0, 10) });
  }
  context.logWarn(`telegram:resolve-recipient: no match for ${targetLabel}`);
  context.output({ ok: false, status: "not_found", error: "recipient-not-found", targetLabel });
}

export async function handleTelegramSendMessage(context: RepoToolContext): Promise<never> {
  const content = context.cleanText(context.args.content);
  if (!content) context.output({ ok: false, error: "missing-content" });
  const { recipientId, recipientLabel, mode } = resolveImmediateMessageRecipient(context);
  context.logInfo(`telegram:send-message: sending to ${recipientLabel}`);
  await logger.info(`telegram tool send_message mode=${mode} recipient=${recipientLabel} chars=${content.length} content=${context.logTextContent(content)}`);
  const result = await deliverTelegramMessage(context, recipientId, content, recipientLabel);
  await logger.info(`telegram tool send_message delivered mode=${mode} recipient=${recipientLabel} messageId=${result.messageId ?? "unknown"}`);
  context.output({ ...result, mode });
}

export async function handleTelegramScheduleMessage(context: RepoToolContext): Promise<never> {
  const requesterUserId = requireOutboundRequester(context);
  const { recipientId, recipientLabel } = resolveTelegramRecipient(context);
  const content = context.cleanText(context.args.content);
  const sendAt = context.cleanText(context.args.sendAt);
  if (!content || !sendAt) context.output({ ok: false, error: "missing-content-or-sendAt" });
  context.logInfo(`telegram:schedule-message: scheduling for ${recipientLabel} at ${sendAt}`);
  return await scheduleTelegramMessage(context, recipientId, content, sendAt, recipientLabel, requesterUserId);
}

export async function handleTelegramSendFile(context: RepoToolContext): Promise<never> {
  requireOutboundRequester(context);
  const { recipientId, recipientLabel } = resolveTelegramRecipient(context);
  const filePath = context.cleanText(context.args.filePath);
  if (!filePath) context.output({ ok: false, error: "missing-filePath" });
  context.logInfo(`telegram:send-file: sending ${filePath} to ${recipientLabel}`);
  context.output(await deliverTelegramFile(context, recipientId, filePath, context.cleanText(context.args.caption), recipientLabel));
}
