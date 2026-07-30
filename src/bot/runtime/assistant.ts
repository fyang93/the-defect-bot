import type { LarkChannel, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { AppConfig, AiAttachment, UploadedFile } from "bot/app/types";
import type { AiService } from "bot/ai";
import type { AssistantProgressHandler, AssistantTextDeltaHandler } from "bot/ai/types";
import { logger } from "bot/app/logger";
import { buildAssistantContextBlock, lookupRequesterTimezone } from "bot/operations/context/assistant";
import { executeAssistantActions } from "./assistant-actions";
import { feishuOutputFilesFromText, sendFeishuOutputFiles } from "bot/feishu/transport";

export type ActiveConversationTask = { id: number; userId: string; scopeKey: string; scopeLabel: string; chatId: string; sourceMessageId: string; cancelled: boolean };
export type RunAssistantTaskDeps = {
  config: AppConfig; channel: LarkChannel; message: NormalizedMessage; task: ActiveConversationTask;
  promptText: string; uploadedFiles: UploadedFile[]; attachments: AiAttachment[]; messageTime?: string; agentService: AiService;
  isTaskCurrent: (scopeKey: string, taskId: number) => boolean; onProgress?: AssistantProgressHandler; onReleaseActiveTask: (scopeKey: string, taskId: number) => void;
};

export function userFacingAssistantError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|authentication|invalid bearer|invalid api key|oauth/i.test(message)) {
    return "Pi 模型鉴权失败。请在 `just agent` 中重新登录模型服务，或通过“切换模型”选择已正确配置的模型。";
  }
  if (/429|rate.?limit|quota/i.test(message)) return "Pi 模型当前额度不足或请求过于频繁，请稍后重试或切换模型。";
  return `处理失败：${message.slice(0, 500)}`;
}

export async function runAssistantTask(deps: RunAssistantTaskDeps): Promise<void> {
  const { config, channel, message, task } = deps;
  let streamMessageId: string | undefined;
  try {
    const assistantContext = await buildAssistantContextBlock(config, { requesterUserId: task.userId, chatId: task.chatId, messageTime: deps.messageTime });
    const source = `Feishu source: senderOpenId=${task.userId} chatId=${task.chatId} messageId=${task.sourceMessageId} rootId=${message.rootId || "-"} threadId=${message.threadId || "-"} replyToMessageId=${message.replyToMessageId || "-"}`;
    let result: Awaited<ReturnType<typeof executeAssistantActions>> | undefined;
    const streamResult = await channel.stream(task.chatId, {
      markdown: async (stream) => {
        streamMessageId = stream.messageId;
        let updates = Promise.resolve();
        let streamedText = "";
        let finalizing = false;
        const onProgress: AssistantProgressHandler = (status) => {
          void Promise.resolve(deps.onProgress?.(status)).catch((error) => {
            void logger.warn(`external assistant progress handler failed: ${error instanceof Error ? error.message : String(error)}`);
          });
          if (finalizing || streamedText || !status.trim()) return;
          updates = updates.then(() => stream.setContent(status)).catch((error) => {
            void logger.warn(`Feishu waiting message update failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        };
        const onTextDelta: AssistantTextDeltaHandler = (delta) => {
          if (finalizing || !delta) return;
          const first = !streamedText;
          streamedText += delta;
          updates = updates.then(() => first ? stream.setContent(delta) : stream.append(delta)).catch((error) => {
            void logger.warn(`Feishu assistant stream update failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        };
        result = await executeAssistantActions({
          config, agentService: deps.agentService, requesterUserId: task.userId, chatId: task.chatId, chatType: message.chatType,
          uploadedFiles: deps.uploadedFiles, attachments: deps.attachments, messageTime: deps.messageTime,
          requesterTimezone: lookupRequesterTimezone(config, task.userId), userRequestText: `${deps.promptText}\n\n${source}`,
          sharedConversationContextText: assistantContext, scopeKey: task.scopeKey, scopeLabel: task.scopeLabel,
          isTaskCurrent: () => !task.cancelled && deps.isTaskCurrent(task.scopeKey, task.id), onProgress, onTextDelta,
        });
        await updates;
        if (task.cancelled || !deps.isTaskCurrent(task.scopeKey, task.id)) return;
        finalizing = true;
        const finalText = result.message || "处理完成。";
        if (streamedText.trim() !== finalText.trim()) await stream.setContent(finalText);
      },
    }, { replyTo: task.sourceMessageId, replyInThread: Boolean(message.threadId) });
    streamMessageId = streamResult.messageId || streamMessageId;
    if (task.cancelled || !deps.isTaskCurrent(task.scopeKey, task.id)) {
      if (streamMessageId) await channel.recallMessage(streamMessageId).catch(() => undefined);
      return;
    }
    if (!result) throw new Error("Assistant stream completed without a result.");
    const outputFiles = [...result.files, ...feishuOutputFilesFromText(result.message)];
    if (outputFiles.length) await sendFeishuOutputFiles(channel, task.chatId, config, outputFiles);
    await channel.addReaction(task.sourceMessageId, "THUMBSUP").catch(() => undefined);
    await logger.info(`assistant task ${task.id} completed scope=${JSON.stringify(task.scopeKey)} chars=${result.message.length}`);
  } catch (error) {
    if (streamMessageId) await channel.recallMessage(streamMessageId).catch(() => undefined);
    await logger.warn(`assistant task ${task.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!task.cancelled && deps.isTaskCurrent(task.scopeKey, task.id)) {
      await channel.send(task.chatId, { markdown: userFacingAssistantError(error) }, { replyTo: task.sourceMessageId, replyInThread: Boolean(message.threadId) }).catch(() => undefined);
      await channel.addReaction(task.sourceMessageId, "CrossMark").catch(() => undefined);
    }
  } finally { deps.onReleaseActiveTask(task.scopeKey, task.id); }
}
