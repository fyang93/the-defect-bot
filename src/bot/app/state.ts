import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionState, UploadedFile } from "./types";
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
  feishuUserCache: {},
  feishuChatCache: {},
};

function cleanText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function repoRootFromStateFile(filePath: string): string {
  return path.dirname(path.dirname(filePath));
}

function hydrateKnownEntities(repoRoot: string): void {
  state.feishuUserCache = {};
  state.feishuChatCache = {};
  state.userTimezoneCache = {};
  try {
    const raw = JSON.parse(readFileSync(path.join(repoRoot, "system", "users.json"), "utf8")) as { users?: Record<string, unknown> };
    for (const [openId, value] of Object.entries(raw.users || {})) {
      const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const displayName = cleanText(record.displayName) || openId;
      const lastSeenAt = cleanText(record.lastSeenAt) || new Date().toISOString();
      state.feishuUserCache[openId] = { displayName, lastSeenAt };
      const timezone = cleanText(record.timezone);
      if (timezone) state.userTimezoneCache[openId] = { timezone, updatedAt: cleanText(record.updatedAt) || lastSeenAt };
    }
  } catch { /* registry is optional */ }
  try {
    const raw = JSON.parse(readFileSync(path.join(repoRoot, "system", "chats.json"), "utf8")) as { chats?: Record<string, unknown> };
    for (const [chatId, value] of Object.entries(raw.chats || {})) {
      const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const rawType = cleanText(record.type);
      const type = rawType === "p2p" || rawType === "topic" ? rawType : "group";
      state.feishuChatCache[chatId] = { type, title: cleanText(record.title), lastSeenAt: cleanText(record.lastSeenAt) || new Date().toISOString() };
    }
  } catch { /* registry is optional */ }
}

function usersFilePath(): string | null {
  return persistentStateFilePath ? path.join(repoRootFromStateFile(persistentStateFilePath), "system", "users.json") : null;
}

function readUserRecord(userId: string): Record<string, unknown> | null {
  const filePath = usersFilePath();
  if (!filePath) return null;
  try {
    const parsed = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) as { users?: Record<string, unknown> } : { users: {} };
    const value = parsed.users?.[userId];
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function updateUserRecord(userId: string, updater: (record: Record<string, unknown>) => Record<string, unknown>): void {
  const filePath = usersFilePath();
  if (!filePath) return;
  try {
    const parsed = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) as { users?: Record<string, unknown> } : { users: {} };
    const users = parsed.users && typeof parsed.users === "object" ? parsed.users : {};
    const current = users[userId];
    if (!current || typeof current !== "object") return;
    const next = updater(current as Record<string, unknown>);
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    users[userId] = next;
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify({ users }, null, 2)}\n`, "utf8");
  } catch { /* best effort */ }
}

export async function loadPersistentState(filePath: string): Promise<void> {
  persistentStateFilePath = filePath;
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    state.model = cleanText(parsed.model) || null;
    state.lastMaintainedAt = cleanText(parsed.lastMaintainedAt) || null;
  } catch {
    state.model = null;
    state.lastMaintainedAt = null;
  }
  state.recentUploadsByScope = {};
  state.recentClarificationsByScope = {};
  hydrateKnownEntities(repoRootFromStateFile(filePath));
}

export async function persistState(filePath: string): Promise<void> {
  persistentStateFilePath = filePath;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ model: state.model, lastMaintainedAt: state.lastMaintainedAt }, null, 2)}\n`, "utf8");
}

export function touchActivity(): void { state.lastActivityAt = new Date().toISOString(); }
export function currentModel(): string { return state.model || "project default"; }

export function getUserTimezone(userId: string | undefined): string | null {
  if (!userId) return null;
  const timezone = cleanText(readUserRecord(userId)?.timezone);
  if (timezone) {
    state.userTimezoneCache[userId] = { timezone, updatedAt: new Date().toISOString() };
    return timezone;
  }
  return state.userTimezoneCache[userId]?.timezone || null;
}

export function rememberUserTimezone(userId: string | undefined, timezone: string): void {
  if (!userId || !timezone.trim()) return;
  const normalized = timezone.trim();
  const updatedAt = new Date().toISOString();
  state.userTimezoneCache[userId] = { timezone: normalized, updatedAt };
  updateUserRecord(userId, (current) => ({ ...current, timezone: normalized, updatedAt }));
  if (persistentStateFilePath) enqueueSync({ repoRoot: repoRootFromStateFile(persistentStateFilePath), subject: "user", operation: "refresh", selector: { userId } });
}

function scopeKey(value: string | undefined): string { return value?.trim() || "global"; }

export function rememberUploads(scope: string | undefined, files: UploadedFile[]): void {
  const key = scopeKey(scope);
  const merged = [...(state.recentUploadsByScope[key]?.files || []), ...files];
  state.recentUploadsByScope[key] = {
    files: Array.from(new Map(merged.map((file) => [file.absolutePath, file])).values()),
    recentUploadsAt: new Date().toISOString(),
  };
}

export function retainRecentUploads(scope: string | undefined, files: UploadedFile[]): void {
  const key = scopeKey(scope);
  state.recentUploadsByScope[key] = { files, recentUploadsAt: files.length ? state.recentUploadsByScope[key]?.recentUploadsAt || new Date().toISOString() : null };
}

export function clearRecentUploads(scope?: string): void {
  if (scope) delete state.recentUploadsByScope[scopeKey(scope)];
  else state.recentUploadsByScope = {};
}

export function getRecentUploads(scope?: string): UploadedFile[] {
  const bucket = state.recentUploadsByScope[scopeKey(scope)];
  if (!bucket?.recentUploadsAt) return [];
  if (Date.now() - Date.parse(bucket.recentUploadsAt) > RECENT_UPLOADS_TTL_MS) {
    clearRecentUploads(scope);
    return [];
  }
  return bucket.files;
}

export function hasRecentUploads(scope?: string): boolean { return getRecentUploads(scope).length > 0; }

export function rememberRecentClarification(scope: string | undefined, requestText: string, clarificationMessage: string): void {
  if (!requestText.trim() || !clarificationMessage.trim()) return;
  state.recentClarificationsByScope[scopeKey(scope)] = { requestText: requestText.trim(), clarificationMessage: clarificationMessage.trim(), updatedAt: new Date().toISOString() };
}

export function getRecentClarification(scope?: string): { requestText: string; clarificationMessage: string; updatedAt: string } | null {
  return state.recentClarificationsByScope[scopeKey(scope)] || null;
}

export function clearRecentClarification(scope?: string): void {
  if (scope) delete state.recentClarificationsByScope[scopeKey(scope)];
  else state.recentClarificationsByScope = {};
}
