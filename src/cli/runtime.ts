import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "bot/app/config";
import { loadPersistentState, persistState, rememberPendingAuthorization, state } from "bot/app/state";
import { ensureAdminUserAccessLevel, resolveStoredUserId } from "bot/operations/access/roles";
import { hasUserAccessLevel } from "bot/operations/access/control";
import { invalidateContextStoreCache } from "bot/operations/context/store";
import type { AppConfig } from "bot/app/types";
import { AiService } from "bot/ai";
import { ScheduleEngine } from "bot/operations/events";

export type CliArgs = Record<string, unknown>;

export class CliOutput extends Error {
  constructor(readonly value: unknown) {
    super("cli-output");
  }
}

export type RepoCliContext = {
  config: AppConfig;
  args: CliArgs;
  scheduleEngine: ScheduleEngine;
  output: (value: unknown) => never;
  nowIso: () => string;
  readJson: <T>(relativePath: string, fallback: T) => T;
  writeJson: (relativePath: string, value: unknown) => void;
  cleanText: (value: unknown) => string | undefined;
  asInt: (value: unknown) => number | undefined;
  parseObjectArg: (value: unknown) => Record<string, unknown> | undefined;
  requireAdminRequester: () => number;
  resolveUserLookup: () => {
    userId?: number;
    username?: string;
    displayName?: string;
    alias?: string;
    resolvedUserId?: number | null;
  };
  usersDoc: () => { users: Record<string, Record<string, unknown>> };
  logTextContent: (text: string) => string;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
  logError: (message: string) => void;
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function cleanText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function asInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

export function asPositiveNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function parseObjectArg(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function logTextContent(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 500) return JSON.stringify(trimmed);
  return `${JSON.stringify(trimmed.slice(0, 500))}...[truncated chars=${trimmed.length}]`;
}

export function summarizeArgsForLog(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (!json) return "{}";
    return json.length <= 800 ? json : `${json.slice(0, 800)}...[truncated chars=${json.length}]`;
  } catch {
    return "[unserializable-args]";
  }
}

export function appendCliLogLine(config: AppConfig, level: "INFO" | "WARN" | "ERROR", message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  try {
    mkdirSync(path.dirname(config.paths.logFile), { recursive: true });
    appendFileSync(config.paths.logFile, line, "utf8");
  } catch {
    // ignore file logging failures
  }
}

export function emitCliTerminalLine(config: AppConfig, level: "INFO" | "WARN" | "ERROR", message: string): void {
  const line = `[repo-cli] ${message}`;
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // ignore terminal logging failures
  }
  appendCliLogLine(config, level, `repo cli terminal ${message}`);
}

export async function initializeRepoCli(args: CliArgs): Promise<RepoCliContext> {
  const config = loadConfig();
  await loadPersistentState(config.paths.stateFile);
  await ensureAdminUserAccessLevel(config);
  const scheduleEngine = new ScheduleEngine(config, new AiService(config));

  const output = (value: unknown): never => {
    throw new CliOutput(value);
  };

  const readJson = <T>(relativePath: string, fallback: T): T => {
    const filePath = path.join(config.paths.repoRoot, relativePath);
    try {
      return JSON.parse(readFileSync(filePath, "utf8")) as T;
    } catch {
      return fallback;
    }
  };

  const writeJson = (relativePath: string, value: unknown): void => {
    const filePath = path.join(config.paths.repoRoot, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    invalidateContextStoreCache(filePath);
  };

  const usersDoc = (): { users: Record<string, Record<string, unknown>> } => {
    const parsed = readJson<{ users?: Record<string, Record<string, unknown>> }>("system/users.json", { users: {} });
    return { users: parsed.users && typeof parsed.users === "object" ? parsed.users : {} };
  };

  const requireAdminRequester = (): number => {
    const requesterUserId = asInt(args.requesterUserId);
    if (!requesterUserId || !hasUserAccessLevel(config, requesterUserId, "admin")) output({ ok: false, error: "admin-only-operation" });
    return requesterUserId as number;
  };

  const resolveUserLookup = () => {
    const userId = asInt(args.userId);
    const username = cleanText(args.username);
    const displayName = cleanText(args.displayName);
    const alias = cleanText(args.alias) || cleanText(args.query);
    const resolvedUserId = resolveStoredUserId(config, { userId, username, displayName, alias });
    return { userId, username, displayName, alias, resolvedUserId };
  };

  return {
    config,
    args,
    scheduleEngine,
    output,
    nowIso,
    readJson,
    writeJson,
    cleanText,
    asInt,
    parseObjectArg,
    requireAdminRequester,
    resolveUserLookup,
    usersDoc,
    logTextContent,
    logInfo: (message: string) => emitCliTerminalLine(config, "INFO", message),
    logWarn: (message: string) => emitCliTerminalLine(config, "WARN", message),
    logError: (message: string) => emitCliTerminalLine(config, "ERROR", message),
  };
}

function resolvePendingAuthorizationExpiresAt(args: CliArgs, now = Date.now()): string | null {
  const explicitExpiresAt = cleanText(args.expiresAt);
  if (explicitExpiresAt) {
    const parsed = Date.parse(explicitExpiresAt);
    if (!Number.isFinite(parsed) || parsed <= now) return null;
    return new Date(parsed).toISOString();
  }

  const durationMinutes = asPositiveNumber(args.durationMinutes);
  if (durationMinutes) return new Date(now + durationMinutes * 60 * 1000).toISOString();

  return new Date(now + 24 * 60 * 60 * 1000).toISOString();
}

export async function addPendingAuthorization(context: RepoCliContext): Promise<void> {
  const { args, output, requireAdminRequester, cleanText, asInt, nowIso, config } = context;
  requireAdminRequester();
  const username = cleanText(args.username);
  context.logInfo(`auth:add-pending: creating pending authorization for ${username || "unknown"}`);
  const createdBy = asInt(args.createdBy);
  const expiresAt = resolvePendingAuthorizationExpiresAt(args);
  if (!username || !createdBy) output({ ok: false, error: "missing-username-or-createdBy" });
  if (!expiresAt) output({ ok: false, error: "invalid-expiresAt" });
  rememberPendingAuthorization({ kind: "allowed", username: username as string, createdBy: createdBy as number, createdAt: nowIso(), expiresAt: expiresAt as string });
  await persistState(config.paths.stateFile);
  output({ ok: true, pendingAuthorizations: state.pendingAuthorizations, expiresAt });
}

export async function logCliInvocation(config: AppConfig, command: string, rawDomain: string, args: CliArgs): Promise<void> {
  appendCliLogLine(config, "INFO", `repo cli invoke command=${command} raw=${rawDomain} args=${summarizeArgsForLog(args)}`);
}
