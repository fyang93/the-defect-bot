import type { Context } from "grammy";
import { logger } from "bot/app/logger";
import type { AiService } from "bot/ai";
import type { RequestAccessRole } from "bot/ai/prompt";
import type { AiTurnResult, AssistantProgressHandler } from "bot/ai/types";
import type { AiAttachment, AppConfig, UploadedFile } from "bot/app/types";

export type AssistantTurnResult = {
  message: string;
  files: string[];
  attachments: AiAttachment[];
  facts: string[];
  hasSideEffectfulActions: boolean;
  completedActions: string[];
};

export type ExecuteAssistantActionsInput = {
  config: AppConfig;
  agentService: AiService;
  answer?: AiTurnResult;
  ctx: Context;
  requesterUserId?: number;
  uploadedFiles?: UploadedFile[];
  attachments?: AiAttachment[];
  messageTime?: string;
  requesterTimezone?: string | null;
  canDeliverOutbound: boolean;
  accessRole: RequestAccessRole;
  userRequestText: string;
  sharedConversationContextText?: string;
  scopeKey?: string;
  scopeLabel?: string;
  isTaskCurrent?: () => boolean;
  onProgress?: AssistantProgressHandler;
};

function looksLikeOutboundTelegramRequest(text: string): boolean {
  return /(?:给|向).{1,40}(?:发|发送|打个?招呼|问候|告诉|转发)|(?:send|message|tell|greet)\s+.{1,40}/i.test(text);
}

function outboundRetryPrompt(text: string): string {
  return `${text}\n\nSystem correction: this is an outbound Telegram delivery request. Use telegram_list_recipients with a query, then telegram_send_message. Do not reply as the recipient in the current chat; if the recipient list is empty or ambiguous, report that result.`;
}

export async function executeAssistantActions(input: ExecuteAssistantActionsInput): Promise<AssistantTurnResult> {
  const assistantStartedAt = Date.now();
  const taskStillCurrent = () => (input.isTaskCurrent ? input.isTaskCurrent() : true);

  let planned = await input.agentService.runAssistantTurn({
    userRequestText: input.userRequestText,
    requesterUserId: input.requesterUserId,
    chatId: input.ctx.chat?.id,
    chatType: input.ctx.chat?.type,
    accessRole: input.accessRole,
    uploadedFiles: input.uploadedFiles || [],
    attachments: input.attachments || [],
    messageTime: input.messageTime,
    requesterTimezone: input.requesterTimezone,
    sharedConversationContextText: input.sharedConversationContextText,
    scopeKey: input.scopeKey,
    scopeLabel: input.scopeLabel,
    isTaskCurrent: taskStillCurrent,
    onProgress: input.onProgress,
  });

  if (taskStillCurrent() && input.canDeliverOutbound && !planned.usedNativeExecution && looksLikeOutboundTelegramRequest(input.userRequestText)) {
    await logger.warn("assistant outbound delivery request completed without tool use; retrying with explicit delivery instruction");
    planned = await input.agentService.runAssistantTurn({
      userRequestText: outboundRetryPrompt(input.userRequestText),
      requesterUserId: input.requesterUserId,
      chatId: input.ctx.chat?.id,
      chatType: input.ctx.chat?.type,
      accessRole: input.accessRole,
      uploadedFiles: input.uploadedFiles || [],
      attachments: input.attachments || [],
      messageTime: input.messageTime,
      requesterTimezone: input.requesterTimezone,
      sharedConversationContextText: input.sharedConversationContextText,
      scopeKey: input.scopeKey,
      scopeLabel: input.scopeLabel,
      isTaskCurrent: taskStillCurrent,
      onProgress: input.onProgress,
    });
  }

  if (!taskStillCurrent()) {
    await logger.warn("assistant agent result ignored because task is stale");
    return { message: "", files: [], attachments: [], facts: [], hasSideEffectfulActions: false, completedActions: planned.completedActions || [] };
  }

  await logger.info(`assistant agent actions interpreted usedNativeExecution=${planned.usedNativeExecution ? "yes" : "no"} actions=${JSON.stringify(planned.completedActions)}`);

  if (!planned.usedNativeExecution) {
    await logger.warn(`assistant agent completed without recognized execution parts rawMessage=${JSON.stringify(planned.message)}`);
  }

  const message = planned.message.trim();
  const files = Array.isArray(planned.files) ? planned.files : [];
  const attachments = Array.isArray(planned.attachments) ? planned.attachments : [];
  await logger.info(`assistant agent total ms=${Date.now() - assistantStartedAt} sideEffects=native-execution actions=${JSON.stringify(planned.completedActions)}`);
  return {
    message,
    files,
    attachments,
    facts: [],
    hasSideEffectfulActions: true,
    completedActions: planned.completedActions || [],
  };
}

export type ActionExecutionResult = AssistantTurnResult;
