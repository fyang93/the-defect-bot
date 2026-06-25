import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PendingAuthorization, SessionState, UploadedFile } from "./types";
import { enqueueSync } from "bot/operations/maintenance/sync";

const RECENT_UPLOADS_TTL_MS = 30 * 60 * 1000;
let persistentStateFilePath: string | null = null;

export const state: SessionState = {
  model: null,
  lastActivityAt: null,
  lastMaintainedAt: null,
  recentUploadsByScope: {},
  recentClarificationsByScope: {},
  userTimezoneCache: {},
  telegramUserCache: {},
  telegramChatCache: {},
  pendingAuthorizations: [],
};

function cleanOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeLookupKey(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

function normalizePendingAuthorization(value: unknown): PendingAuthorization | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind === "allowed" ? "allowed" : null;
  const username = cleanOptionalText(record.username)?.replace(/^@+/, "").toLowerCase();
  const createdBy = Number(record.createdBy);
  const createdAt = cleanOptionalText(record.createdAt);
  const expiresAt = cleanOptionalText(record.expiresAt);
  if (!kind || !username || !Number.isInteger(createdBy) || !createdAt || !expiresAt) return null;
  return { kind, username, createdBy, createdAt, expiresAt };
}

function repoRootFromStateFile(filePath: string): string {
  return path.dirname(path.dirname(filePath));
}

function hydrateKnownEntities(repoRoot: string): void {
  state.telegramUserCache = {};
  state.telegramChatCache = {};
  state.userTimezoneCache = {};

  try {
    const usersRaw = JSON.parse(readFileSync(path.join(repoRoot, "system", "users.json"), "utf8")) as { users?: Record<string, unknown> };
    const users = usersRaw.users && typeof usersRaw.users === "object" ? usersRaw.users : {};
    const nextUsers: SessionState["telegramUserCache"] = {};
    const nextTimezones: SessionState["userTimezoneCache"] = {};
    for (const [userId, value] of Object.entries(users)) {
      if (!/^[0-9]+$/.test(userId)) continue;
      const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const username = cleanOptionalText(record.username);
      const displayName = cleanOptionalText(record.displayName) || (username ? `@${username}` : "Telegram user");
      const lastSeenAt = cleanOptionalText(record.lastSeenAt) || new Date().toISOString();
      const languageCode = cleanOptionalText(record.languageCode) || cleanOptionalText(record.language_code);
      nextUsers[userId] = { username, displayName, lastSeenAt, languageCode };
      const timezone = cleanOptionalText(record.timezone);
      if (timezone) nextTimezones[userId] = { timezone, updatedAt: cleanOptionalText(record.updatedAt) || new Date().toISOString() };
    }
    state.telegramUserCache = nextUsers;
    state.userTimezoneCache = nextTimezones;
  } catch {
    state.telegramUserCache = {};
    state.userTimezoneCache = {};
  }

  try {
    const chatsRaw = JSON.parse(readFileSync(path.join(repoRoot, "system", "chats.json"), "utf8")) as { chats?: Record<string, unknown> };
    const chats = chatsRaw.chats && typeof chatsRaw.chats === "object" ? chatsRaw.chats : {};
    const nextChats: SessionState["telegramChatCache"] = {};
    for (const [chatId, value] of Object.entries(chats)) {
      if (!/^-?[0-9]+$/.test(chatId)) continue;
      const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const type = cleanOptionalText(record.type) || "private";
      const title = cleanOptionalText(record.title);
      const lastSeenAt = cleanOptionalText(record.lastSeenAt) || new Date().toISOString();
      nextChats[chatId] = { type, title, lastSeenAt };
    }
    state.telegramChatCache = nextChats;
  } catch {
    state.telegramChatCache = {};
  }
}

function usersFilePath(): string | null {
  return persistentStateFilePath ? path.join(repoRootFromStateFile(persistentStateFilePath), "system", "users.json") : null;
}

