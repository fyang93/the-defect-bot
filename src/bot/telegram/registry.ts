import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { state } from "bot/app/state";
import { loadConfig } from "bot/app/config";
import { invalidateContextStoreCache, loadChats, loadUsers, resolveChat, resolveUser } from "bot/operations/context/store";
import { enqueueSync } from "bot/operations/maintenance/sync";

export type TelegramUserInput = {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
};

export type TelegramChatInput = {
  id?: number;
  type?: string;
  title?: string;
  username?: string;
};

export type KnownTelegramUser = {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  displayName: string;
  aliases?: string[];
  lastSeenAt: string;
};
export type KnownTelegramChat = {
  id: number;
  type: string;
  title?: string;
  lastSeenAt: string;
};

function allowedUserIdSet(allowedUserIds?: number[]): Set<number> | null {
  return allowedUserIds && allowedUserIds.length > 0 ? new Set(allowedUserIds) : null;
}

function cleanOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildDisplayName(firstName?: string, lastName?: string, username?: string): string {
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  if (fullName) return fullName;
  if (username) return `@${username}`;
  return "Telegram user";
}

function normalizeLookupKey(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

function repoRoot(): string {
  return process.cwd();
}

function defaultTimezone(): string {
  try {
    return loadConfig().bot.defaultTimezone;
  } catch {
    return "UTC";
  }
}

function upsertUserFile(userId: string, patch: Record<string, unknown>): void {
  const filePath = path.join(repoRoot(), "system", "users.json");
  try {
    const parsed = existsSync(filePath)
      ? JSON.parse(readFileSync(filePath, "utf8")) as { users?: Record<string, unknown> }
      : { users: {} };
    const users = parsed.users && typeof parsed.users === "object" ? parsed.users : {};
    const previous = users[userId] && typeof users[userId] === "object" ? users[userId] as Record<string, unknown> : {};
    users[userId] = {
      ...previous,
      ...(typeof previous.timezone === "string" && previous.timezone.trim() ? {} : { timezone: state.userTimezoneCache[userId]?.timezone || defaultTimezone() }),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ users }, null, 2) + "\n", "utf8");
    invalidateContextStoreCache(filePath);
  } catch {
    // ignore persistence issues here; runtime cache still updates
  }
}

function upsertChatFile(chatId: string, patch: Record<string, unknown>): void {
  const filePath = path.join(repoRoot(), "system", "chats.json");
  try {
    const parsed = existsSync(filePath)
      ? JSON.parse(readFileSync(filePath, "utf8")) as { chats?: Record<string, unknown> }
      : { chats: {} };
    const chats = parsed.chats && typeof parsed.chats === "object" ? parsed.chats : {};
    const previous = chats[chatId] && typeof chats[chatId] === "object" ? chats[chatId] as Record<string, unknown> : {};
    chats[chatId] = { ...previous, ...patch, updatedAt: new Date().toISOString() };
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ chats }, null, 2) + "\n", "utf8");
    invalidateContextStoreCache(filePath);
  } catch {
    // ignore persistence issues here; runtime cache still updates
  }
}

export function rememberTelegramUser(user: TelegramUserInput | null | undefined, allowedUserIds?: number[]): boolean {
  const userId = typeof user?.id === "number" && Number.isInteger(user.id) ? user.id : null;
  const allowed = allowedUserIdSet(allowedUserIds);
  if (!userId || (allowed && !allowed.has(userId))) return false;
  const username = cleanOptionalText(user?.username);
  const firstName = cleanOptionalText(user?.first_name);
  const lastName = cleanOptionalText(user?.last_name);
  const displayName = buildDisplayName(firstName, lastName, username);
  const languageCode = cleanOptionalText(user?.language_code);
  const key = String(userId);
  const previous = state.telegramUserCache[key];
  const lastSeenAt = new Date().toISOString();
  const next = {
    username,
    firstName,
    lastName,
    displayName,
    lastSeenAt,
    languageCode,
  };
  const changed = !previous
    || previous.username !== next.username
    || previous.firstName !== next.firstName
    || previous.lastName !== next.lastName
    || previous.displayName !== next.displayName
    || previous.languageCode !== next.languageCode;
  state.telegramUserCache[key] = changed ? next : { ...previous, lastSeenAt };
  if (changed || !previous) {
    upsertUserFile(key, { username, displayName, lastSeenAt, languageCode });
  }
  enqueueSync({
    repoRoot: repoRoot(),
    subject: "user",
    operation: "refresh",
    selector: { userId: key },
  });
  return changed;
}

export function rememberTelegramChat(chat: TelegramChatInput | null | undefined, participantUserIds: number[] = []): boolean {
  const chatId = typeof chat?.id === "number" && Number.isInteger(chat.id) ? chat.id : null;
  const type = cleanOptionalText(chat?.type) || null;
  if (chatId == null || !type) return false;
  const key = String(chatId);
  const previous = state.telegramChatCache[key];
  const now = new Date().toISOString();
  const next = {
    type,
    title: cleanOptionalText(chat?.title),
    lastSeenAt: now,
  };
  const changed = !previous
    || previous.type !== next.type
    || previous.title !== next.title;
  state.telegramChatCache[key] = changed ? next : { ...previous, lastSeenAt: next.lastSeenAt };
  const participantPatch = Object.fromEntries(participantUserIds.filter((userId) => Number.isInteger(userId)).map((userId) => [String(userId), { lastInteractedAt: now }]));
  if (changed || Object.keys(participantPatch).length > 0 || !previous) {
    upsertChatFile(key, { ...next, ...(Object.keys(participantPatch).length > 0 ? { participants: { ...(resolveChat(repoRoot(), key)?.participants || {}), ...participantPatch } } : {}) });
  }
  enqueueSync({
    repoRoot: repoRoot(),
    subject: "chat",
    operation: "refresh",
    selector: { chatId: key },
  });
  return changed;
}

