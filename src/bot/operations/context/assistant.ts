import type { AppConfig } from "bot/app/types";
import { formatIsoInTimezoneParts } from "bot/app/time";
import { getRecentClarification } from "bot/app/state";
import { resolveChat, resolveUser } from "./store";

type AssistantContextInput = {
  requesterUserId?: string;
  chatId?: string;
  messageTime?: string;
};

export function lookupRequesterTimezone(config: AppConfig, requesterUserId: string | undefined): string | null {
  if (requesterUserId == null) return config.bot.defaultTimezone || null;
  return resolveUser(config.paths.repoRoot, requesterUserId, { defaultTimezone: config.bot.defaultTimezone })?.timezone || config.bot.defaultTimezone || null;
}

function clarificationScopeKey(chatType: string | undefined, requesterUserId: string | undefined, chatId: string | undefined): string | undefined {
  if (chatType === "group" || chatType === "supergroup") return chatId != null ? `chat:${chatId}` : undefined;
  if (requesterUserId != null) return `user:${requesterUserId}`;
  return chatId != null ? `chat:${chatId}` : undefined;
}

function deterministicTurnTimeContext(messageTime: string | undefined, timezone: string | null | undefined): {
  timezone: string;
  localDateTime: string;
} | null {
  const parts = formatIsoInTimezoneParts(messageTime, timezone);
  if (!parts) return null;
  return {
    timezone: parts.timezone,
    localDateTime: parts.localDateTime,
  };
}

export async function buildAssistantContextBlock(config: AppConfig, input: AssistantContextInput): Promise<string> {
  const requesterUser = input.requesterUserId != null
    ? resolveUser(config.paths.repoRoot, input.requesterUserId, { defaultTimezone: config.bot.defaultTimezone })
    : undefined;
  const chat = input.chatId != null ? resolveChat(config.paths.repoRoot, input.chatId) : undefined;
  const effectiveTimezone = requesterUser?.timezone || config.bot.defaultTimezone;
  const turnTime = deterministicTurnTimeContext(input.messageTime, effectiveTimezone);
  const activeUsers = Object.entries(chat?.participants || {})
    .sort((a, b) => b[1].lastInteractedAt.localeCompare(a[1].lastInteractedAt))
    .slice(0, 3);
  const recentClarification = getRecentClarification(clarificationScopeKey(chat?.type, input.requesterUserId, input.chatId));

  const payload = {
    turnTime,
    requesterUser: requesterUser && input.requesterUserId != null ? {
      id: String(input.requesterUserId),
      displayName: requesterUser.displayName || null,
      personPath: requesterUser.personPath || null,
      timezone: requesterUser.timezone || effectiveTimezone || null,
      rules: requesterUser.rules && requesterUser.rules.length > 0 ? requesterUser.rules : undefined,
    } : null,
    currentChat: chat && input.chatId != null ? {
      id: String(input.chatId),
      type: chat.type || null,
      title: chat.title || null,
      activeUserIds: activeUsers.map(([userId]) => userId),
    } : null,
    recentClarification,
  };

  const lines = [
    requesterUser?.personPath ? `Requester person path: ${requesterUser.personPath}` : "",
    requesterUser?.personPath ? "For requester-specific recorded facts or files, start from that path before saying nothing is recorded." : "",
    requesterUser?.personPath ? "For vague alias requests, read that file and copy exact aliases/names; never infer aliases from slugs or current display names." : "",
    "Assistant context JSON:",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].filter(Boolean);

  return lines.join("\n");
}
