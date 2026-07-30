import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { AppConfig } from "bot/app/types";
import { state } from "bot/app/state";
import { invalidateContextStoreCache, loadChats, loadUsers, resolveChat } from "bot/operations/context/store";
import { enqueueSync } from "bot/operations/maintenance/sync";

export type KnownFeishuUser = { id: string; displayName: string; aliases?: string[]; lastSeenAt: string };
export type KnownFeishuChat = { id: string; type: "p2p" | "group" | "topic"; title?: string; lastSeenAt: string };

function clean(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function normalized(value: string): string { return value.trim().replace(/^@+/, "").toLowerCase(); }

function upsert(config: AppConfig, filename: "users.json" | "chats.json", rootKey: "users" | "chats", id: string, patch: Record<string, unknown>): void {
  const filePath = path.join(config.paths.repoRoot, "system", filename);
  try {
    const parsed = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown> : {};
    const records = parsed[rootKey] && typeof parsed[rootKey] === "object" ? parsed[rootKey] as Record<string, unknown> : {};
    const previous = records[id] && typeof records[id] === "object" ? records[id] as Record<string, unknown> : {};
    records[id] = { ...previous, ...patch, updatedAt: new Date().toISOString() };
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify({ [rootKey]: records }, null, 2)}\n`, "utf8");
    invalidateContextStoreCache(filePath);
  } catch { /* runtime cache remains usable */ }
}

export function rememberFeishuMessage(config: AppConfig, message: NormalizedMessage, chatTitle?: string, chatMode?: "p2p" | "group" | "topic"): void {
  const now = new Date().toISOString();
  const displayName = clean(message.senderName) || state.feishuUserCache[message.senderId]?.displayName || message.senderId;
  state.feishuUserCache[message.senderId] = { displayName, lastSeenAt: now };
  upsert(config, "users.json", "users", message.senderId, {
    displayName,
    lastSeenAt: now,
    ...(loadUsers(config.paths.repoRoot)[message.senderId]?.timezone ? {} : { timezone: config.bot.defaultTimezone }),
  });

  const type = chatMode || message.chatType;
  state.feishuChatCache[message.chatId] = { type, title: clean(chatTitle), lastSeenAt: now };
  const participants = { ...(resolveChat(config.paths.repoRoot, message.chatId)?.participants || {}), [message.senderId]: { lastInteractedAt: now } };
  upsert(config, "chats.json", "chats", message.chatId, { type, title: clean(chatTitle), participants, lastSeenAt: now });
  enqueueSync({ repoRoot: config.paths.repoRoot, subject: "user", operation: "refresh", selector: { userId: message.senderId } });
  enqueueSync({ repoRoot: config.paths.repoRoot, subject: "chat", operation: "refresh", selector: { chatId: message.chatId } });
}

export function listKnownFeishuUsers(config: AppConfig): KnownFeishuUser[] {
  const merged = new Map<string, KnownFeishuUser>();
  for (const [id, user] of Object.entries(loadUsers(config.paths.repoRoot))) merged.set(id, { id, displayName: user.displayName || id, aliases: user.aliases, lastSeenAt: user.lastSeenAt || "" });
  for (const [id, user] of Object.entries(state.feishuUserCache)) {
    const old = merged.get(id);
    merged.set(id, { id, displayName: old?.displayName || user.displayName, aliases: old?.aliases, lastSeenAt: [old?.lastSeenAt, user.lastSeenAt].filter(Boolean).sort().at(-1) || "" });
  }
  return [...merged.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function listKnownFeishuChats(config: AppConfig): KnownFeishuChat[] {
  const merged = new Map<string, KnownFeishuChat>();
  for (const [id, chat] of Object.entries(loadChats(config.paths.repoRoot))) merged.set(id, { id, type: chat.type || "group", title: chat.title, lastSeenAt: chat.lastSeenAt || "" });
  for (const [id, chat] of Object.entries(state.feishuChatCache)) {
    const old = merged.get(id);
    merged.set(id, { id, type: chat.type || old?.type || "group", title: old?.title || chat.title, lastSeenAt: [old?.lastSeenAt, chat.lastSeenAt].filter(Boolean).sort().at(-1) || "" });
  }
  return [...merged.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function findFeishuUsers(config: AppConfig, input: { id?: string; query?: string; displayName?: string }): KnownFeishuUser[] {
  if (input.id) return listKnownFeishuUsers(config).filter((item) => item.id === input.id);
  const keys = [input.query, input.displayName].map(clean).filter((item): item is string => Boolean(item)).map(normalized);
  return keys.length ? listKnownFeishuUsers(config).filter((user) => [user.displayName, ...(user.aliases || [])].some((name) => keys.includes(normalized(name)))) : [];
}

export function findFeishuChats(config: AppConfig, input: { id?: string; query?: string; title?: string }): KnownFeishuChat[] {
  if (input.id) return listKnownFeishuChats(config).filter((item) => item.id === input.id);
  const keys = [input.query, input.title].map(clean).filter((item): item is string => Boolean(item)).map(normalized);
  return keys.length ? listKnownFeishuChats(config).filter((chat) => chat.title && keys.includes(normalized(chat.title))) : [];
}
