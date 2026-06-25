import { existsSync } from "node:fs";
import path from "node:path";
import { clearStoredUserAccessLevel, setStoredUserAccessLevel } from "bot/operations/access/roles";
import { loadUsers, resolveUser } from "bot/operations/context/store";
import type { RepoToolContext } from "bot/tools/runtime";

function normalizeRulesInput(value: unknown): string[] | undefined {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => typeof item === "string" && item.trim() ? item.trim() : undefined)
    .filter((item): item is string => Boolean(item));
  const deduped = Array.from(new Set(items));
  return deduped.length > 0 ? deduped : undefined;
}

function resolveEffectiveUser(context: RepoToolContext): { userId?: number; username?: string; displayName?: string; effectiveUserId?: number } {
  const { userId, username, displayName, resolvedUserId } = context.resolveUserLookup();
  return { userId, username, displayName, effectiveUserId: resolvedUserId ?? userId };
}

function updateUserField(context: RepoToolContext, field: "timezone" | "personPath", value: string): { effectiveUserId: number; user: Record<string, unknown>; changed: boolean } {
  const { nowIso, output } = context;
  context.requireAdminRequester();
  const { effectiveUserId } = resolveEffectiveUser(context);
  if (!effectiveUserId) {
    output({ ok: false, error: `userId-required-for-${field}` });
    throw new Error(`unreachable: ${field} output returned`);
  }
  const previous = resolveUser(context.config.paths.repoRoot, effectiveUserId) || {};
  const next = updateUserDoc(context, effectiveUserId, (current) => ({
    ...current,
    [field]: value,
    updatedAt: nowIso(),
  }));
  return { effectiveUserId: effectiveUserId as number, user: next, changed: JSON.stringify(previous) !== JSON.stringify(next) };
}

