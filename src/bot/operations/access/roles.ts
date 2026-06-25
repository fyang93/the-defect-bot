import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "bot/app/types";
import { state } from "bot/app/state";
import { invalidateContextStoreCache, loadUsers, resolveUser, resolveUserByAlias, resolveUserByDisplayName, resolveUserByUsername, type UserRecord } from "bot/operations/context/store";

export type AccessLevel = "admin" | "trusted" | "allowed" | "none";
export type StoredUserAccessLevel = Exclude<AccessLevel, "none">;

type UserAccessLevelPatch = {
  accessLevel?: Exclude<StoredUserAccessLevel, "admin">;
  username?: string;
  displayName?: string;
  lastSeenAt?: string;
  updatedBy?: number;
};

function normalizeUsername(value: string | undefined): string | undefined {
  const normalized = typeof value === "string" ? value.trim().replace(/^@+/, "") : "";
  return normalized || undefined;
}

function usersFilePath(repoRoot: string): string {
  return path.join(repoRoot, "system", "users.json");
}

function normalizeStoredAccessLevel(value: unknown): StoredUserAccessLevel | undefined {
  return value === "admin" || value === "trusted" || value === "allowed" ? value : undefined;
}

async function readUsersDocument(repoRoot: string): Promise<{ users: Record<string, unknown> }> {
  try {
    const parsed = JSON.parse(await readFile(usersFilePath(repoRoot), "utf8")) as { users?: Record<string, unknown> };
    return { users: parsed.users && typeof parsed.users === "object" ? parsed.users : {} };
  } catch {
    return { users: {} };
  }
}

function buildDisplayName(username: string | undefined, existing: UserRecord | undefined, current: Record<string, unknown>): string | undefined {
  if (typeof current.displayName === "string" && current.displayName.trim()) return current.displayName.trim();
  if (existing?.displayName?.trim()) return existing.displayName.trim();
  if (username?.trim()) return `@${username.trim().replace(/^@+/, "")}`;
  return undefined;
}

export async function ensureAdminUserAccessLevel(config: AppConfig): Promise<boolean> {
  const adminUserId = config.telegram.adminUserId;
  if (!adminUserId || !Number.isInteger(adminUserId) || adminUserId <= 0) return false;
  const repoRoot = config.paths.repoRoot;
  const filePath = usersFilePath(repoRoot);
  const document = await readUsersDocument(repoRoot);
  const key = String(adminUserId);
  const current = document.users[key] && typeof document.users[key] === "object" ? document.users[key] as Record<string, unknown> : {};
  const existing = resolveUser(repoRoot, adminUserId);
  const username = existing?.username || (typeof current.username === "string" ? current.username.trim() : undefined);
  const displayName = buildDisplayName(username, existing, current);
  const now = new Date().toISOString();
  const { role: _legacyRole, roleUpdatedBy: _roleUpdatedBy, accessLevel: _currentAccessLevel, ...rest } = current;
  const next: Record<string, unknown> = {
    ...rest,
    ...(typeof rest.timezone === "string" && rest.timezone.trim() ? {} : { timezone: config.bot.defaultTimezone }),
    ...(username ? { username } : {}),
    ...(displayName ? { displayName } : {}),
    accessLevel: "admin",
    updatedAt: now,
  };
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  document.users[key] = next;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  invalidateContextStoreCache(filePath);
  return true;
}

export function accessLevelForUser(config: AppConfig, userId: number | undefined): AccessLevel {
  if (typeof userId !== "number") return "none";
  if (config.telegram.adminUserId === userId) return "admin";
  const accessLevel = normalizeStoredAccessLevel(resolveUser(config.paths.repoRoot, userId)?.accessLevel);
  return accessLevel && accessLevel !== "admin" ? accessLevel : "none";
}

export function listAuthorizedUserIds(config: AppConfig): number[] {
  const ids = new Set<number>();
  if (config.telegram.adminUserId) ids.add(config.telegram.adminUserId);
  for (const [userId, user] of Object.entries(loadUsers(config.paths.repoRoot))) {
    const numericUserId = Number(userId);
    if (!Number.isInteger(numericUserId)) continue;
    const accessLevel = normalizeStoredAccessLevel(user.accessLevel);
    if (accessLevel && accessLevel !== "admin") ids.add(numericUserId);
  }
  return Array.from(ids);
}

export async function setStoredUserAccessLevel(
  config: AppConfig,
  userId: number,
  accessLevel: Exclude<StoredUserAccessLevel, "admin">,
  patch: UserAccessLevelPatch = {},
): Promise<boolean> {
  if (!Number.isInteger(userId) || userId <= 0) return false;
  if (config.telegram.adminUserId === userId) return false;
  const repoRoot = config.paths.repoRoot;
  const filePath = usersFilePath(repoRoot);
  const document = await readUsersDocument(repoRoot);
  const key = String(userId);
  const current = document.users[key] && typeof document.users[key] === "object" ? document.users[key] as Record<string, unknown> : {};
  const existing = resolveUser(repoRoot, userId);
  const username = normalizeUsername(patch.username)
    ? normalizeUsername(patch.username)
    : existing?.username || (typeof current.username === "string" ? current.username.trim() : undefined);
  const displayName = buildDisplayName(username, existing, current);
  const now = new Date().toISOString();
  const { role: _legacyRole, roleUpdatedBy: _roleUpdatedBy, accessLevel: _currentAccessLevel, ...rest } = current;
  const next: Record<string, unknown> = {
    ...rest,
    ...(typeof rest.timezone === "string" && rest.timezone.trim() ? {} : { timezone: config.bot.defaultTimezone }),
    ...(username ? { username } : {}),
    ...(displayName ? { displayName } : {}),
    ...(patch.lastSeenAt ? { lastSeenAt: patch.lastSeenAt } : {}),
    accessLevel,
    updatedAt: now,
  };
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  document.users[key] = next;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  invalidateContextStoreCache(filePath);
  return true;
}