function readUserRecord(userId: string): Record<string, unknown> | null {
  const filePath = usersFilePath();
  if (!filePath) return null;
  try {
    const parsed = existsSync(filePath)
      ? JSON.parse(readFileSync(filePath, "utf8")) as { users?: Record<string, unknown> }
      : { users: {} };
    const users = parsed.users && typeof parsed.users === "object" ? parsed.users : {};
    return users[userId] && typeof users[userId] === "object" ? users[userId] as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function updateUserRecord(userId: string, updater: (record: Record<string, unknown>) => Record<string, unknown>): void {
  const filePath = usersFilePath();
  if (!filePath) return;
  try {
    const parsed = existsSync(filePath)
      ? JSON.parse(readFileSync(filePath, "utf8")) as { users?: Record<string, unknown> }
      : { users: {} };
    const users = parsed.users && typeof parsed.users === "object" ? parsed.users : {};
    const current = users[userId] && typeof users[userId] === "object" ? users[userId] as Record<string, unknown> : null;
    if (!current) return;
    const next = updater(current);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    users[userId] = next;
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ users }, null, 2) + "\n", "utf8");
  } catch {
    // ignore sync persistence failures
  }
}

export async function loadPersistentState(filePath: string): Promise<void> {
  persistentStateFilePath = filePath;
  let loadedRaw: string | null = null;
  try {
    loadedRaw = await readFile(filePath, "utf8");
  } catch {
    const legacyPath = path.join(path.dirname(filePath), "runtime-state.json");
    try {
      loadedRaw = await readFile(legacyPath, "utf8");
    } catch {
      loadedRaw = null;
    }
  }

  try {
    const parsed = loadedRaw ? JSON.parse(loadedRaw) as {
      model?: unknown;
      lastMaintainedAt?: unknown;
      pendingAuthorizations?: unknown;
    } : {};
    state.model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : null;
    state.lastMaintainedAt = typeof parsed.lastMaintainedAt === "string" && parsed.lastMaintainedAt.trim() ? parsed.lastMaintainedAt.trim() : null;
    state.pendingAuthorizations = Array.isArray(parsed.pendingAuthorizations)
      ? parsed.pendingAuthorizations.map(normalizePendingAuthorization).filter((item): item is PendingAuthorization => Boolean(item))
      : [];
    state.recentUploadsByScope = {};
    state.recentClarificationsByScope = {};
  } catch {
    state.model = null;
    state.lastMaintainedAt = null;
    state.pendingAuthorizations = [];
    state.recentUploadsByScope = {};
    state.recentClarificationsByScope = {};
  }
  hydrateKnownEntities(repoRootFromStateFile(filePath));
}

export async function reloadPendingAuthorizations(filePath: string): Promise<void> {
  persistentStateFilePath = filePath;
  try {
    const loadedRaw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(loadedRaw) as { pendingAuthorizations?: unknown };
    state.pendingAuthorizations = Array.isArray(parsed.pendingAuthorizations)
      ? parsed.pendingAuthorizations.map(normalizePendingAuthorization).filter((item): item is PendingAuthorization => Boolean(item))
      : [];
  } catch {
    state.pendingAuthorizations = [];
  }
}

export async function persistState(filePath: string): Promise<void> {
  persistentStateFilePath = filePath;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({
      model: state.model,
      lastMaintainedAt: state.lastMaintainedAt,
      pendingAuthorizations: state.pendingAuthorizations,
    }, null, 2) + "\n",
    "utf8",
  );
}

export function touchActivity(): void {
  state.lastActivityAt = new Date().toISOString();
}

export function currentModel(): string {
  return state.model || "project default";
}

export function getUserTimezone(userId: number | undefined): string | null {
  if (!userId) return null;
  const userIdKey = String(userId);
  const canonical = readUserRecord(userIdKey);
  const canonicalTimezone = cleanOptionalText(canonical?.timezone);
  if (canonicalTimezone) {
    state.userTimezoneCache[userIdKey] = { timezone: canonicalTimezone, updatedAt: cleanOptionalText(canonical?.updatedAt) || new Date().toISOString() };
    return canonicalTimezone;
  }
  return state.userTimezoneCache[userIdKey]?.timezone || null;
}

