import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { state } from "bot/app/state";

type CacheEntry<T> = { mtimeMs: number; value: T };

const jsonCache = new Map<string, CacheEntry<unknown>>();

export function invalidateContextStoreCache(filePath?: string): void {
  if (filePath) {
    jsonCache.delete(filePath);
    return;
  }
  jsonCache.clear();
}

export type UserRecord = {
  username?: string;
  displayName?: string;
  aliases?: string[];
  personPath?: string;
  accessLevel?: "admin" | "allowed" | "trusted";
  timezone?: string;
  languageCode?: string;
  rules?: string[];
  lastSeenAt?: string;
  updatedAt?: string;
};

export type ChatRecord = {
  type?: string;
  title?: string;
  participants?: Record<string, { lastInteractedAt: string }>;
  lastSeenAt?: string;
  updatedAt?: string;
};

function cleanText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function cleanStringList(value: unknown): string[] | undefined {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => cleanText(item))
    .filter((item): item is string => Boolean(item));
  const deduped = Array.from(new Set(items));
  return deduped.length > 0 ? deduped : undefined;
}

function cleanRules(value: unknown): string[] | undefined {
  return cleanStringList(value);
}

function readJsonCached<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback;
    const info = statSync(filePath);
    const cached = jsonCache.get(filePath) as CacheEntry<T> | undefined;
    if (cached && cached.mtimeMs === info.mtimeMs) return cached.value;
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as T;
    jsonCache.set(filePath, { mtimeMs: info.mtimeMs, value: parsed });
    return parsed;
  } catch {
    return fallback;
  }
}

export function loadUsers(repoRoot: string, options?: { defaultTimezone?: string }): Record<string, UserRecord> {
  const raw = readJsonCached<{ users?: unknown }>(path.join(repoRoot, "system", "users.json"), {});
  const source = cleanObject(raw.users) || {};
  const defaultTimezone = cleanText(options?.defaultTimezone);
  return Object.fromEntries(
    Object.entries(source).map(([userId, value]) => {
      const record = cleanObject(value) || {};
      return [userId, {
        username: cleanText(record.username),
        displayName: cleanText(record.displayName),
        aliases: cleanStringList(record.aliases),
        personPath: cleanText(record.personPath) || cleanText(record.memoryPath),
        accessLevel: record.accessLevel === "admin" || record.accessLevel === "allowed" || record.accessLevel === "trusted"
          ? record.accessLevel
          : record.role === "allowed" || record.role === "trusted"
            ? record.role
            : undefined,
        timezone: cleanText(record.timezone) || defaultTimezone,
        languageCode: cleanText(record.languageCode) || cleanText(record.language_code),
        rules: cleanRules(record.rules),
        lastSeenAt: cleanText(record.lastSeenAt),
        updatedAt: cleanText(record.updatedAt),
      } satisfies UserRecord];
    }),
  );
}

export function loadChats(repoRoot: string): Record<string, ChatRecord> {
  const raw = readJsonCached<{ chats?: unknown }>(path.join(repoRoot, "system", "chats.json"), {});
  const source = cleanObject(raw.chats) || {};
  return Object.fromEntries(
    Object.entries(source).map(([chatId, value]) => {
      const record = cleanObject(value) || {};
      return [chatId, {
        type: cleanText(record.type),
        title: cleanText(record.title),
        participants: Object.fromEntries(
          Object.entries(cleanObject(record.participants) || {})
            .map(([participantUserId, participantValue]) => {
              const participant = cleanObject(participantValue) || {};
              const lastInteractedAt = cleanText(participant.lastInteractedAt);
              return [participantUserId, lastInteractedAt ? { lastInteractedAt } : undefined] as const;
            })
            .filter(([, participant]) => Boolean(participant)),
        ) as Record<string, { lastInteractedAt: string }> | undefined,
        lastSeenAt: cleanText(record.lastSeenAt),
        updatedAt: cleanText(record.updatedAt),
      } satisfies ChatRecord];
    }),
  );
}

