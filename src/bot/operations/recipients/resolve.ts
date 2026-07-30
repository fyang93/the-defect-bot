import type { AppConfig } from "bot/app/types";
import { findFeishuChats, findFeishuUsers, listKnownFeishuChats, listKnownFeishuUsers } from "bot/feishu/registry";

export type RecipientCandidate = { recipientKind: "user" | "chat"; recipientId: string; recipientLabel: string };
export type ResolveRecipientInput = { id?: string; recipientId?: string; query?: string; displayName?: string; title?: string };

function clean(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function dedupe(items: RecipientCandidate[]): RecipientCandidate[] { return Array.from(new Map(items.map((item) => [`${item.recipientKind}:${item.recipientId}`, item])).values()); }

export function listFeishuRecipients(config: AppConfig, kind: "groups" | "users" | "all" = "groups"): RecipientCandidate[] {
  const chats = kind === "users" ? [] : listKnownFeishuChats(config).filter((chat) => chat.type !== "p2p").map((chat) => ({ recipientKind: "chat" as const, recipientId: chat.id, recipientLabel: chat.title || chat.id }));
  const users = kind === "groups" ? [] : listKnownFeishuUsers(config).map((user) => ({ recipientKind: "user" as const, recipientId: user.id, recipientLabel: user.displayName }));
  return [...chats, ...users];
}

export function findFeishuRecipientCandidates(config: AppConfig, input: ResolveRecipientInput & { kind?: "groups" | "users" | "all" }): RecipientCandidate[] {
  const id = input.id || input.recipientId;
  const query = clean(input.query);
  const kind = input.kind || "all";
  return dedupe([
    ...(kind === "users" ? [] : findFeishuChats(config, { id, query, title: input.title }).filter((chat) => chat.type !== "p2p").map((chat) => ({ recipientKind: "chat" as const, recipientId: chat.id, recipientLabel: chat.title || chat.id }))),
    ...(kind === "groups" ? [] : findFeishuUsers(config, { id, query, displayName: input.displayName }).map((user) => ({ recipientKind: "user" as const, recipientId: user.id, recipientLabel: user.displayName }))),
  ]);
}

export function listMatchingFeishuRecipients(config: AppConfig, input: { query?: string; kind?: "groups" | "users" | "all" }): RecipientCandidate[] {
  return clean(input.query) ? findFeishuRecipientCandidates(config, { query: input.query, kind: input.kind || "all" }) : listFeishuRecipients(config, input.kind || "groups");
}
