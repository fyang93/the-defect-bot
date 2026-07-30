import type { LarkChannel, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { AiService } from "bot/ai";
import type { AiAttachment, AppConfig, UploadedFile } from "bot/app/types";
import { touchActivity } from "bot/app/state";
import { logger } from "bot/app/logger";
import { fetchFeishuReplyContext, saveFeishuResources } from "bot/feishu/transport";
import { runAssistantTask, type ActiveConversationTask } from "bot/runtime/assistant";

type Input = { text: string; files: UploadedFile[]; attachments: AiAttachment[]; messageTime: string };
type Buffered = { message: NormalizedMessage; input: Input; at: number };
type Turn = { task: ActiveConversationTask; message: NormalizedMessage; input: Input; phase: "collecting" | "running"; updatedAt: number; timer?: NodeJS.Timeout; reactionId?: string };
const CONTEXT_TTL_MS = 10 * 60 * 1000;
const CONTEXT_ITEMS = 3;
const STARTUP_COALESCE_MS = 500;

function merge(left: Input, right: Input): Input {
  return { text: [left.text, right.text && `Follow-up user message in the same turn:\n${right.text}`].filter(Boolean).join("\n\n"), files: [...left.files, ...right.files], attachments: [...left.attachments, ...right.attachments], messageTime: right.messageTime || left.messageTime };
}
function referenceTime(message: NormalizedMessage): string {
  const millis = message.createTime > 10_000_000_000 ? message.createTime : message.createTime * 1000;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}
function scope(message: NormalizedMessage): { key: string; label: string } {
  return message.chatType === "group" ? { key: `chat:${message.chatId}`, label: `Feishu chat ${message.chatId}` } : { key: `user:${message.senderId}`, label: `Feishu user ${message.senderId}` };
}

export class ConversationController {
  private nextTaskId = 1;
  private readonly turns = new Map<string, Turn>();
  private buffered: Buffered[] = [];

  constructor(private readonly deps: { config: AppConfig; channel: LarkChannel; agentService: AiService }) {}
  hasActiveTask(): boolean { return this.turns.size > 0; }

  async interruptActiveTask(reason: string, scopeKey?: string): Promise<void> {
    const entries = scopeKey ? [[scopeKey, this.turns.get(scopeKey)] as const] : [...this.turns.entries()];
    for (const [key, turn] of entries) {
      if (!turn) continue;
      turn.task.cancelled = true;
      if (turn.timer) clearTimeout(turn.timer);
      this.turns.delete(key);
      await this.deps.agentService.abortCurrentSession(turn.task.scopeKey, turn.task.scopeLabel).catch(() => undefined);
      if (turn.reactionId) await this.deps.channel.removeReaction(turn.task.sourceMessageId, turn.reactionId).catch(() => undefined);
      await logger.info(`interrupted assistant task ${turn.task.id}: ${reason}`);
    }
  }

  async handleMessageRecall(messageId: string | undefined): Promise<void> {
    if (!messageId) return;
    this.buffered = this.buffered.filter((item) => item.message.messageId !== messageId);
    const active = [...this.turns.entries()].find(([, turn]) => turn.task.sourceMessageId === messageId);
    if (active) await this.interruptActiveTask("source message recalled", active[0]);
  }

  async resetSession(message: NormalizedMessage): Promise<string> {
    const currentScope = scope(message);
    await this.interruptActiveTask("new session", currentScope.key);
    this.buffered = this.buffered.filter((item) => item.message.chatId !== message.chatId || item.message.senderId !== message.senderId);
    return this.deps.agentService.newSession(currentScope.key, currentScope.label);
  }

  async resetUserSession(openId: string): Promise<string> {
    const scopeKey = `user:${openId}`;
    await this.interruptActiveTask("new session from Feishu menu", scopeKey);
    this.buffered = this.buffered.filter((item) => item.message.senderId !== openId);
    return this.deps.agentService.newSession(scopeKey, `Feishu user ${openId}`);
  }

  async stash(message: NormalizedMessage): Promise<void> {
    const saved = message.resources.length ? await saveFeishuResources(this.deps.channel, this.deps.config, message) : { files: [], attachments: [] };
    const input = { text: message.content.trim() || "用户上传了一个附件。", ...saved, messageTime: referenceTime(message) };
    this.pruneBuffered();
    this.buffered.push({ message, input, at: Date.now() });
  }

  async handleMessage(message: NormalizedMessage): Promise<void> {
    touchActivity();
    const [saved, replyContext] = await Promise.all([
      message.resources.length ? saveFeishuResources(this.deps.channel, this.deps.config, message) : Promise.resolve({ files: [], attachments: [] }),
      fetchFeishuReplyContext(this.deps.channel, message).catch(() => ""),
    ]);
    const currentScope = scope(message);
    const prior = this.takeBuffered(message);
    const contextText = prior.length ? ["Recent unaddressed Feishu messages from this user:", ...prior.map((item) => `- messageId=${item.message.messageId}: ${item.input.text}`)].join("\n") : "";
    let input: Input = {
      text: [contextText, replyContext, "Current user message:", message.content.trim() || "用户上传了一个附件。"].filter(Boolean).join("\n\n"),
      files: [...prior.flatMap((item) => item.input.files), ...saved.files], attachments: [...prior.flatMap((item) => item.input.attachments), ...saved.attachments], messageTime: referenceTime(message),
    };
    const existing = this.turns.get(currentScope.key);
    if (existing && existing.task.userId === message.senderId && Date.now() - existing.updatedAt <= this.deps.config.feishu.inputMergeWindowSeconds * 1000) {
      input = merge(existing.input, input);
      await this.interruptActiveTask(`merged follow-up ${message.messageId}`, currentScope.key);
    } else if (existing) {
      await this.interruptActiveTask(`new message ${message.messageId}`, currentScope.key);
    }
    const task: ActiveConversationTask = { id: this.nextTaskId++, userId: message.senderId, scopeKey: currentScope.key, scopeLabel: currentScope.label, chatId: message.chatId, sourceMessageId: message.messageId, cancelled: false };
    const turn: Turn = { task, message, input, phase: "collecting", updatedAt: Date.now() };
    this.turns.set(currentScope.key, turn);
    turn.timer = setTimeout(() => void this.launch(currentScope.key, task.id), Math.min(STARTUP_COALESCE_MS, this.deps.config.feishu.inputMergeWindowSeconds * 1000));
  }

  private pruneBuffered(): void { this.buffered = this.buffered.filter((item) => Date.now() - item.at <= CONTEXT_TTL_MS); }
  private takeBuffered(message: NormalizedMessage): Buffered[] {
    this.pruneBuffered();
    const exact = message.replyToMessageId ? this.buffered.filter((item) => item.message.messageId === message.replyToMessageId && item.message.chatId === message.chatId) : [];
    const selected = exact.length ? exact : this.buffered.filter((item) => item.message.chatId === message.chatId && item.message.senderId === message.senderId).slice(-CONTEXT_ITEMS);
    const used = new Set(selected); this.buffered = this.buffered.filter((item) => !used.has(item)); return selected;
  }

  private async launch(scopeKey: string, taskId: number): Promise<void> {
    const turn = this.turns.get(scopeKey);
    if (!turn || turn.task.id !== taskId || turn.task.cancelled) return;
    turn.phase = "running";
    turn.reactionId = await this.deps.channel.addReaction(turn.message.messageId, "OnIt").catch(() => undefined);
    await runAssistantTask({
      config: this.deps.config, channel: this.deps.channel, message: turn.message, task: turn.task, promptText: turn.input.text,
      uploadedFiles: turn.input.files, attachments: turn.input.attachments, messageTime: turn.input.messageTime, agentService: this.deps.agentService,
      isTaskCurrent: (key, id) => this.turns.get(key)?.task.id === id,
      onReleaseActiveTask: (key, id) => { const current = this.turns.get(key); if (current?.task.id === id) { this.turns.delete(key); if (current.reactionId) void this.deps.channel.removeReaction(current.task.sourceMessageId, current.reactionId).catch(() => undefined); } },
    });
  }
}
