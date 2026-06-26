import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clearStoredUserAccessLevel, setStoredUserAccessLevel } from "bot/operations/access/roles";
import { loadUsers, resolveUser } from "bot/operations/context/store";
import type { ToolContext } from "bot/operations/tools/runtime";

function normalizeStringList(value: unknown): string[] | undefined {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => typeof item === "string" && item.trim() ? item.trim() : undefined)
    .filter((item): item is string => Boolean(item));
  const deduped = Array.from(new Set(items));
  return deduped.length > 0 ? deduped : undefined;
}

const normalizeRulesInput = normalizeStringList;

function personSlug(value: string | undefined, fallback: string): string {
  const slug = (value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function appendMissingFacts(markdown: string, facts: string[]): string {
  const existing = new Set(markdown.split("\n").map((line) => line.trim().replace(/^-\s*/, "")));
  const missing = facts.filter((fact) => !existing.has(fact));
  if (missing.length === 0) return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  const base = markdown.trimEnd();
  const section = base.includes("\n## Facts\n") || base.endsWith("\n## Facts") ? "" : "\n\n## Facts";
  return `${base}${section}\n${missing.map((fact) => `- ${fact}`).join("\n")}\n`;
}

function resolveEffectiveUser(context: ToolContext): { userId?: number; username?: string; displayName?: string; effectiveUserId?: number } {
  const { userId, username, displayName, resolvedUserId } = context.resolveUserLookup();
  return { userId, username, displayName, effectiveUserId: resolvedUserId ?? userId };
}

function updateUserField(context: ToolContext, field: "timezone" | "personPath", value: string): { effectiveUserId: number; user: Record<string, unknown>; changed: boolean } {
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

function updateUserDoc(context: ToolContext, effectiveUserId: number, mutate: (previous: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown> {
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

export async function handleUsersList(context: ToolContext): Promise<void> {
  context.requireAdminRequester();
  context.logInfo("user:list: loading users");
  context.output({ ok: true, users: loadUsers(context.config.paths.repoRoot, { defaultTimezone: context.config.bot.defaultTimezone }) });
}

export async function handleUsersGet(context: ToolContext): Promise<void> {
  context.requireAdminRequester();
  const { resolvedUserId } = context.resolveUserLookup();
  context.logInfo(`user:get: resolving user ${resolvedUserId ?? "unknown"}`);
  context.output({ ok: true, userId: resolvedUserId, user: resolvedUserId ? resolveUser(context.config.paths.repoRoot, resolvedUserId, { defaultTimezone: context.config.bot.defaultTimezone }) || null : null });
}

export async function handleUsersSetAccess(context: ToolContext): Promise<void> {
  const { args, cleanText, output } = context;
  context.requireAdminRequester();
  const { username, displayName, resolvedUserId } = context.resolveUserLookup();
  const accessLevel = cleanText(args.accessLevel);
  context.logInfo(`user:set-access: updating user ${resolvedUserId ?? username ?? displayName ?? "unknown"}`);
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

export async function handleUsersSetTimezone(context: ToolContext): Promise<void> {
  const value = context.cleanText(context.args.timezone);
  if (!value) context.output({ ok: false, error: "missing-timezone" });
  context.logInfo(`user_set_timezone: setting timezone to ${value}`);
  const result = updateUserField(context, "timezone", value as string);
  context.output({ ok: true, userId: result.effectiveUserId, changed: result.changed, user: result.user });
}

export async function handleUsersSetPersonPath(context: ToolContext): Promise<void> {
  const { args, cleanText, output, nowIso } = context;
  context.requireAdminRequester();
  const { effectiveUserId } = resolveEffectiveUser(context);
  context.logInfo(`user_set_person_path: updating user ${effectiveUserId ?? "unknown"}`);
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

export async function handleUsersUpdateRules(context: ToolContext): Promise<void> {
  const { args, nowIso, output } = context;
  context.requireAdminRequester();
  const { effectiveUserId } = resolveEffectiveUser(context);
  context.logInfo(`user_update_rules: updating rules for user ${effectiveUserId ?? "unknown"}`);
  if (!effectiveUserId) {
    output({ ok: false, error: "userId-required-for-rules" });
    return;
  }
  const add = normalizeRulesInput(args.add) || [];
  const remove = new Set(normalizeRulesInput(args.remove) || []);
  if (add.length === 0 && remove.size === 0) output({ ok: false, error: "missing-rule-updates" });
  const previous = resolveUser(context.config.paths.repoRoot, effectiveUserId) || {};
  const next = updateUserDoc(context, effectiveUserId, (current) => {
    const existing = normalizeRulesInput(current.rules) || [];
    const rules = Array.from(new Set([...existing.filter((rule) => !remove.has(rule)), ...add]));
    return { ...current, rules, updatedAt: nowIso() };
  });
  output({ ok: true, changed: JSON.stringify(previous) !== JSON.stringify(next), userId: effectiveUserId, user: next });
}

export async function handleUsersRecordPerson(context: ToolContext): Promise<void> {
  const { args, cleanText, nowIso, output } = context;
  context.requireAdminRequester();
  const { effectiveUserId } = resolveEffectiveUser(context);
  context.logInfo(`user_record_person: updating user ${effectiveUserId ?? "unknown"}`);
  if (!effectiveUserId) {
    output({ ok: false, error: "userId-required-for-person" });
    return;
  }

  const previous = resolveUser(context.config.paths.repoRoot, effectiveUserId) || {};
  const name = cleanText(args.name) || normalizeStringList(args.aliases)?.[0] || previous.displayName || previous.username || String(effectiveUserId);
  const aliases = normalizeStringList(args.aliases) || [];
  const facts = normalizeStringList(args.facts) || [];
  const requestedPath = cleanText(args.personPath);
  const personPath = requestedPath || previous.personPath || `memory/people/${personSlug(previous.username || name, `user-${effectiveUserId}`)}/README.md`;
  if (path.isAbsolute(personPath) || !/^memory\/people\/(?:.+\/)?README\.md$/i.test(personPath)) {
    output({ ok: false, error: "invalid-personPath" });
    return;
  }

  const absolutePath = path.join(context.config.paths.repoRoot, personPath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  const existing = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
  const username = typeof previous.username === "string" && previous.username.trim() ? previous.username.trim() : undefined;
  const header = existing || [
    `# ${name}`,
    aliases.length > 0 ? `Aliases: ${aliases.join(", ")}` : "",
    username ? `Telegram: @${username}` : "",
    facts.length > 0 ? "\n## Facts" : "",
  ].filter(Boolean).join("\n");
  const nextMarkdown = appendMissingFacts(header, facts);
  writeFileSync(absolutePath, nextMarkdown, "utf8");

  const next = updateUserDoc(context, effectiveUserId, (current) => {
    const mergedAliases = Array.from(new Set([...(normalizeStringList(current.aliases) || []), ...aliases, name].filter(Boolean)));
    return { ...current, aliases: mergedAliases, personPath, updatedAt: nowIso() };
  });
  output({ ok: true, changed: JSON.stringify(previous) !== JSON.stringify(next) || existing !== nextMarkdown, userId: effectiveUserId, personPath, user: next });
}

export async function handleUsersAddAlias(context: ToolContext): Promise<void> {
  const { args, cleanText, nowIso, output } = context;
  context.requireAdminRequester();
  const { effectiveUserId } = resolveEffectiveUser(context);
  context.logInfo(`user_add_alias: updating user ${effectiveUserId ?? "unknown"}`);
  if (!effectiveUserId) {
    output({ ok: false, error: "userId-required-for-alias" });
    return;
  }
  const alias = cleanText(args.alias);
  if (!alias) output({ ok: false, error: "missing-alias" });
  const previous = resolveUser(context.config.paths.repoRoot, effectiveUserId) || {};
  const next = updateUserDoc(context, effectiveUserId, (current) => {
    const existing = normalizeRulesInput(current.aliases) || [];
    const merged = Array.from(new Set([...existing, alias as string]));
    return { ...current, aliases: merged, updatedAt: nowIso() };
  });
  output({ ok: true, changed: JSON.stringify(previous) !== JSON.stringify(next), userId: effectiveUserId, user: next });
}