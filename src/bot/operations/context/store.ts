import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { state } from "bot/app/state";

type CacheEntry<T> = { mtimeMs: number; value: T };
const jsonCache = new Map<string, CacheEntry<unknown>>();

export function invalidateContextStoreCache(filePath?: string): void {
  if (filePath) jsonCache.delete(filePath);
  else jsonCache.clear();
}

export type UserRecord = {
  displayName?: string;
  aliases?: string[];
  personPath?: string;
  timezone?: string;
  rules?: string[];
  lastSeenAt?: string;
  updatedAt?: string;
};

export type ChatRecord = {
  type?: "p2p" | "group" | "topic";
  title?: string;
  participants?: Record<string, { lastInteractedAt: string }>;
  lastSeenAt?: string;
  updatedAt?: string;
};

function cleanText(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function cleanObject(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function cleanList(value: unknown): string[] | undefined {
  const items = (typeof value === "string" ? [value] : Array.isArray(value) ? value : []).map(cleanText).filter((item): item is string => Boolean(item));
  return items.length ? Array.from(new Set(items)) : undefined;
}

function readJsonCached<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback;
    const mtimeMs = statSync(filePath).mtimeMs;
    const cached = jsonCache.get(filePath) as CacheEntry<T> | undefined;
    if (cached?.mtimeMs === mtimeMs) return cached.value;
    const value = JSON.parse(readFileSync(filePath, "utf8")) as T;
    jsonCache.set(filePath, { mtimeMs, value });
    return value;
  } catch { return fallback; }
}

export function loadUsers(repoRoot: string, options?: { defaultTimezone?: string }): Record<string, UserRecord> {
  const source = cleanObject(readJsonCached<{ users?: unknown }>(path.join(repoRoot, "system", "users.json"), {}).users) || {};
  return Object.fromEntries(Object.entries(source).map(([openId, value]) => {
    const record = cleanObject(value) || {};
    return [openId, {
      displayName: cleanText(record.displayName),
      aliases: cleanList(record.aliases),
      personPath: cleanText(record.personPath) || cleanText(record.memoryPath),
      timezone: cleanText(record.timezone) || cleanText(options?.defaultTimezone),
      rules: cleanList(record.rules),
      lastSeenAt: cleanText(record.lastSeenAt),
      updatedAt: cleanText(record.updatedAt),
    } satisfies UserRecord];
  }));
}

export function loadChats(repoRoot: string): Record<string, ChatRecord> {
  const source = cleanObject(readJsonCached<{ chats?: unknown }>(path.join(repoRoot, "system", "chats.json"), {}).chats) || {};
  return Object.fromEntries(Object.entries(source).map(([chatId, value]) => {
    const record = cleanObject(value) || {};
    const rawType = cleanText(record.type);
    const type = rawType === "p2p" || rawType === "topic" ? rawType : "group";
    const participants = Object.fromEntries(Object.entries(cleanObject(record.participants) || {}).flatMap(([id, item]) => {
      const at = cleanText(cleanObject(item)?.lastInteractedAt);
      return at ? [[id, { lastInteractedAt: at }]] : [];
    }));
    return [chatId, { type, title: cleanText(record.title), participants, lastSeenAt: cleanText(record.lastSeenAt), updatedAt: cleanText(record.updatedAt) } satisfies ChatRecord];
  }));
}

function normalized(value: string): string { return value.trim().replace(/^@+/, "").toLowerCase(); }
function uniqueUser(repoRoot: string, predicate: (user: UserRecord) => boolean): [string, UserRecord] | undefined {
  const matches = Object.entries(loadUsers(repoRoot)).filter(([, user]) => predicate(user));
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveUser(repoRoot: string, userId: string | undefined, options?: { defaultTimezone?: string }): UserRecord | undefined {
  return userId ? loadUsers(repoRoot, options)[userId] : undefined;
}
export function resolveUserByAlias(repoRoot: string, alias: string | undefined): [string, UserRecord] | undefined {
  const key = alias ? normalized(alias) : "";
  return key ? uniqueUser(repoRoot, (user) => (user.aliases || []).some((item) => normalized(item) === key)) : undefined;
}
export function resolveUserByDisplayName(repoRoot: string, displayName: string | undefined): [string, UserRecord] | undefined {
  const key = displayName ? normalized(displayName) : "";
  return key ? uniqueUser(repoRoot, (user) => normalized(user.displayName || "") === key) : undefined;
}
export function resolveChat(repoRoot: string, chatId: string | undefined): ChatRecord | undefined { return chatId ? loadChats(repoRoot)[chatId] : undefined; }

export function resolveUserDisplayName(repoRoot: string, userId: string | undefined): string | undefined {
  const user = resolveUser(repoRoot, userId);
  return user?.aliases?.[0] || user?.displayName || (userId ? state.feishuUserCache[userId]?.displayName : undefined);
}
export function resolveChatDisplayName(repoRoot: string, chatId: string | undefined): string | undefined {
  return resolveChat(repoRoot, chatId)?.title || (chatId ? state.feishuChatCache[chatId]?.title : undefined);
}

export function buildStructuredContextLines(repoRoot: string, input: { requesterUserId?: string; replyTargetUserId?: string; chatId?: string; taskId?: string; defaultTimezone?: string }): string[] {
  const lines: string[] = [];
  const requester = resolveUser(repoRoot, input.requesterUserId, { defaultTimezone: input.defaultTimezone });
  const replyTarget = resolveUser(repoRoot, input.replyTargetUserId, { defaultTimezone: input.defaultTimezone });
  const chat = resolveChat(repoRoot, input.chatId);
  if (input.requesterUserId && requester) {
    lines.push(`Requester user: ${input.requesterUserId}${requester.displayName ? ` (${requester.displayName})` : ""}.`);
    if (requester.personPath) lines.push(`Requester person file: ${requester.personPath}.`);
    if (requester.timezone) lines.push(`Requester timezone: ${requester.timezone}.`);
  }
  if (input.replyTargetUserId && replyTarget) lines.push(`Reply target user: ${input.replyTargetUserId}${replyTarget.displayName ? ` (${replyTarget.displayName})` : ""}.`);
  if (chat) {
    lines.push(`Conversation registry: ${chat.type || "chat"}${chat.title ? `, ${chat.title}` : ""}.`);
    const active = Object.entries(chat.participants || {}).sort((a, b) => b[1].lastInteractedAt.localeCompare(a[1].lastInteractedAt)).slice(0, 5).map(([id]) => id);
    if (active.length) lines.push(`Conversation active users: ${active.join(", ")}.`);
  }
  return lines;
}
