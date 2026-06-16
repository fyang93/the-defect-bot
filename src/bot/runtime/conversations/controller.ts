import type { Bot, Context } from "grammy";
import type { AppConfig, AiAttachment, UploadedFile } from "bot/app/types";
import { logger } from "bot/app/logger";

import { getAccurateNowIso } from "bot/app/time";
import {
  clearRecentUploads,
  getRecentClarification,
  getUserTimezone,
  touchActivity,
} from "bot/app/state";
import { accessLevelForUserId, canUseFiles } from "bot/operations/access/control";
import { normalizeScheduledAt } from "bot/operations/events";
import type { AiService } from "bot/ai";
import { runAssistantTask, type ActiveConversationTask } from "bot/runtime";
import { WAITING_MESSAGE_PLACEHOLDER } from "./constants";
import { rememberTelegramParticipants } from "bot/telegram/identity";
import { buildTelegramReplyContextBlock, summarizeIncomingText, telegramReplySummary } from "bot/telegram/reply_context";
import { saveTelegramFileFromMessage, uploadedFileToAiAttachment } from "bot/telegram/transport";
import { ingestTelegramFile, logFilePromptScheduling } from "bot/telegram/ingress";
import { ActiveConversationTasks } from "./active";
import { buildRecentAttachments, pruneRecentUploads } from "bot/telegram/recent";
import { CosmeticTelegramFeedback } from "./cosmetic-feedback";

type ConversationControllerDeps = {
  config: AppConfig;
  bot: Bot<Context>;
  agentService: AiService;
  isAddressedToBot: (ctx: Context) => boolean;
};

type AnyRecord = Record<string, unknown>;

type MediaGroupEntry = {
  uploaded: UploadedFile;
  attachment: AiAttachment;
};