function normalizeLookupKey(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

function resolveUniqueUserMatch(repoRoot: string, predicate: (user: UserRecord) => boolean): [string, UserRecord] | undefined {
  const matches = Object.entries(loadUsers(repoRoot)).filter(([, user]) => predicate(user));
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveUser(repoRoot: string, userId: number | string | undefined, options?: { defaultTimezone?: string }): UserRecord | undefined {
  if (userId == null) return undefined;
  return loadUsers(repoRoot, options)[String(userId)];
}

export function resolveUserByUsername(repoRoot: string, username: string | undefined): [string, UserRecord] | undefined {
  const cleaned = cleanText(username);
  const normalized = cleaned ? normalizeLookupKey(cleaned) : undefined;
  if (!normalized) return undefined;
  return resolveUniqueUserMatch(repoRoot, (user) => {
    const keys = new Set([user.username].filter((item): item is string => Boolean(item)).map(normalizeLookupKey));
    return keys.has(normalized);
  });
}

export function resolveUserByAlias(repoRoot: string, alias: string | undefined): [string, UserRecord] | undefined {
  const cleaned = cleanText(alias);
  const normalized = cleaned ? normalizeLookupKey(cleaned) : undefined;
  if (!normalized) return undefined;
  return resolveUniqueUserMatch(repoRoot, (user) => {
    const keys = new Set((user.aliases || []).map(normalizeLookupKey));
    return keys.has(normalized);
  });
}

export function resolveUserByDisplayName(repoRoot: string, displayName: string | undefined): [string, UserRecord] | undefined {
  const cleaned = cleanText(displayName);
  const normalized = cleaned ? normalizeLookupKey(cleaned) : undefined;
  if (!normalized) return undefined;
  return resolveUniqueUserMatch(repoRoot, (user) => normalizeLookupKey(user.displayName || "") === normalized);
}

export function resolveChat(repoRoot: string, chatId: number | string | undefined): ChatRecord | undefined {
  if (chatId == null) return undefined;
  return loadChats(repoRoot)[String(chatId)];
}

export function resolveUserDisplayName(repoRoot: string, userId: number | string | undefined): string | undefined {
  const user = resolveUser(repoRoot, userId);
  if (user?.aliases?.[0]) return user.aliases[0];
  if (user?.displayName) return user.displayName;
  if (user?.username) return `@${user.username}`;
  if (userId != null) {
    const runtime = state.telegramUserCache[String(userId)];
    if (runtime?.displayName) return runtime.displayName;
    if (runtime?.username) return `@${runtime.username}`;
  }
  return undefined;
}

export function resolveChatDisplayName(repoRoot: string, chatId: number | string | undefined): string | undefined {
  const chat = resolveChat(repoRoot, chatId);
  if (chat?.title) return chat.title;
  if (chatId != null) {
    const runtime = state.telegramChatCache[String(chatId)];
    if (runtime?.title) return runtime.title;
  }
  return undefined;
}

export function buildStructuredContextLines(repoRoot: string, input: { requesterUserId?: number; requesterUsername?: string; replyTargetUserId?: number; replyTargetUsername?: string; chatId?: number; taskId?: string; defaultTimezone?: string; }): string[] {
  const lines: string[] = [];
  const requesterUserId = input.requesterUserId != null
    ? String(input.requesterUserId)
    : resolveUserByUsername(repoRoot, input.requesterUsername)?.[0];
  const replyUserId = input.replyTargetUserId != null
    ? String(input.replyTargetUserId)
    : resolveUserByUsername(repoRoot, input.replyTargetUsername)?.[0];
  const requesterUser = requesterUserId ? resolveUser(repoRoot, requesterUserId, { defaultTimezone: input.defaultTimezone }) : undefined;
  const replyUser = replyUserId ? resolveUser(repoRoot, replyUserId, { defaultTimezone: input.defaultTimezone }) : undefined;
  const chat = resolveChat(repoRoot, input.chatId);

  if (requesterUserId && requesterUser) {
    lines.push(`Requester user: ${requesterUserId}${requesterUser.displayName ? ` (${requesterUser.displayName})` : ""}.`);
    if (requesterUser.personPath) lines.push(`Requester person file: ${requesterUser.personPath}.`);
    if (requesterUser.timezone) lines.push(`Requester timezone: ${requesterUser.timezone}.`);
  }

  if (replyUserId && replyUser) {
    lines.push(`Reply target user: ${replyUserId}${replyUser.displayName ? ` (${replyUser.displayName})` : ""}.`);
    if (replyUser.personPath) lines.push(`Reply target person file: ${replyUser.personPath}.`);
    if (replyUser.timezone) lines.push(`Reply target timezone: ${replyUser.timezone}.`);
  }

  if (chat) {
    const title = chat.title ? `, ${chat.title}` : "";
    lines.push(`Conversation registry: ${chat.type || "chat"}${title}.`);
    const participantIds = Object.entries(chat.participants || {})
      .sort((a, b) => b[1].lastInteractedAt.localeCompare(a[1].lastInteractedAt))
      .slice(0, 5)
      .map(([participantUserId]) => participantUserId);
    if (participantIds.length > 0) lines.push(`Conversation active users: ${participantIds.join(", ")}.`);
  }

  return lines;
}
