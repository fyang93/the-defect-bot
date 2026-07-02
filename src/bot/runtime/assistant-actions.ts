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

function looksLikeExplicitRememberRequest(text: string): boolean {
  return /(?:记住|记录一下|帮我记(?:一下)?|替我记(?:一下)?|保存到记忆|记到记忆|remember this|save this|record this)/i.test(text);
}

function outboundRetryPrompt(text: string): string {
  return `${text}\n\nRetry: the previous response missed the required outbound-delivery tool path. Follow AGENTS.md tool routing for this same request.`;
}

function memoryRetryPrompt(text: string): string {
  return `${text}\n\nRetry: the previous response missed the required durable-memory tool path. Follow AGENTS.md tool routing for this same request.`;
}

export async function executeAssistantActions(input: ExecuteAssistantActionsInput): Promise<AssistantTurnResult> {
  const assistantStartedAt = Date.now();
  const taskStillCurrent = () => (input.isTaskCurrent ? input.isTaskCurrent() : true);

  const canPersistMemory = input.accessRole === "admin" || input.accessRole === "trusted";

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

  if (taskStillCurrent() && canPersistMemory && !planned.completedActions?.includes("user_record_person") && looksLikeExplicitRememberRequest(input.userRequestText)) {
    await logger.warn("assistant memory request completed without user_record_person; retrying with explicit memory instruction");
    planned = await input.agentService.runAssistantTurn({
      userRequestText: memoryRetryPrompt(input.userRequestText),
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
