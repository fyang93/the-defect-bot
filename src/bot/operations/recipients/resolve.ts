import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "bot/app/types";
import { listAuthorizedUserIds } from "bot/operations/access/roles";
import { findTelegramChats, findTelegramUsers, listKnownTelegramChats, listKnownTelegramUsers } from "bot/telegram/registry";

export type RecipientCandidate = {
  recipientKind: "user" | "chat";
  recipientId: number;
  recipientLabel: string;
};

export type ResolveRecipientInput = {
  id?: number;
  recipientId?: number;
  query?: string;
  username?: string;
  displayName?: string;
  title?: string;
};


function cleanText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeName(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

function userLabel(user: { username?: string; displayName: string }): string {
  return user.username ? `${user.displayName} (@${user.username})` : user.displayName;
}

function dedupe(candidates: RecipientCandidate[]): RecipientCandidate[] {
  return Array.from(new Map(candidates.map((candidate) => [`${candidate.recipientKind}:${candidate.recipientId}`, candidate])).values());
}

export function listTelegramRecipients(config: AppConfig, kind: "groups" | "users" | "all" = "groups"): RecipientCandidate[] {
  const groups = kind === "users" ? [] : listKnownTelegramChats()
    .filter((chat) => chat.type !== "private")
    .map((chat) => ({ recipientKind: "chat" as const, recipientId: chat.id, recipientLabel: chat.title || String(chat.id) }));
  const users = kind === "groups" ? [] : listKnownTelegramUsers(listAuthorizedUserIds(config))
    .map((user) => ({ recipientKind: "user" as const, recipientId: user.id, recipientLabel: userLabel(user) }));
  return [...groups, ...users];
}

function memoryUsernamesForQuery(config: AppConfig, query: string): string[] {
  const peopleDir = path.join(config.paths.repoRoot, "memory", "people");
  const target = normalizeName(query);
  try {
    return readdirSync(peopleDir, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      const text = readFileSync(path.join(peopleDir, entry.name, "README.md"), "utf8");
      const names = [
        text.match(/^title:\s*(.+)$/m)?.[1],
        ...Array.from(text.matchAll(/aliases:\s*\[([^\]]+)\]/g)).flatMap((match) => match[1].split(",")),
      ].map((item) => item?.replace(/["']/g, "").trim()).filter((item): item is string => Boolean(item));
      if (!names.some((name) => normalizeName(name) === target)) return [];
      return Array.from(text.matchAll(/Telegram[：:]\s*@?([A-Za-z0-9_]+)/gi)).map((match) => match[1]);
    });
  } catch {
    return [];
  }
}

function memoryUserCandidates(config: AppConfig, query: string): RecipientCandidate[] {
  return memoryUsernamesForQuery(config, query)
    .flatMap((username) => findTelegramUsers({ username }, listAuthorizedUserIds(config)))
    .map((user) => ({ recipientKind: "user" as const, recipientId: user.id, recipientLabel: userLabel(user) }));
}

export function findTelegramRecipientCandidates(config: AppConfig, input: ResolveRecipientInput & { kind?: "groups" | "users" | "all" }): RecipientCandidate[] {
  const directId = input.id ?? input.recipientId;
  const query = cleanText(input.query);
  const explicitUsername = cleanText(input.username)?.replace(/^@+/, "");
  const username = explicitUsername || (query?.startsWith("@") ? query.replace(/^@+/, "") : undefined);
  const displayName = cleanText(input.displayName);
  const title = cleanText(input.title) || query;
  const kind = input.kind || "all";
  const matchedChats = kind === "users" ? [] : findTelegramChats({ id: directId, username, title, displayName }).filter((chat) => chat.type !== "private");
  const matchedUsers = kind === "groups" ? [] : findTelegramUsers({ id: directId, username, displayName, alias: query }, listAuthorizedUserIds(config));
  return dedupe([
    ...matchedChats.map((chat) => ({ recipientKind: "chat" as const, recipientId: chat.id, recipientLabel: chat.title || String(chat.id) })),
    ...matchedUsers.map((user) => ({ recipientKind: "user" as const, recipientId: user.id, recipientLabel: userLabel(user) })),
    ...(query && kind !== "groups" ? memoryUserCandidates(config, query) : []),
  ]);
}

export function listMatchingTelegramRecipients(config: AppConfig, input: { query?: string; kind?: "groups" | "users" | "all" }): RecipientCandidate[] {
  const query = cleanText(input.query);
  if (!query) return listTelegramRecipients(config, input.kind || "groups");
  return findTelegramRecipientCandidates(config, { query, kind: input.kind || "all" });
}