import { logger } from "bot/app/logger";
import type { AiService } from "bot/ai";
import type { AiTurnResult, AssistantProgressHandler, AssistantTextDeltaHandler } from "bot/ai/types";
import type { AiAttachment, AppConfig, UploadedFile } from "bot/app/types";

export type AssistantTurnResult = { message: string; files: string[]; attachments: AiAttachment[]; facts: string[]; hasSideEffectfulActions: boolean; completedActions: string[] };
export type ExecuteAssistantActionsInput = {
  config: AppConfig;
  agentService: AiService;
  answer?: AiTurnResult;
  requesterUserId?: string;
  chatId?: string;
  chatType?: string;
  uploadedFiles?: UploadedFile[];
  attachments?: AiAttachment[];
  messageTime?: string;
  requesterTimezone?: string | null;
  userRequestText: string;
  sharedConversationContextText?: string;
  scopeKey?: string;
  scopeLabel?: string;
  isTaskCurrent?: () => boolean;
  onProgress?: AssistantProgressHandler;
  onTextDelta?: AssistantTextDeltaHandler;
};

function outboundRequest(text: string): boolean { return /(?:给|向).{1,40}(?:发|发送|打个?招呼|问候|告诉|转发)|(?:send|message|tell|greet)\s+.{1,40}/i.test(text); }
function rememberRequest(text: string): boolean { return /(?:记住|记录一下|帮我记(?:一下)?|替我记(?:一下)?|保存到记忆|记到记忆|remember this|save this|record this)/i.test(text); }

export async function executeAssistantActions(input: ExecuteAssistantActionsInput): Promise<AssistantTurnResult> {
  const current = () => input.isTaskCurrent?.() ?? true;
  const run = (text: string) => input.agentService.runAssistantTurn({
    userRequestText: text, requesterUserId: input.requesterUserId, chatId: input.chatId, chatType: input.chatType,
    permissionMode: "full", uploadedFiles: input.uploadedFiles || [], attachments: input.attachments || [], messageTime: input.messageTime,
    requesterTimezone: input.requesterTimezone, sharedConversationContextText: input.sharedConversationContextText,
    scopeKey: input.scopeKey, scopeLabel: input.scopeLabel, isTaskCurrent: current, onProgress: input.onProgress, onTextDelta: input.onTextDelta,
  });
  let planned = await run(input.userRequestText);
  if (current() && !planned.usedNativeExecution && outboundRequest(input.userRequestText)) {
    await logger.warn("assistant outbound request completed without tool use; retrying");
    planned = await run(`${input.userRequestText}\n\nRetry: use the Feishu recipient and delivery tools required by the assistant instructions.`);
  }
  if (current() && !planned.completedActions.includes("user_record_person") && rememberRequest(input.userRequestText)) {
    await logger.warn("assistant memory request completed without durable tool use; retrying");
    planned = await run(`${input.userRequestText}\n\nRetry: use user_record_person to persist this durable memory.`);
  }
  if (!current()) return { message: "", files: [], attachments: [], facts: [], hasSideEffectfulActions: false, completedActions: planned.completedActions };
  return { message: planned.message.trim(), files: planned.files || [], attachments: planned.attachments || [], facts: [], hasSideEffectfulActions: planned.usedNativeExecution, completedActions: planned.completedActions };
}

export type ActionExecutionResult = AssistantTurnResult;