function updateUserDoc(context: RepoToolContext, effectiveUserId: number, mutate: (previous: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown> {
  const { usersDoc, writeJson, config } = context;
  const doc = usersDoc();
  const key = String(effectiveUserId);
  const previous = doc.users[key] || {};
  const next = mutate(previous);
  doc.users[key] = typeof next.timezone === "string" && next.timezone.trim()
    ? next
    : { ...next, timezone: config.bot.defaultTimezone };
  writeJson("system/users.json", doc);
  return doc.users[key];
}

export async function handleUsersList(context: RepoToolContext): Promise<void> {
  context.requireAdminRequester();
  context.logInfo("users:list: loading users");
  context.output({ ok: true, users: loadUsers(context.config.paths.repoRoot, { defaultTimezone: context.config.bot.defaultTimezone }) });
}

export async function handleUsersGet(context: RepoToolContext): Promise<void> {
  context.requireAdminRequester();
  const { resolvedUserId } = context.resolveUserLookup();
  context.logInfo(`users:get: resolving user ${resolvedUserId ?? "unknown"}`);
  context.output({ ok: true, userId: resolvedUserId, user: resolvedUserId ? resolveUser(context.config.paths.repoRoot, resolvedUserId, { defaultTimezone: context.config.bot.defaultTimezone }) || null : null });
}

export async function handleUsersSetAccess(context: RepoToolContext): Promise<void> {
  const { args, cleanText, output } = context;
  context.requireAdminRequester();
  const { username, displayName, resolvedUserId } = context.resolveUserLookup();
  const accessLevel = cleanText(args.accessLevel);
  context.logInfo(`users:set-access: updating user ${resolvedUserId ?? username ?? displayName ?? "unknown"}`);
  if (!resolvedUserId) {
    output({ ok: false, error: "user-not-resolved" });
    return;
  }
  if (accessLevel === undefined || accessLevel === null || accessLevel === "" || accessLevel === "none" || accessLevel === "clear") {
    const changed = await clearStoredUserAccessLevel(context.config, resolvedUserId as number, { username, displayName, lastSeenAt: cleanText(args.lastSeenAt) });
    output({ ok: true, changed, userId: resolvedUserId, accessLevel: null });
  }
  if (accessLevel !== "allowed" && accessLevel !== "trusted") output({ ok: false, error: "invalid-access-level" });
  const changed = await setStoredUserAccessLevel(context.config, resolvedUserId as number, accessLevel as "allowed" | "trusted", { username, displayName, lastSeenAt: cleanText(args.lastSeenAt) });
  output({ ok: true, changed, userId: resolvedUserId, accessLevel });
}

export async function handleUsersSetTimezone(context: RepoToolContext): Promise<void> {
  const value = context.cleanText(context.args.timezone);
  if (!value) context.output({ ok: false, error: "missing-timezone" });
  context.logInfo(`users:set-timezone: setting timezone to ${value}`);
  const result = updateUserField(context, "timezone", value as string);
  context.output({ ok: true, userId: result.effectiveUserId, changed: result.changed, user: result.user });
}

export async function handleUsersSetPersonPath(context: RepoToolContext): Promise<void> {
  const { args, cleanText, output, nowIso } = context;
  context.requireAdminRequester();
  const { effectiveUserId } = resolveEffectiveUser(context);
  context.logInfo(`users:set-person-path: updating user ${effectiveUserId ?? "unknown"}`);
  if (!effectiveUserId) {
    output({ ok: false, error: "userId-required-for-personPath" });
    return;
  }

  const rawPath = cleanText(args.personPath);
  if (rawPath === undefined) {
    output({ ok: false, error: "missing-personPath" });
    return;
  }

  if (rawPath === "clear" || rawPath === "none") {
    const previous = resolveUser(context.config.paths.repoRoot, effectiveUserId) || {};
    const next = updateUserDoc(context, effectiveUserId, (current) => {
      const { personPath: _removed, ...rest } = current;
      return { ...rest, updatedAt: nowIso() };
    });
    output({ ok: true, changed: JSON.stringify(previous) !== JSON.stringify(next), userId: effectiveUserId, user: next });
    return;
  }

  if (path.isAbsolute(rawPath)) {
    output({ ok: false, error: "personPath-must-be-relative" });
    return;
  }
  if (!/^memory\/people\/(?:.+\/)?README\.md$/i.test(rawPath)) {
    output({ ok: false, error: "invalid-personPath" });
    return;
  }
  const absolutePath = path.join(context.config.paths.repoRoot, rawPath);
  if (!existsSync(absolutePath)) {
    output({ ok: false, error: "personPath-not-found" });
    return;
  }

  const previous = resolveUser(context.config.paths.repoRoot, effectiveUserId) || {};
  const next = updateUserDoc(context, effectiveUserId, (current) => ({
    ...current,
    personPath: rawPath,
    updatedAt: nowIso(),
  }));
  output({ ok: true, changed: JSON.stringify(previous) !== JSON.stringify(next), userId: effectiveUserId, user: next });
}

export async function handleUsersAddRule(context: RepoToolContext): Promise<void> {
  const { args, cleanText, nowIso, output } = context;
  context.requireAdminRequester();
  const { effectiveUserId } = resolveEffectiveUser(context);
  context.logInfo(`users:add-rule: updating user ${effectiveUserId ?? "unknown"}`);
  if (!effectiveUserId) {
    output({ ok: false, error: "userId-required-for-rule" });
    return;
  }
  const rule = cleanText(args.rule);
  if (!rule) output({ ok: false, error: "missing-rule" });
  const previous = resolveUser(context.config.paths.repoRoot, effectiveUserId) || {};
  const next = updateUserDoc(context, effectiveUserId, (current) => {
    const existing = normalizeRulesInput(current.rules) || [];
    const merged = Array.from(new Set([...existing, rule as string]));
    return { ...current, rules: merged, updatedAt: nowIso() };
  });
  output({ ok: true, changed: JSON.stringify(previous) !== JSON.stringify(next), userId: effectiveUserId, user: next });
}

export async function handleUsersSetRules(context: RepoToolContext): Promise<void> {
  const { args, nowIso, output } = context;
  context.requireAdminRequester();
  const { effectiveUserId } = resolveEffectiveUser(context);
  context.logInfo(`users:set-rules: replacing rules for user ${effectiveUserId ?? "unknown"}`);
  if (!effectiveUserId) {
    output({ ok: false, error: "userId-required-for-rules" });
    return;
  }
  const normalizedRules = normalizeRulesInput(args.rules);
  if (normalizedRules == null && !Array.isArray(args.rules)) output({ ok: false, error: "missing-rules" });
  const previous = resolveUser(context.config.paths.repoRoot, effectiveUserId) || {};
  const next = updateUserDoc(context, effectiveUserId, (current) => ({
    ...current,
    rules: normalizedRules || [],
    updatedAt: nowIso(),
  }));
  output({ ok: true, changed: JSON.stringify(previous) !== JSON.stringify(next), userId: effectiveUserId, user: next });
}
