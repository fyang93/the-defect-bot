import type { Context } from "grammy";
import type { AppConfig, AiAttachment, UploadedFile } from "bot/app/types";
import type { AiService } from "bot/ai";
import { logger } from "bot/app/logger";
import { executeAssistantActions, type ExecuteAssistantActionsInput } from "./assistant-actions";
import { buildTelegramRequestContext } from "bot/telegram/identity";
import { buildAssistantContextBlock, lookupRequesterTimezone } from "bot/operations/context/assistant";
import { accessLevelForUserId, hasAccessLevel } from "bot/operations/access/control";
import { replyFormatted } from "bot/telegram/format";
import { deliverAiOutputs } from "./conversations/output";

export type ActiveConversationTask = {
  id: number;
  userId?: number;
  scopeKey: string;
  scopeLabel: string;
  chatId: number;
  sourceMessageId: number;
  waitingMessageId?: number;
  cancelled: boolean;
};

async function prepareAssistantContext(config: AppConfig, input: {
  requesterUserId?: number;
  chatId: number;
  messageTime?: string;
}): Promise<{ assistantContextText: string; requesterTimezone: string | null }> {
  const assistantContextText = await buildAssistantContextBlock(config, {
    requesterUserId: input.requesterUserId,
    chatId: input.chatId,
    messageTime: input.messageTime,
  });
  return {
    assistantContextText,
    requesterTimezone: lookupRequesterTimezone(config, input.requesterUserId),
  };
}

export type RunAssistantTaskDeps = {
  config: AppConfig;
  ctx: Context;
  task: ActiveConversationTask;
  promptText: string;
  uploadedFiles: UploadedFile[];
  attachments: AiAttachment[];
  messageTime?: string;
  agentService: AiService;
  isTaskCurrent: (scopeKey: string, taskId: number) => boolean;
  onPruneRecentUploads: (scopeKey: string) => Promise<void>;
  onStopWaiting: (task: ActiveConversationTask) => void;
  onSetReaction: (ctx: Context, emoji: string) => Promise<void>;
  onReleaseActiveTask: (scopeKey: string, taskId: number) => void;
};

// Single-lane assistant: executes native capabilities / direct tool operations and runtime publishes current-turn replies.
export async function runAssistantTask(deps: RunAssistantTaskDeps): Promise<void> {
  const {
    config,
    ctx,
    task,
    promptText,
    uploadedFiles,
    attachments,
    messageTime,
    agentService,
    isTaskCurrent,
    onPruneRecentUploads,
    onStopWaiting,
    onSetReaction,
    onReleaseActiveTask,
  } = deps;

  const userId = task.userId;
  const requesterAccessLevel = accessLevelForUserId(config, userId);
  const accessRole = requesterAccessLevel === "admin"
    ? "admin"
    : requesterAccessLevel === "trusted"
      ? "trusted"
      : "allowed";
  const telegramRequestContext = buildTelegramRequestContext(config, ctx);
  const effectivePromptText = telegramRequestContext ? `${promptText}\n\n${telegramRequestContext}` : promptText;
  const taskStartedAt = Date.now();

  try {
    const { assistantContextText, requesterTimezone } = await prepareAssistantContext(config, {
      requesterUserId: userId,
      chatId: task.chatId,
      messageTime,
    });
    logger.info(`assistant task ${task.id} role=assistant state=start scope=${JSON.stringify(task.scopeKey)} accessRole=${accessRole} uploadedFiles=${uploadedFiles.length} attachments=${attachments.length} promptChars=${effectivePromptText.length}`);

    const startedAt = Date.now();
    const result = await executeAssistantActions({
      config,
      agentService,
      ctx,
      requesterUserId: userId,
      uploadedFiles,
      attachments,
      messageTime,
      requesterTimezone,
      canDeliverOutbound: hasAccessLevel(accessRole, "trusted"),
      accessRole,
      userRequestText: effectivePromptText,
      sharedConversationContextText: assistantContextText,
      scopeKey: task.scopeKey,
      scopeLabel: task.scopeLabel,
      isTaskCurrent: () => !task.cancelled,
    } satisfies ExecuteAssistantActionsInput);
    const assistantMs = Date.now() - startedAt;

    if (!isTaskCurrent(task.scopeKey, task.id) || task.cancelled) {
      await logger.warn(`assistant task ${task.id} stale after assistant phase`);
      return;
    }

    logger.info(`assistant task ${task.id} role=assistant state=done ms=${assistantMs} messageChars=${result.message.length} facts=${result.facts.length} actions=${JSON.stringify(result.completedActions)}`);

    const outputStartedAt = Date.now();
    onStopWaiting(task);
    if (typeof task.waitingMessageId === "number") {
      await ctx.api.deleteMessage(task.chatId, task.waitingMessageId).catch(() => {});
    }
    if (result.message.trim()) {
      await replyFormatted(ctx, result.message);
      await logger.info(`assistant fallback reply send chars=${result.message.trim().length} content=${JSON.stringify(result.message.trim())}`);
    }
    await deliverAiOutputs(ctx, config, {
      message: result.message,
      files: result.files,
      attachments: result.attachments,
    });
    const outputMs = Date.now() - outputStartedAt;

    await onPruneRecentUploads(task.scopeKey);
    await onSetReaction(ctx, "🥰");
    logger.info(`assistant task ${task.id} completed totalMs=${Date.now() - taskStartedAt} assistantMs=${assistantMs} outputMs=${outputMs}`);
  } catch (error) {
    onStopWaiting(task);
    if (typeof task.waitingMessageId === "number") {
      await ctx.api.deleteMessage(task.chatId, task.waitingMessageId).catch(() => {});
    }
    const message = error instanceof Error ? error.message : String(error);
    await logger.warn(`assistant task ${task.id} failed message=${message}`);
    if (isTaskCurrent(task.scopeKey, task.id) && !task.cancelled) {
      await onSetReaction(ctx, "😢");
    }
  } finally {
    onReleaseActiveTask(task.scopeKey, task.id);
  }
}
