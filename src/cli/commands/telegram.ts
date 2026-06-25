import { readFileSync } from "node:fs";
import path from "node:path";
import { Bot } from "grammy";
import { sendMessageFormatted } from "bot/telegram/format";
import { sendTelegramLocalFile } from "bot/telegram/delivery";
import { listMatchingTelegramRecipients } from "bot/operations/recipients/resolve";
import { accessLevelForUser } from "bot/operations/access/roles";
import { hasAccessLevel } from "bot/operations/access/control";
import { logger } from "bot/app/logger";
import type { RepoCliContext } from "cli/runtime";

async function deliverTelegramMessage(context: RepoCliContext, recipientId: number, content: string, recipientLabel?: string): Promise<{ ok: true; delivered: true; recipientId: number; recipientLabel?: string; messageId?: number }> {
  await logger.info(`telegram tool send_message recipient=${recipientLabel || recipientId} chars=${content.length} content=${context.logTextContent(content)}`);
  const bot = new Bot(context.config.telegram.botToken);
  const result = await sendMessageFormatted(bot as any, recipientId, content);
  const messageId = typeof result === "object" && result && "message_id" in (result as Record<string, unknown>) ? Number((result as Record<string, unknown>).message_id) : undefined;
  await logger.info(`telegram tool send_message delivered recipient=${recipientLabel || recipientId} messageId=${messageId ?? "unknown"}`);
  return { ok: true, delivered: true, recipientId, recipientLabel, messageId };
}

async function deliverTelegramFile(context: RepoCliContext, recipientId: number, filePath: string, caption?: string, recipientLabel?: string): Promise<{ ok: true; delivered: true; recipientId: number; recipientLabel?: string; messageId?: number; filePath: string }> {
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


function requireOutboundRequester(context: RepoCliContext): number {
  const requesterUserId = context.asInt(context.args.requesterUserId);
  const accessLevel = accessLevelForUser(context.config, requesterUserId);
  if (!requesterUserId || !hasAccessLevel(accessLevel, "trusted")) {
    context.output({ ok: false, error: "outbound-delivery-not-allowed" });
  }
  return requesterUserId;
}

function resolveImmediateMessageRecipient(context: RepoCliContext): { recipientId: number; recipientLabel: string; mode: "outbound" } {
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

function resolveTelegramRecipient(context: RepoCliContext): { recipientKind?: "user" | "chat"; recipientId: number; recipientLabel: string } {
  const recipientKind = context.cleanText(context.args.recipientKind);
  const recipientId = context.asInt(context.args.recipientId);
  if ((recipientKind && recipientKind !== "user" && recipientKind !== "chat") || !recipientId) context.output({ ok: false, error: "invalid-recipientId" });
  return { recipientKind: recipientKind as "user" | "chat" | undefined, recipientId, recipientLabel: context.cleanText(context.args.recipientLabel) || String(recipientId) };
}


export async function handleTelegramListRecipients(context: RepoCliContext): Promise<never> {
  const query = context.cleanText(context.args.query);
  const kind = context.cleanText(context.args.kind) || (query ? "all" : "groups");
  if (kind !== "groups" && kind !== "users" && kind !== "all") context.output({ ok: false, error: "invalid-recipient-kind" });
  context.output({ ok: true, status: "list", recipients: listMatchingTelegramRecipients(context.config, { query, kind }) });
}


export async function handleTelegramSendMessage(context: RepoCliContext): Promise<never> {
  const content = context.cleanText(context.args.content);
  if (!content) context.output({ ok: false, error: "missing-content" });
  const { recipientId, recipientLabel, mode } = resolveImmediateMessageRecipient(context);
  context.logInfo(`telegram:send-message: sending to ${recipientLabel}`);
  await logger.info(`telegram tool send_message mode=${mode} recipient=${recipientLabel} chars=${content.length} content=${context.logTextContent(content)}`);
  const result = await deliverTelegramMessage(context, recipientId, content, recipientLabel);
  await logger.info(`telegram tool send_message delivered mode=${mode} recipient=${recipientLabel} messageId=${result.messageId ?? "unknown"}`);
  context.output({ ...result, mode });
}


export async function handleTelegramSendFile(context: RepoCliContext): Promise<never> {
  requireOutboundRequester(context);
  const { recipientId, recipientLabel } = resolveTelegramRecipient(context);
  const filePath = context.cleanText(context.args.filePath);
  if (!filePath) context.output({ ok: false, error: "missing-filePath" });
  context.logInfo(`telegram:send-file: sending ${filePath} to ${recipientLabel}`);
  context.output(await deliverTelegramFile(context, recipientId, filePath, context.cleanText(context.args.caption), recipientLabel));
}
