import type { AppConfig } from "bot/app/types";
import { getUserTimezone } from "bot/app/state";
import { formatIsoInTimezoneParts } from "bot/app/time";
import { resolveChat, resolveUser } from "bot/operations/context/store";
import { extractDisplayableText } from "./response";
import { buildPersonaStyleLines } from "./prompt";

export type ReplyComposerInputContext = { requesterUserId?: number; chatId?: number; chatType?: string; preferredLanguage?: string };

export class ReplyComposer {
  constructor(
    private config: AppConfig,
    private readonly promptForText: (text: string) => Promise<string>,
    private readonly promptForStartupText: (text: string) => Promise<string> = promptForText,
  ) {}

  updateConfig(config: AppConfig): void {
    this.config = config;
  }

  async generateStartupGreeting(input?: ReplyComposerInputContext): Promise<string | null> {
    const request = this.buildUserFacingTextRequest([
      "The Telegram bot has just started.",
      "Write one short proactive startup greeting for the administrator.",
      "Return only the greeting text. Do not send it and do not take any action.",
      ...await this.buildStartupGreetingContextLines(input),
    ], { preferredLanguage: input?.preferredLanguage });
    const message = this.extractDirectTextReply(await this.promptForStartupText(request)).trim();
    return message || null;
  }

  async generateReminderText(reminderText: string, notifyAt: string, recurrenceDescription: string, timezone: string): Promise<string> {
    const localReminderTime = formatIsoInTimezoneParts(notifyAt, timezone?.trim());
    const request = this.buildUserFacingTextRequest([
      "Write one short natural reminder message for the recipient.",
      "Assume the message is delivered at the scheduled reminder time, not at generation time.",
      "Anchor any time wording to the scheduled delivery time below.",
      "Do not refer to the generation moment, current moment, or current date.",
      "Avoid brittle relative phrasing such as ‘tomorrow’, ‘later today’, or ‘next week’ unless it is unambiguously correct at the scheduled delivery time.",
      "Prefer wording that remains correct even if the text was generated in advance.",
      `Reminder content: ${reminderText}`,
      localReminderTime ? `Scheduled delivery local time: ${localReminderTime.localDateTime} (${localReminderTime.timezone}).` : `Scheduled delivery time: ${notifyAt}`,
      `Repeat rule: ${recurrenceDescription}`,
    ], { preferredLanguage: this.config.bot.language });

    const result = this.extractDirectTextReply(await this.promptForText(request)).trim();
    return result;
  }

  async composeUserReply(baseMessage: string | null | undefined, facts: string[], input?: ReplyComposerInputContext): Promise<string> {
    const cleanFacts = facts.map((item) => item.trim()).filter(Boolean);
    const cleanBase = baseMessage?.trim() || "";
    if (!cleanBase && cleanFacts.length === 0) return "";

    const request = this.buildUserFacingTextRequest([
      ...this.buildMinimalContextLines(input),
      cleanBase ? `Draft: ${cleanBase}` : "",
      cleanFacts.length > 0 ? "Confirmed facts:" : "",
      ...cleanFacts.map((item) => `- ${item}`),
      cleanFacts.length > 0 ? "Write one concise reply using the confirmed facts." : "Rewrite the draft into one concise natural reply.",
    ], { preferredLanguage: input?.preferredLanguage });

    const composed = this.extractDirectTextReply(await this.promptForText(request)).trim();
    return composed || cleanBase;
  }

  private buildUserFacingTextRequest(lines: string[], options?: { separator?: string; includePersonaStyle?: boolean; preferredLanguage?: string }): string {
    const separator = options?.separator ?? "\n";
    const includePersonaStyle = options?.includePersonaStyle ?? true;
    return [
      ...lines,
      options?.preferredLanguage ? `Use this language for the reply: ${options.preferredLanguage}.` : "",
      "Return plain user-visible text only.",
      ...(includePersonaStyle ? buildPersonaStyleLines(this.config.bot.personaStyle, { label: "Reply style" }) : []),
    ].filter(Boolean).join(separator);
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