export function listKnownTelegramUsers(allowedUserIds?: number[]): KnownTelegramUser[] {
  const allowed = allowedUserIdSet(allowedUserIds);
  const merged = new Map<string, KnownTelegramUser>();

  for (const [id, value] of Object.entries(loadUsers(repoRoot()))) {
    if (!/^[0-9]+$/.test(id)) continue;
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || (allowed && !allowed.has(numericId))) continue;
    merged.set(id, {
      id: numericId,
      username: value.username,
      firstName: undefined,
      lastName: undefined,
      displayName: value.displayName || value.username || id,
      aliases: value.aliases,
      lastSeenAt: value.lastSeenAt || "",
    });
  }

  for (const [id, value] of Object.entries(state.telegramUserCache)) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || (allowed && !allowed.has(numericId))) continue;
    const previous = merged.get(id);
    merged.set(id, {
      id: numericId,
      username: value.username ?? previous?.username,
      firstName: value.firstName ?? previous?.firstName,
      lastName: value.lastName ?? previous?.lastName,
      displayName: previous?.displayName || value.displayName || String(numericId),
      aliases: previous?.aliases,
      lastSeenAt: [value.lastSeenAt, previous?.lastSeenAt].filter(Boolean).sort().at(-1) || "",
    });
  }

  return [...merged.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function getTelegramUserDisplayName(userId: number | undefined, allowedUserIds?: number[]): string | null {
  const allowed = allowedUserIdSet(allowedUserIds);
  if (!userId || (allowed && !allowed.has(userId))) return null;
  const canonical = resolveUser(repoRoot(), userId);
  if (canonical) return canonical.username ? `${canonical.displayName || canonical.username} (@${canonical.username})` : canonical.displayName || null;
  const user = state.telegramUserCache[String(userId)];
  if (!user) return null;
  return user.username ? `${user.displayName} (@${user.username})` : user.displayName;
}

export function findTelegramUsers(input: { id?: number; username?: string; displayName?: string; alias?: string }, allowedUserIds?: number[]): KnownTelegramUser[] {
  const allowed = allowedUserIdSet(allowedUserIds);
  if (typeof input.id === "number" && Number.isInteger(input.id)) {
    if (allowed && !allowed.has(input.id)) return [];
    const canonical = resolveUser(repoRoot(), input.id);
    if (canonical) {
      return [{
        id: input.id,
        username: canonical.username,
        firstName: undefined,
        lastName: undefined,
        displayName: canonical.displayName || canonical.username || String(input.id),
        aliases: canonical.aliases,
        lastSeenAt: canonical.lastSeenAt || "",
      }];
    }
    const direct = state.telegramUserCache[String(input.id)];
    if (direct) {
      return [{
        id: input.id,
        username: direct.username,
        firstName: direct.firstName,
        lastName: direct.lastName,
        displayName: direct.displayName,
        lastSeenAt: direct.lastSeenAt,
      }];
    }
    return [];
  }

  const candidates = [input.username, input.alias, input.displayName]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map(normalizeLookupKey);
  if (candidates.length === 0) return [];

  return listKnownTelegramUsers(allowedUserIds).filter((user) => {
    const keys = new Set(
      [user.username, user.displayName, ...(user.aliases || [])]
        .filter((item): item is string => Boolean(item && item.trim()))
        .map(normalizeLookupKey),
    );
    return candidates.some((candidate) => keys.has(candidate));
  });
}

export function listKnownTelegramChats(): KnownTelegramChat[] {
  const merged = new Map<string, KnownTelegramChat>();

  for (const [id, value] of Object.entries(loadChats(repoRoot()))) {
    if (!/^-?[0-9]+$/.test(id)) continue;
    const numericId = Number(id);
    if (!Number.isInteger(numericId)) continue;
    merged.set(id, {
      id: numericId,
      type: value.type || "private",
      title: value.title,
      lastSeenAt: value.lastSeenAt || "",
    });
  }

  for (const [id, value] of Object.entries(state.telegramChatCache)) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId)) continue;
    const previous = merged.get(id);
    merged.set(id, {
      id: numericId,
      type: value.type || previous?.type || "private",
      title: value.title ?? previous?.title,
      lastSeenAt: [value.lastSeenAt, previous?.lastSeenAt].filter(Boolean).sort().at(-1) || "",
    });
  }

  return [...merged.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function findTelegramChats(input: { id?: number; username?: string; title?: string; displayName?: string }): KnownTelegramChat[] {
  if (typeof input.id === "number" && Number.isInteger(input.id)) {
    const canonical = resolveChat(repoRoot(), input.id);
    if (canonical) return [{ id: input.id, type: canonical.type || "private", title: canonical.title, lastSeenAt: canonical.lastSeenAt || "" }];
    const direct = state.telegramChatCache[String(input.id)];
    return direct ? [{ id: input.id, type: direct.type, title: direct.title, lastSeenAt: direct.lastSeenAt }] : [];
  }

  const candidates = [input.username, input.title, input.displayName]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map(normalizeLookupKey);
  if (candidates.length === 0) return [];

  return listKnownTelegramChats().filter((chat) => {
    const keys = new Set(
      [chat.title]
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map(normalizeLookupKey),
    );
    return candidates.some((candidate) => keys.has(candidate));
  });
}
