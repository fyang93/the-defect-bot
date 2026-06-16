import type { AppConfig } from "bot/app/types";
import { getUserTimezone } from "bot/app/state";
import { formatIsoInTimezoneParts } from "bot/app/time";
import { resolveChat, resolveUser } from "bot/operations/context/store";
import { extractDisplayableText } from "./response";
import { buildPersonaStyleLines } from "./prompt";
import type { ReminderTextContext } from "./types";

export type ReplyComposerInputContext = { requesterUserId?: number; chatId?: number; chatType?: string; preferredLanguage?: string };
export type ComposerPromptInput = {
  task: string;
  context: string;
  language: string;
  style: string;
  capabilities: string;
};

export class ReplyComposer {
  constructor(
    private config: AppConfig,
    private readonly promptForText: (text: string) => Promise<string>,
    private readonly promptForStartupText: (text: string) => Promise<string> = promptForText,
    private readonly renderComposerPrompt?: (input: ComposerPromptInput) => string,
  ) {}

  updateConfig(config: AppConfig): void {
    this.config = config;
  }

  async generateStartupGreeting(input?: ReplyComposerInputContext): Promise<string | null> {
    const request = this.buildComposerRequest("startup-greeting", [
      "The Telegram bot has just started.",
      "Write one short proactive startup greeting for the administrator.",
      "Return only the greeting text. Do not send it and do not take any action.",
      ...await this.buildStartupGreetingContextLines(input),
    ], { preferredLanguage: input?.preferredLanguage });
    const message = this.extractDirectTextReply(await this.promptForStartupText(request)).trim();
    return message || null;
  }

  async generateReminderText(reminderText: string, notifyAt: string, recurrenceDescription: string, timezone: string, context?: ReminderTextContext): Promise<string> {
    const localReminderTime = formatIsoInTimezoneParts(notifyAt, timezone?.trim());
    const localEventTime = context?.eventScheduledAt ? formatIsoInTimezoneParts(context.eventScheduledAt, timezone?.trim()) : null;
    const request = this.buildComposerRequest("reminder-text", [
      "Write one short natural reminder message for the recipient.",
      "Assume the message is delivered at the scheduled message delivery time, not at generation time.",
      "Anchor any time wording to the scheduled message delivery time below.",
      "Do not refer to the generation moment, current moment, or current date.",
      "Use the event occurrence time to decide whether this is an advance reminder or a same-time reminder.",
      "Avoid brittle relative phrasing such as ‘tomorrow’, ‘later today’, or ‘next week’ unless it is unambiguously correct at the scheduled message delivery time.",
      "Prefer wording that remains correct even if the text was generated in advance.",
      `Reminder content: ${reminderText}`,
      localReminderTime ? `Scheduled message delivery local time: ${localReminderTime.localDateTime} (${localReminderTime.timezone}).` : `Scheduled message delivery time: ${notifyAt}`,
      localEventTime ? `Event occurrence local time: ${localEventTime.localDateTime} (${localEventTime.timezone}).` : "",
      context?.reminderLabel ? `Reminder instance label: ${context.reminderLabel}.` : "",
      typeof context?.reminderOffsetMinutes === "number" ? `Reminder offset minutes from event occurrence: ${context.reminderOffsetMinutes}.` : "",
      context?.specialKind ? `Special reminder kind: ${context.specialKind}.` : "",
      context?.category ? `Event category: ${context.category}.` : "",
      `Repeat rule: ${recurrenceDescription}`,
    ], { preferredLanguage: this.config.bot.language });

    const result = this.extractDirectTextReply(await this.promptForText(request)).trim();
    return result;
  }

  async composeMaintenanceReport(facts: string[], input?: ReplyComposerInputContext): Promise<string> {
    const cleanFacts = facts.map((item) => item.trim()).filter(Boolean);
    if (cleanFacts.length === 0) return "";

    const request = this.buildComposerRequest("maintenance-report", [
      ...this.buildMinimalContextLines(input),
      "Confirmed maintenance facts:",
      ...cleanFacts.map((item) => `- ${item}`),
      "Write one concise admin-facing maintenance report using only these facts.",
    ], { preferredLanguage: input?.preferredLanguage });

    const composed = this.extractDirectTextReply(await this.promptForText(request)).trim();
    return composed || cleanFacts.join("\n");
  }

  private buildComposerRequest(task: string, lines: string[], options?: { separator?: string; includePersonaStyle?: boolean; preferredLanguage?: string; capabilities?: string }): string {
    const separator = options?.separator ?? "\n";
    const includePersonaStyle = options?.includePersonaStyle ?? true;
    const context = [
      ...lines,
      options?.preferredLanguage ? `Use this language for the reply: ${options.preferredLanguage}.` : "",
      "Return plain user-visible text only.",
      ...(includePersonaStyle ? buildPersonaStyleLines(this.config.bot.personaStyle, { label: "Reply style" }) : []),
    ].filter(Boolean).join(separator);
    if (!this.renderComposerPrompt) return context;
    return this.renderComposerPrompt({
      task,
      context,
      language: options?.preferredLanguage || this.config.bot.language,
      style: this.config.bot.personaStyle?.trim() || "default",
      capabilities: options?.capabilities || "web: false\nstateMutation: false\ntelegramDelivery: false\nrepoTools: false",
    });
  }

  private async buildStartupGreetingContextLines(input?: ReplyComposerInputContext): Promise<string[]> {
    const requesterUserId = input?.requesterUserId;
    if (typeof requesterUserId !== "number") {
      return ["Do not mention the current time or date unless the user explicitly asked for it."];
    }

    const known = resolveUser(this.config.paths.repoRoot, requesterUserId, { defaultTimezone: this.config.bot.defaultTimezone });
    const timezone = known?.timezone?.trim() || getUserTimezone(requesterUserId)?.trim() || this.config.bot.defaultTimezone;
    return [
      "Do not mention the current time or date unless the user explicitly asked for it.",
      known?.displayName || known?.username ? `Requester: ${known?.displayName || known?.username}${known?.username ? ` (@${known.username})` : ""}.` : `Requester user id: ${requesterUserId}.`,
      timezone ? `Requester timezone: ${timezone}.` : "",
    ].filter(Boolean);
  }

  private buildMinimalContextLines(input?: ReplyComposerInputContext): string[] {
    const lines: string[] = [];
    const requesterUserId = input?.requesterUserId;
    if (typeof requesterUserId === "number") {
      const known = resolveUser(this.config.paths.repoRoot, requesterUserId, { defaultTimezone: this.config.bot.defaultTimezone });
      const requesterLabel = known?.displayName || known?.username || String(requesterUserId);
      lines.push(`Current requester: ${requesterLabel}${known?.username ? ` (@${known.username})` : ""}.`);
      const timezone = known?.timezone?.trim() || getUserTimezone(requesterUserId)?.trim() || this.config.bot.defaultTimezone;
      if (timezone) lines.push(`Requester timezone: ${timezone}.`);
    }

    const chatId = input?.chatId;
    if (typeof chatId === "number") {
      const knownChat = resolveChat(this.config.paths.repoRoot, chatId);
      const conversation = knownChat
        ? `${knownChat.type || "chat"}${knownChat.title ? `, ${knownChat.title}` : ""}`
        : input?.chatType || "chat";
      lines.push(`Conversation: ${conversation}.`);
    } else if (input?.chatType) {
      lines.push(`Conversation: ${input.chatType}.`);
    }

    return lines;
  }

  private extractDirectTextReply(rawText: string): string {
    return extractDisplayableText(rawText);
  }
}