export async function clearStoredUserAccessLevel(
  config: AppConfig,
  userId: number,
  patch: Omit<UserAccessLevelPatch, "accessLevel"> = {},
): Promise<boolean> {
  if (!Number.isInteger(userId) || userId <= 0) return false;
  if (config.telegram.adminUserId === userId) return false;
  const repoRoot = config.paths.repoRoot;
  const filePath = usersFilePath(repoRoot);
  const document = await readUsersDocument(repoRoot);
  const key = String(userId);
  const current = document.users[key] && typeof document.users[key] === "object" ? document.users[key] as Record<string, unknown> : {};
  const existing = resolveUser(repoRoot, userId);
  const username = normalizeUsername(patch.username)
    ? normalizeUsername(patch.username)
    : existing?.username || (typeof current.username === "string" ? current.username.trim() : undefined);
  const displayName = buildDisplayName(username, existing, current);
  const now = new Date().toISOString();
  const { role: _legacyRole, accessLevel: _currentAccessLevel, roleUpdatedBy: _roleUpdatedBy, ...rest } = current;
  const next: Record<string, unknown> = {
    ...rest,
    ...(typeof rest.timezone === "string" && rest.timezone.trim() ? {} : { timezone: config.bot.defaultTimezone }),
    ...(username ? { username } : {}),
    ...(displayName ? { displayName } : {}),
    ...(patch.lastSeenAt ? { lastSeenAt: patch.lastSeenAt } : {}),
    updatedAt: now,
  };
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  document.users[key] = next;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  invalidateContextStoreCache(filePath);
  return true;
}

export async function setStoredUserAccessLevels(
  config: AppConfig,
  entries: Array<{ userId: number; accessLevel: Exclude<StoredUserAccessLevel, "admin">; patch?: UserAccessLevelPatch }>,
): Promise<{ changedUserIds: number[]; unchangedUserIds: number[] }> {
  const changedUserIds: number[] = [];
  const unchangedUserIds: number[] = [];
  for (const entry of entries) {
    const changed = await setStoredUserAccessLevel(config, entry.userId, entry.accessLevel, entry.patch || {});
    if (changed) changedUserIds.push(entry.userId);
    else unchangedUserIds.push(entry.userId);
  }
  return { changedUserIds, unchangedUserIds };
}

export async function clearStoredUserAccessLevels(
  config: AppConfig,
  entries: Array<{ userId: number; patch?: Omit<UserAccessLevelPatch, "accessLevel"> }>,
): Promise<{ changedUserIds: number[]; unchangedUserIds: number[] }> {
  const changedUserIds: number[] = [];
  const unchangedUserIds: number[] = [];
  for (const entry of entries) {
    const changed = await clearStoredUserAccessLevel(config, entry.userId, entry.patch || {});
    if (changed) changedUserIds.push(entry.userId);
    else unchangedUserIds.push(entry.userId);
  }
  return { changedUserIds, unchangedUserIds };
}

export function resolveStoredUserId(config: AppConfig, input: { userId?: number; username?: string; displayName?: string; alias?: string }): number | null {
  if (Number.isInteger(input.userId) && (input.userId || 0) > 0) return input.userId || null;
  const username = normalizeUsername(input.username);
  if (username) {
    const usernameMatch = resolveUserByUsername(config.paths.repoRoot, username);
    if (usernameMatch) return Number(usernameMatch[0]);
    const runtimeUsernameMatch = Object.entries(state.telegramUserCache).find(([, user]) => normalizeUsername(user.username) === username);
    if (runtimeUsernameMatch) return Number(runtimeUsernameMatch[0]);
  }
  const aliasMatch = resolveUserByAlias(config.paths.repoRoot, input.alias || input.displayName);
  if (aliasMatch) return Number(aliasMatch[0]);
  const displayNameMatch = resolveUserByDisplayName(config.paths.repoRoot, input.displayName);
  if (displayNameMatch) return Number(displayNameMatch[0]);
  const normalizedDisplayName = typeof input.displayName === "string" ? input.displayName.trim().toLowerCase() : "";
  if (normalizedDisplayName) {
    const runtimeDisplayNameMatch = Object.entries(state.telegramUserCache).find(([, user]) => (user.displayName || "").trim().toLowerCase() === normalizedDisplayName);
    if (runtimeDisplayNameMatch) return Number(runtimeDisplayNameMatch[0]);
  }
  return null;
}