export function rememberUserTimezone(userId: number | undefined, timezone: string): void {
  if (!userId || !timezone.trim()) return;
  const normalized = timezone.trim();
  const userIdKey = String(userId);
  const previous = state.userTimezoneCache[userIdKey];
  if (previous?.timezone === normalized) return;
  const updatedAt = new Date().toISOString();
  state.userTimezoneCache[userIdKey] = { timezone: normalized, updatedAt };
  updateUserRecord(userIdKey, (current) => ({ ...current, timezone: normalized, updatedAt }));
  const repoRoot = persistentStateFilePath ? repoRootFromStateFile(persistentStateFilePath) : null;
  if (repoRoot) {
    enqueueSync({
      repoRoot,
      subject: "user",
      operation: "refresh",
      selector: { userId: userIdKey },
    });
  }
}

export function rememberPendingAuthorization(input: PendingAuthorization): void {
  const username = normalizeLookupKey(input.username);
  state.pendingAuthorizations = state.pendingAuthorizations.filter((item) => !(item.kind === input.kind && item.username === username));
  state.pendingAuthorizations.push({ ...input, username });
}

export function pruneExpiredPendingAuthorizations(now = new Date()): number {
  const before = state.pendingAuthorizations.length;
  state.pendingAuthorizations = state.pendingAuthorizations.filter((item) => {
    const expiresAt = Date.parse(item.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > now.getTime();
  });
  return before - state.pendingAuthorizations.length;
}

export function consumePendingAllowedAuthorization(username: string | undefined, now = new Date()): PendingAuthorization | null {
  const normalized = normalizeLookupKey(username || "");
  if (!normalized) return null;
  pruneExpiredPendingAuthorizations(now);
  const index = state.pendingAuthorizations.findIndex((item) => item.kind === "allowed" && item.username === normalized);
  if (index < 0) return null;
  const [match] = state.pendingAuthorizations.splice(index, 1);
  return match || null;
}

function uploadsKey(scopeKey: string | undefined): string {
  return scopeKey?.trim() || "global";
}

export function rememberUploads(scopeKey: string | undefined, files: UploadedFile[]): void {
  const key = uploadsKey(scopeKey);
  const existing = state.recentUploadsByScope[key]?.files || [];
  const merged = [...existing, ...files];
  const seen = new Set<string>();
  const unique = merged.filter((file) => {
    if (seen.has(file.absolutePath)) return false;
    seen.add(file.absolutePath);
    return true;
  });
  state.recentUploadsByScope[key] = { files: unique, recentUploadsAt: new Date().toISOString() };
}

export function retainRecentUploads(scopeKey: string | undefined, files: UploadedFile[]): void {
  const key = uploadsKey(scopeKey);
  state.recentUploadsByScope[key] = {
    files,
    recentUploadsAt: files.length === 0 ? null : (state.recentUploadsByScope[key]?.recentUploadsAt || new Date().toISOString()),
  };
}

export function clearRecentUploads(scopeKey?: string): void {
  if (scopeKey) {
    delete state.recentUploadsByScope[uploadsKey(scopeKey)];
    return;
  }
  state.recentUploadsByScope = {};
}

export function rememberRecentClarification(scopeKey: string | undefined, requestText: string, clarificationMessage: string): void {
  const key = uploadsKey(scopeKey);
  if (!requestText.trim() || !clarificationMessage.trim()) return;
  state.recentClarificationsByScope[key] = {
    requestText: requestText.trim(),
    clarificationMessage: clarificationMessage.trim(),
    updatedAt: new Date().toISOString(),
  };
}

export function getRecentClarification(scopeKey?: string): { requestText: string; clarificationMessage: string; updatedAt: string } | null {
  const entry = state.recentClarificationsByScope[uploadsKey(scopeKey)];
  return entry || null;
}

export function clearRecentClarification(scopeKey?: string): void {
  if (scopeKey) {
    delete state.recentClarificationsByScope[uploadsKey(scopeKey)];
    return;
  }
  state.recentClarificationsByScope = {};
}

export function hasRecentUploads(scopeKey?: string): boolean {
  return getRecentUploads(scopeKey).length > 0;
}

export function getRecentUploads(scopeKey?: string): UploadedFile[] {
  const bucket = state.recentUploadsByScope[uploadsKey(scopeKey)];
  if (!bucket?.recentUploadsAt) return [];
  const ageMs = Date.now() - new Date(bucket.recentUploadsAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > RECENT_UPLOADS_TTL_MS) {
    clearRecentUploads(scopeKey);
    return [];
  }
  return bucket.files;
}
