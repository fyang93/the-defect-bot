import type { Bot, Context } from "grammy";
import { logger } from "bot/app/logger";
import { editMessageTextFormatted, isTransientTelegramNetworkError, sendTelegramWithRetry } from "bot/telegram/format";

type ReactionCapableApi = Bot<Context>["api"] & {
  setMessageReaction?: (chatId: number, messageId: number, reaction: Array<{ type: "emoji"; emoji: string }>, isBig?: boolean) => Promise<unknown>;
};

const COSMETIC_TELEGRAM_FAILURE_COOLDOWN_MS = 60_000;

export class CosmeticTelegramFeedback {
  private unavailableUntil = 0;

  constructor(private readonly bot: Bot<Context>) {}

  async setReactionSafe(ctx: Context, emoji: string): Promise<void> {
    const messageId = ctx.message?.message_id;
    const chatId = ctx.chat?.id;
    if (!messageId || !chatId) return;
    await this.setReactionByMessageSafe(chatId, messageId, emoji);
  }

  async setReactionByMessageSafe(chatId: number, messageId: number, emoji: string): Promise<void> {
    if (this.unavailableUntil > Date.now()) return;
    const api = this.bot.api as ReactionCapableApi;
    if (!api.setMessageReaction) {
      await logger.warn(`reaction unsupported chat=${chatId} message=${messageId} emoji=${emoji}`);
      return;
    }
    try {
      await sendTelegramWithRetry(
        () => api.setMessageReaction!(chatId, messageId, [{ type: "emoji", emoji }], false),
        "set reaction",
        { attempts: 1 },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTransientTelegramNetworkError(error)) {
        this.unavailableUntil = Date.now() + COSMETIC_TELEGRAM_FAILURE_COOLDOWN_MS;
        await logger.warn(`cosmetic telegram operations paused after reaction network failure chat=${chatId} message=${messageId} emoji=${emoji}: ${message}`);
        return;
      }
      if (emoji !== "😢" && /REACTION_INVALID/i.test(message)) {
        try {
          await sendTelegramWithRetry(
            () => api.setMessageReaction!(chatId, messageId, [{ type: "emoji", emoji: "😢" }], false),
            "set fallback reaction",
            { attempts: 2, delaysMs: [250] },
          );
          await logger.warn(`reaction fallback chat=${chatId} message=${messageId} from=${emoji} to=😢 reason=${message}`);
          return;
        } catch (fallbackError) {
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          await logger.warn(`reaction fallback failed chat=${chatId} message=${messageId} emoji=😢: ${fallbackMessage}`);
          return;
        }
      }
      await logger.warn(`reaction failed chat=${chatId} message=${messageId} emoji=${emoji}: ${message}`);
    }
  }

  async editMessageTextFormattedSafe(ctx: Context, chatId: number, messageId: number, text: string, options?: { reply_markup?: unknown }): Promise<void> {
    try {
      await editMessageTextFormatted(ctx, chatId, messageId, text, options as Parameters<typeof editMessageTextFormatted>[4]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/message is not modified|400: Bad Request/i.test(message)) return;
      throw error;
    }
  }

  async sendWaitingMessageSafe(ctx: Context, text: string): Promise<{ message_id?: number } | null> {
    if (this.unavailableUntil > Date.now()) return null;
    try {
      return await sendTelegramWithRetry(() => ctx.reply(text), "send waiting message", { attempts: 1 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const chatId = ctx.chat?.id;
      const sourceMessageId = ctx.message?.message_id;
      if (isTransientTelegramNetworkError(error)) {
        this.unavailableUntil = Date.now() + COSMETIC_TELEGRAM_FAILURE_COOLDOWN_MS;
      }
      await logger.warn(`waiting message send failed chat=${chatId ?? "unknown"} message=${sourceMessageId ?? "unknown"}: ${message}`);
      return null;
    }
  }
}