function explicitClockTimeDetail(text: string): string | null {
  const trimmed = text.trim();
  const colon = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  const compact = trimmed.match(/^(\d{1,2})(\d{2})$/);
  const hour = Number(colon?.[1] || compact?.[1]);
  const minute = Number(colon?.[2] || compact?.[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function localDateAtIso(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function deterministicClockTimeContext(text: string, requesterUserId: number | undefined, messageTime: string | undefined, defaultTimezone: string): string | null {
  const localClockTime = explicitClockTimeDetail(text);
  if (!localClockTime) return null;
  const timezone = getUserTimezone(requesterUserId)?.trim() || defaultTimezone;
  const referenceIso = messageTime || new Date().toISOString();
  const localDate = localDateAtIso(referenceIso, timezone);
  const resolvedUtc = normalizeScheduledAt(`${localDate}T${localClockTime}:00`, timezone);
  return [
    `Deterministic parsed time detail: the current user message is an explicit local clock time meaning ${localClockTime} in the requester timezone ${timezone}.`,
    `Deterministic resolved local date for this turn: ${localDate}.`,
    `Deterministic UTC timestamp for that local date and time: ${resolvedUtc}.`,
  ].join("\n");
}

type ConversationTurnInput = {
  waitingTemplate: string;
  promptText: string;
  uploadedFiles: UploadedFile[];
  attachments: AiAttachment[];
  messageTime?: string;
};

type ConversationTurnSlot = {
  taskId: number;
  phase: "collecting" | "running";
  userId?: number;
  scopeKey: string;
  scopeLabel: string;
  ctx: Context;
  input: ConversationTurnInput;
  openedAt: number;
  updatedAt: number;
  launchTimer?: ReturnType<typeof setTimeout>;
};

type MediaGroupCacheEntry = {
  files: Map<number, MediaGroupEntry>;
  updatedAt: number;
};

const MEDIA_GROUP_CACHE_TTL_MS = 60 * 60 * 1000;
const MEDIA_GROUP_CACHE_MAX_GROUPS = 200;
const STARTUP_COALESCE_MAX_MS = 500;
function isExpectedFileIngressError(message: string): boolean {
  return /file is too big|bot download limit|exceeds limit of/i.test(message);
}

function isTelegramBotApiFileLimitError(message: string): boolean {
  return /file is too big|bot download limit/i.test(message);
}

function renderWaitingMessage(template: string, waitingMessage: string): string {
  return template.includes(WAITING_MESSAGE_PLACEHOLDER)
    ? template.replaceAll(WAITING_MESSAGE_PLACEHOLDER, waitingMessage)
    : waitingMessage;
}

function contactPromptText(ctx: Context): string {
  const contact = ctx.message && "contact" in ctx.message ? ctx.message.contact : undefined;
  if (!contact) return "";
  const replyContext = buildTelegramReplyContextBlock(ctx);
  return [
    "The user shared a contact card.",
    replyContext,
    `First name: ${contact.first_name}`,
    contact.last_name ? `Last name: ${contact.last_name}` : "",
    `Phone number: ${contact.phone_number}`,
    typeof contact.user_id === "number" ? `Contact user id: ${contact.user_id}` : "",
    contact.vcard ? `vCard: ${contact.vcard}` : "",
    "Use this contact information and any reply context when answering or updating memory.",
  ].filter(Boolean).join("\n");
}

export class ConversationController {
  private nextTaskId = 1;
  private readonly activeTasks;
  private readonly feedback;
  private readonly mediaGroups = new Map<string, MediaGroupCacheEntry>();
  private readonly turns = new Map<string, ConversationTurnSlot>();

  constructor(private readonly deps: ConversationControllerDeps) {
    this.feedback = new CosmeticTelegramFeedback(this.deps.bot);
    this.activeTasks = new ActiveConversationTasks(
      this.deps.bot,
      this.deps.agentService,
      () => {},
      (chatId, messageId, emoji) => this.feedback.setReactionByMessageSafe(chatId, messageId, emoji),
    );
  }

  hasActiveTask(): boolean {
    return this.turns.size > 0 || this.activeTasks.hasAny();
  }

  async setReactionSafe(ctx: Context, emoji: string): Promise<void> {
    await this.feedback.setReactionSafe(ctx, emoji);
  }

  private conversationScope(ctx: Context): { key: string; label: string } {
    const chat = ctx.chat;
    const userId = ctx.from?.id;
    if (chat?.type === "group" || chat?.type === "supergroup") {
      const title = "title" in chat && typeof chat.title === "string" && chat.title.trim() ? chat.title.trim() : `chat ${chat.id}`;
      return { key: `chat:${chat.id}`, label: `group ${title}` };
    }
    if (typeof userId === "number") return { key: `user:${userId}`, label: `user ${userId}` };
    return { key: "global", label: "global" };
  }

  async interruptActiveTask(reason: string, scopeKey?: string, options?: { reactionEmoji?: string | null }): Promise<void> {
    const keys = scopeKey ? [scopeKey] : Array.from(this.turns.keys());
    for (const key of keys) {
      const turn = this.turns.get(key);
      if (!turn) continue;
      if (turn.launchTimer) clearTimeout(turn.launchTimer);
      this.turns.delete(key);
    }
    await this.activeTasks.interrupt(reason, scopeKey, options);
  }

  async editMessageTextFormattedSafe(ctx: Context, chatId: number, messageId: number, text: string, options?: { reply_markup?: unknown }): Promise<void> {
    await this.feedback.editMessageTextFormattedSafe(ctx, chatId, messageId, text, options);
  }

  async handleIncomingText(ctx: Context): Promise<void> {
    try {
      const incomingAt = Date.now();
      const text = ctx.message && "text" in ctx.message ? ctx.message.text?.trim() || "" : "";
      if (!text || text.startsWith("/")) return;
      if (!this.deps.isAddressedToBot(ctx)) return;

      touchActivity();
      rememberTelegramParticipants(this.deps.config, ctx);
      const scope = this.conversationScope(ctx);
      const { files: validRecentUploads, attachments } = await buildRecentAttachments(scope.key);
      const replyContext = await this.repliedMessageContext(ctx);
      const allUploadedFiles = [...validRecentUploads, ...replyContext.uploadedFiles];
      const allAttachments = [...attachments, ...replyContext.attachments];
      if (validRecentUploads.length > 0) clearRecentUploads(scope.key);
      const messageTime = await this.messageReferenceTime(ctx);
      const recentClarification = getRecentClarification(scope.key);
      const deterministicTimeContext = recentClarification ? deterministicClockTimeContext(text, ctx.from?.id, messageTime, this.deps.config.bot.defaultTimezone) : null;
      const effectiveText = [
        "Current user message:",
        text,
        "",
        replyContext.text || "",
        recentClarification
          ? [
              "Recent clarification context:",
              `Previous user request: ${recentClarification.requestText}`,
              `Previous assistant clarification: ${recentClarification.clarificationMessage}`,
              "Treat the current user message as a likely answer to that clarification when it fits.",
              deterministicTimeContext || "",
            ].filter(Boolean).join("\n")
          : "",
      ].filter(Boolean).join("\n");
      await logger.info(`received text message chat=${ctx.chat?.id ?? "unknown"} chatType=${ctx.chat?.type ?? "unknown"} user=${ctx.from?.id ?? "unknown"} message=${ctx.message?.message_id ?? "unknown"} text=${JSON.stringify(summarizeIncomingText(text))}${telegramReplySummary(ctx)} replyContextIncluded=${replyContext.text ? "yes" : "no"} replyFiles=${replyContext.uploadedFiles.length}`);
      const restarted = await this.restartActiveConversationIfMergeable(ctx, scope, {
        promptText: effectiveText,
        uploadedFiles: allUploadedFiles,
        attachments: allAttachments,
        messageTime,
      }, incomingAt);
      if (restarted) return;
      this.startConversationTask(ctx, WAITING_MESSAGE_PLACEHOLDER, effectiveText, allUploadedFiles, allAttachments, messageTime);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logger.error(`text handling failed: ${message}`);
      await this.setReactionSafe(ctx, "😢");
    }
  }

  async handleIncomingContact(ctx: Context): Promise<void> {
    if (this.deps.isAddressedToBot && !this.deps.isAddressedToBot(ctx) && ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) return;

    try {
      const promptText = contactPromptText(ctx);
      if (!promptText) return;
      touchActivity();
      rememberTelegramParticipants(this.deps.config, ctx);
      const messageTime = await this.messageReferenceTime(ctx);
      const contact = ctx.message && "contact" in ctx.message ? ctx.message.contact : undefined;
      await logger.info(`received contact message chat=${ctx.chat?.id ?? "unknown"} user=${ctx.from?.id ?? "unknown"} message=${ctx.message?.message_id ?? "unknown"} firstName=${JSON.stringify(contact?.first_name || "")} lastName=${JSON.stringify(contact?.last_name || "")} phoneNumber=${JSON.stringify(contact?.phone_number || "")} contactUserId=${contact?.user_id ?? "unknown"}${telegramReplySummary(ctx)}`);
      this.startConversationTask(ctx, WAITING_MESSAGE_PLACEHOLDER, promptText, [], [], messageTime);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logger.error(`contact handling failed: ${message}`);
      await this.setReactionSafe(ctx, "😢");
    }
  }

  async handleIncomingFile(ctx: Context): Promise<void> {
    const incomingAt = Date.now();
    const caption = ctx.message && "caption" in ctx.message ? ctx.message.caption?.trim() || "" : "";
    if (this.deps.isAddressedToBot && !this.deps.isAddressedToBot(ctx) && ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) return;

    const accessLevel = accessLevelForUserId(this.deps.config, ctx.from?.id);
    if (!canUseFiles(accessLevel)) {
      await logger.warn(`file upload rejected level=${accessLevel} user=${ctx.from?.id ?? "unknown"}`);
      await this.setReactionSafe(ctx, "😢");
      return;
    }

    const scope = this.conversationScope(ctx);
    try {
      const saved = await ingestTelegramFile(ctx, this.deps.config, scope.key);
      if (!saved) return;
      const { uploaded, attachment } = saved;
      this.rememberMediaGroupFile(ctx, uploaded, attachment);

      if (!caption) {
        clearRecentUploads(scope.key);
        const restarted = await this.restartActiveConversationIfMergeable(ctx, scope, {
          uploadedFiles: [uploaded],
          attachments: [attachment],
          messageTime: await this.messageReferenceTime(ctx),
        }, incomingAt);
        if (restarted) return;
        await this.setReactionSafe(ctx, "🥰");
        return;
      }

      const waitingTemplate = WAITING_MESSAGE_PLACEHOLDER;
      const messageTime = await this.messageReferenceTime(ctx);

      await logFilePromptScheduling(ctx, uploaded, caption);
      clearRecentUploads(scope.key);
      const restarted = await this.restartActiveConversationIfMergeable(ctx, scope, {
        promptText: caption,
        uploadedFiles: [uploaded],
        attachments: [attachment],
        messageTime,
      }, incomingAt);
      if (restarted) return;
      this.startConversationTask(ctx, waitingTemplate, caption, [uploaded], [attachment], messageTime);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isExpectedFileIngressError(message)) {
        await logger.warn(`file handling rejected: ${message}`);
      } else {
        await logger.error(`file handling failed: ${message}`);
      }
      if (isTelegramBotApiFileLimitError(message)) {
        await logger.warn(`file exceeded telegram bot api limit: ${message}`);
      }
      await this.setReactionSafe(ctx, "😢");
    }
  }

  async resetSession(ctx: Context): Promise<string> {
    const scope = this.conversationScope(ctx);
    await this.interruptActiveTask("/new command", scope.key);
    const sessionId = await this.deps.agentService.newSession(scope.key, scope.label);
    clearRecentUploads(scope.key);
    return sessionId;
  }

  private asRecord(value: unknown): AnyRecord | undefined {
    return value && typeof value === "object" ? value as AnyRecord : undefined;
  }

  private mediaGroupKey(chatId: number, mediaGroupId: string): string {
    return `${chatId}:${mediaGroupId}`;
  }

  private pruneMediaGroups(now = Date.now()): void {
    for (const [key, entry] of this.mediaGroups.entries()) {
      if (now - entry.updatedAt > MEDIA_GROUP_CACHE_TTL_MS) {
        this.mediaGroups.delete(key);
      }
    }
    if (this.mediaGroups.size <= MEDIA_GROUP_CACHE_MAX_GROUPS) return;
    const overflow = this.mediaGroups.size - MEDIA_GROUP_CACHE_MAX_GROUPS;
    const oldest = Array.from(this.mediaGroups.entries())
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      .slice(0, overflow);
    for (const [key] of oldest) this.mediaGroups.delete(key);
  }

  private rememberMediaGroupFile(ctx: Context, uploaded: UploadedFile, attachment: AiAttachment): void {
    const chatId = ctx.chat?.id;
    const message = this.asRecord(ctx.message);
    const mediaGroupId = typeof message?.media_group_id === "string" ? message.media_group_id : undefined;
    const messageId = typeof message?.message_id === "number" ? message.message_id : undefined;
    if (!chatId || !mediaGroupId || !messageId) return;
    const now = Date.now();
    this.pruneMediaGroups(now);
    const key = this.mediaGroupKey(chatId, mediaGroupId);
    const existing = this.mediaGroups.get(key) || { files: new Map<number, MediaGroupEntry>(), updatedAt: now };
    existing.files.set(messageId, { uploaded, attachment });
    existing.updatedAt = now;
    this.mediaGroups.set(key, existing);
  }

  private formatUploadedFileLine(uploaded: UploadedFile): string {
    return `- ${uploaded.savedPath} (${uploaded.mimeType}, ${Math.ceil(uploaded.sizeBytes / 1024)} KB, source=${uploaded.source}${typeof uploaded.durationSeconds === "number" ? `, duration=${uploaded.durationSeconds}s` : ""}${uploaded.audioTitle ? `, title=${JSON.stringify(uploaded.audioTitle)}` : ""}${uploaded.audioPerformer ? `, performer=${JSON.stringify(uploaded.audioPerformer)}` : ""})`;
  }

  private async repliedMessageContext(ctx: Context): Promise<{ text: string; uploadedFiles: UploadedFile[]; attachments: AiAttachment[] }> {
    const base = buildTelegramReplyContextBlock(ctx);
    const message = this.asRecord(ctx.message);
    const repliedMessage = this.asRecord(message?.reply_to_message);
    const chatId = ctx.chat?.id;
    if (!repliedMessage || !chatId) return { text: base, uploadedFiles: [], attachments: [] };

    const mediaGroupId = typeof repliedMessage.media_group_id === "string" ? repliedMessage.media_group_id : undefined;
    if (mediaGroupId) {
      this.pruneMediaGroups();
      const cached = this.mediaGroups.get(this.mediaGroupKey(chatId, mediaGroupId));
      if (cached && cached.files.size > 0) {
        const entries = Array.from(cached.files.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, entry]) => entry);
        const fileSummary = [
          "Reply-attached files saved for this request:",
          "The user is replying to these files from the replied message.",
          "Treat these files as the primary target of the current request unless the user clearly specifies another target.",
          ...entries.map((entry) => this.formatUploadedFileLine(entry.uploaded)),
          "Treat these saved files as the full file set contained in the replied media group.",
        ].join("\n");
        await logger.info(`resolved replied media group chat=${chatId} mediaGroupId=${mediaGroupId} files=${entries.length}`);
        return {
          text: [base, fileSummary].filter(Boolean).join("\n\n"),
          uploadedFiles: entries.map((entry) => entry.uploaded),
          attachments: entries.map((entry) => entry.attachment),
        };
      }
      await logger.warn(`replied media group cache miss chat=${chatId} mediaGroupId=${mediaGroupId}; falling back to the replied message only`);
    }

    const uploaded = await saveTelegramFileFromMessage(ctx, this.deps.config, repliedMessage);
    if (!uploaded) return { text: base, uploadedFiles: [], attachments: [] };

    const attachment = await uploadedFileToAiAttachment(uploaded);
    const fileSummary = [
      "Reply-attached files saved for this request:",
      "The user is replying to this file from the replied message.",
      "Treat this file as the primary target of the current request unless the user clearly specifies another target.",
      this.formatUploadedFileLine(uploaded),
      mediaGroupId
        ? "Treat this saved file as the replied media item. The full media group was not available in cache."
        : "Treat this saved file as the file contained in the replied message.",
    ].join("\n");
    await logger.info(`saved replied message file ${uploaded.savedPath}`);
    return {
      text: [base, fileSummary].filter(Boolean).join("\n\n"),
      uploadedFiles: [uploaded],
      attachments: [attachment],
    };
  }

  private async messageReferenceTime(ctx: Context): Promise<string> {
    const unixSeconds = ctx.message?.date;
    if (typeof unixSeconds === "number") return new Date(unixSeconds * 1000).toISOString();
    return getAccurateNowIso();
  }

  private mergePromptText(existing: string, incoming: string): string {
    const left = existing.trim();
    const right = incoming.trim();
    if (!right) return left;
    if (!left) return right;
    return `${left}\n\nFollow-up user message in the same turn:\n${right}`;
  }

  private startupCoalesceMs(): number {
    return Math.max(0, Math.min(STARTUP_COALESCE_MAX_MS, this.deps.config.telegram.inputMergeWindowSeconds * 1000));
  }

  private clearTurnIfCurrent(scopeKey: string, taskId: number): void {
    const turn = this.turns.get(scopeKey);
    if (!turn || turn.taskId !== taskId) return;
    if (turn.launchTimer) clearTimeout(turn.launchTimer);
    this.turns.delete(scopeKey);
  }

  private mergeTurnInput(current: ConversationTurnInput, update: { promptText?: string; uploadedFiles?: UploadedFile[]; attachments?: AiAttachment[]; messageTime?: string }): ConversationTurnInput {
    return {
      waitingTemplate: current.waitingTemplate,
      promptText: update.promptText ? this.mergePromptText(current.promptText, update.promptText) : current.promptText,
      uploadedFiles: [...current.uploadedFiles, ...(update.uploadedFiles || [])],
      attachments: [...current.attachments, ...(update.attachments || [])],
      messageTime: update.messageTime || current.messageTime,
    };
  }

  private canMergeIntoTurn(turn: ConversationTurnSlot, senderUserId: number | undefined, incomingAt: number): boolean {
    if (turn.userId !== senderUserId) return false;
    const ageMs = incomingAt - turn.updatedAt;
    const limitMs = turn.phase === "collecting"
      ? this.startupCoalesceMs()
      : this.deps.config.telegram.inputMergeWindowSeconds * 1000;
    if (ageMs > limitMs) return false;
    if (turn.phase === "collecting") return true;
    const activeTask = this.activeTasks.get(turn.scopeKey);
    if (!activeTask) return false;
    if (activeTask.cancelled || activeTask.id !== turn.taskId) return false;
    return true;
  }

  private async restartActiveConversationIfMergeable(
    ctx: Context,
    scope: { key: string; label: string },
    update: { promptText?: string; uploadedFiles?: UploadedFile[]; attachments?: AiAttachment[]; messageTime?: string },
    incomingAt = Date.now(),
  ): Promise<boolean> {
    const turn = this.turns.get(scope.key);
    if (!turn || !this.canMergeIntoTurn(turn, ctx.from?.id, incomingAt)) return false;
    const mergedInput = this.mergeTurnInput(turn.input, update);
    const mergedTurn: ConversationTurnSlot = {
      ...turn,
      ctx,
      input: mergedInput,
      updatedAt: Date.now(),
    };
    this.turns.set(scope.key, mergedTurn);

    if (turn.phase === "collecting") {
      await logger.info(`merged follow-up input into collecting conversation for ${scope.label} message=${ctx.message?.message_id ?? "unknown"}`);
      return true;
    }

    await logger.info(`restarting active conversation for ${scope.label} with merged follow-up message ${ctx.message?.message_id ?? "unknown"}`);
    await this.interruptActiveTask(`merged follow-up input ${ctx.message?.message_id ?? "unknown"}`, scope.key, { reactionEmoji: null });
    this.startConversationTask(ctx, turn.input.waitingTemplate, mergedInput.promptText, mergedInput.uploadedFiles, mergedInput.attachments, mergedInput.messageTime);
    return true;
  }

  private startConversationTask(
    ctx: Context,
    waitingTemplate: string,
    promptText: string,
    uploadedFiles: UploadedFile[] = [],
    attachments: AiAttachment[] = [],
    messageTime?: string,
  ): void {
    void this.beginConversationTurn(ctx, waitingTemplate, promptText, uploadedFiles, attachments, messageTime).catch(async (error) => {
      await logger.error(`background conversation task crashed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    });
  }

  private async beginConversationTurn(
    ctx: Context,
    waitingTemplate: string,
    promptText: string,
    uploadedFiles: UploadedFile[] = [],
    attachments: AiAttachment[] = [],
    messageTime?: string,
  ): Promise<void> {
    const chatId = ctx.chat?.id;
    const sourceMessageId = ctx.message?.message_id;
    const userId = ctx.from?.id;
    const scope = this.conversationScope(ctx);
    if (!chatId || !sourceMessageId) return;

    await this.interruptActiveTask(`new incoming message ${sourceMessageId}`, scope.key, { reactionEmoji: null });

    const taskId = this.nextTaskId++;
    const slot: ConversationTurnSlot = {
      taskId,
      phase: "collecting",
      userId,
      scopeKey: scope.key,
      scopeLabel: scope.label,
      ctx,
      input: {
        waitingTemplate,
        promptText,
        uploadedFiles,
        attachments,
        messageTime,
      },
      openedAt: Date.now(),
      updatedAt: Date.now(),
    };
    const coalesceMs = this.startupCoalesceMs();
    if (coalesceMs > 0) {
      slot.launchTimer = setTimeout(() => {
        void this.launchCollectedTurn(scope.key, taskId).catch(async (error) => {
          await logger.error(`background conversation task crashed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
          this.clearTurnIfCurrent(scope.key, taskId);
        });
      }, coalesceMs);
    }
    this.turns.set(scope.key, slot);
    if (coalesceMs === 0) {
      await this.launchCollectedTurn(scope.key, taskId);
    }
  }

  private async launchCollectedTurn(scopeKey: string, taskId: number): Promise<void> {
    const slot = this.turns.get(scopeKey);
    if (!slot || slot.taskId !== taskId || slot.phase !== "collecting") return;
    if (slot.launchTimer) {
      clearTimeout(slot.launchTimer);
      delete slot.launchTimer;
    }

    const ctx = slot.ctx;
    const chatId = ctx.chat?.id;
    const sourceMessageId = ctx.message?.message_id;
    if (!chatId || !sourceMessageId) {
      this.clearTurnIfCurrent(scopeKey, taskId);
      return;
    }

    await this.setReactionSafe(ctx, "🤔");
    const initialWaitingMessage = this.deps.config.telegram.waitingMessage;
    const waiting = initialWaitingMessage
      ? await this.feedback.sendWaitingMessageSafe(ctx, renderWaitingMessage(slot.input.waitingTemplate, initialWaitingMessage))
      : null;

    const latest = this.turns.get(scopeKey);
    if (!latest || latest.taskId !== taskId || latest.phase !== "collecting") {
      if (typeof waiting?.message_id === "number") {
        await ctx.api.deleteMessage(chatId, waiting.message_id).catch(() => {});
      }
      return;
    }

    const task: ActiveConversationTask = {
      id: taskId,
      userId: latest.userId,
      scopeKey: latest.scopeKey,
      scopeLabel: latest.scopeLabel,
      chatId,
      sourceMessageId,
      waitingMessageId: waiting?.message_id,
      cancelled: false,
    };
    this.activeTasks.set(scopeKey, task);
    this.turns.set(scopeKey, {
      ...latest,
      phase: "running",
      ctx,
      updatedAt: Date.now(),
    });
    try {
      await runAssistantTask({
        config: this.deps.config,
        ctx,
        task,
        promptText: latest.input.promptText,
        uploadedFiles: latest.input.uploadedFiles,
        attachments: latest.input.attachments,
        messageTime: latest.input.messageTime,
        agentService: this.deps.agentService,
        isTaskCurrent: (taskScopeKey, currentTaskId) => this.activeTasks.isCurrent(taskScopeKey, currentTaskId),
        onPruneRecentUploads: (taskScopeKey) => pruneRecentUploads(taskScopeKey),
        onStopWaiting: () => {},
        onSetReaction: (reactionCtx, emoji) => this.setReactionSafe(reactionCtx, emoji),
        onReleaseActiveTask: (taskScopeKey, currentTaskId) => {
          this.activeTasks.deleteIfCurrent(taskScopeKey, currentTaskId);
          this.clearTurnIfCurrent(taskScopeKey, currentTaskId);
        },
      });
    } finally {
      this.activeTasks.deleteIfCurrent(scopeKey, task.id);
      this.clearTurnIfCurrent(scopeKey, task.id);
    }
  }
}
