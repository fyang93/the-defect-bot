import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadUsers, resolveUser } from "bot/operations/context/store";
import type { ToolContext } from "./runtime";

function list(value: unknown): string[] {
  const raw = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return Array.from(new Set(raw.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())));
}
function slug(value: string, fallback: string): string { return value.trim().toLowerCase().replace(/^@+/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || fallback; }
function effectiveId(context: ToolContext): string {
  const id = context.resolveUserLookup().resolvedUserId || context.asId(context.args.requesterUserId);
  if (!id) context.output({ ok: false, error: "user-not-resolved" });
  return id as string;
}
function update(context: ToolContext, id: string, mutate: (record: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown> {
  const doc = context.usersDoc();
  const next = mutate(doc.users[id] || {});
  doc.users[id] = typeof next.timezone === "string" && next.timezone.trim() ? next : { ...next, timezone: context.config.bot.defaultTimezone };
  context.writeJson("system/users.json", doc);
  return doc.users[id];
}

export async function handleUsersList(context: ToolContext): Promise<void> { context.output({ ok: true, users: loadUsers(context.config.paths.repoRoot, { defaultTimezone: context.config.bot.defaultTimezone }) }); }
export async function handleUsersGet(context: ToolContext): Promise<void> { const id = effectiveId(context); context.output({ ok: true, userId: id, user: resolveUser(context.config.paths.repoRoot, id, { defaultTimezone: context.config.bot.defaultTimezone }) || null }); }

export async function handleUsersSetTimezone(context: ToolContext): Promise<void> {
  const timezone = context.cleanText(context.args.timezone);
  if (!timezone) context.output({ ok: false, error: "missing-timezone" });
  const id = effectiveId(context); const previous = resolveUser(context.config.paths.repoRoot, id) || {};
  const user = update(context, id, (current) => ({ ...current, timezone, updatedAt: context.nowIso() }));
  context.output({ ok: true, changed: JSON.stringify(previous) !== JSON.stringify(user), userId: id, user });
}

export async function handleUsersSetPersonPath(context: ToolContext): Promise<void> {
  const id = effectiveId(context); const requested = context.cleanText(context.args.personPath);
  if (!requested) context.output({ ok: false, error: "missing-personPath" });
  if (path.isAbsolute(requested!) || !/^memory\/people\/(?:.+\/)?README\.md$/i.test(requested!)) context.output({ ok: false, error: "invalid-personPath" });
  if (!existsSync(path.join(context.config.paths.repoRoot, requested!))) context.output({ ok: false, error: "personPath-not-found" });
  const user = update(context, id, (current) => ({ ...current, personPath: requested, updatedAt: context.nowIso() }));
  context.output({ ok: true, changed: true, userId: id, user });
}

export async function handleUsersUpdateRules(context: ToolContext): Promise<void> {
  const id = effectiveId(context); const add = list(context.args.add); const remove = new Set(list(context.args.remove));
  if (!add.length && !remove.size) context.output({ ok: false, error: "missing-rule-updates" });
  const user = update(context, id, (current) => ({ ...current, rules: Array.from(new Set([...list(current.rules).filter((item) => !remove.has(item)), ...add])), updatedAt: context.nowIso() }));
  context.output({ ok: true, changed: true, userId: id, user });
}

export async function handleUsersRecordPerson(context: ToolContext): Promise<void> {
  const id = effectiveId(context); const previous = resolveUser(context.config.paths.repoRoot, id) || {};
  const requestedAliases = list(context.args.aliases); const facts = list(context.args.facts);
  const requestedName = context.cleanText(context.args.name);
  const name = requestedName || requestedAliases[0] || previous.displayName || id;
  const personPath = context.cleanText(context.args.personPath) || previous.personPath || `memory/people/${slug(name, `user-${id}`)}/README.md`;
  if (path.isAbsolute(personPath) || !/^memory\/people\/(?:.+\/)?README\.md$/i.test(personPath)) context.output({ ok: false, error: "invalid-personPath" });
  const absolutePath = path.join(context.config.paths.repoRoot, personPath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  const existing = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : `# ${name}\n`;
  const existingFacts = new Set(existing.split("\n").map((line) => line.replace(/^-\s*/, "").trim()));
  const missing = facts.filter((fact) => !existingFacts.has(fact));
  const markdown = missing.length ? `${existing.trimEnd()}${existing.includes("\n## Facts") ? "" : "\n\n## Facts"}\n${missing.map((fact) => `- ${fact}`).join("\n")}\n` : existing;
  writeFileSync(absolutePath, markdown, "utf8");
  const user = update(context, id, (current) => ({ ...current, aliases: Array.from(new Set([...list(current.aliases), ...requestedAliases, ...(requestedName ? [requestedName] : [])])), personPath, updatedAt: context.nowIso() }));
  context.output({ ok: true, changed: JSON.stringify(previous) !== JSON.stringify(user) || existing !== markdown, userId: id, personPath, user });
}

export async function handleUsersAddAlias(context: ToolContext): Promise<void> {
  const id = effectiveId(context); const alias = context.cleanText(context.args.alias);
  if (!alias) context.output({ ok: false, error: "missing-alias" });
  const user = update(context, id, (current) => ({ ...current, aliases: Array.from(new Set([...list(current.aliases), alias!])), updatedAt: context.nowIso() }));
  context.output({ ok: true, changed: true, userId: id, user });
}
