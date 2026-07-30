import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "bot/app/config";
import { loadPersistentState } from "bot/app/state";
import { migrateSystemStateForFeishu } from "bot/app/migrate";
import { invalidateContextStoreCache, resolveUserByAlias, resolveUserByDisplayName } from "bot/operations/context/store";
import type { AppConfig } from "bot/app/types";
import { AiService } from "bot/ai";
import { ScheduleEngine } from "bot/operations/events";

export type ToolArgs = Record<string, unknown>;
export class ToolOutput extends Error { constructor(readonly value: unknown) { super("tool-output"); } }
export type ToolContext = {
  config: AppConfig;
  args: ToolArgs;
  scheduleEngine: ScheduleEngine;
  output: (value: unknown) => never;
  nowIso: () => string;
  readJson: <T>(relativePath: string, fallback: T) => T;
  writeJson: (relativePath: string, value: unknown) => void;
  cleanText: (value: unknown) => string | undefined;
  asId: (value: unknown) => string | undefined;
  parseObjectArg: (value: unknown) => Record<string, unknown> | undefined;
  resolveUserLookup: () => { userId?: string; displayName?: string; alias?: string; resolvedUserId?: string };
  usersDoc: () => { users: Record<string, Record<string, unknown>> };
  logTextContent: (text: string) => string;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
  logError: (message: string) => void;
};

export function nowIso(): string { return new Date().toISOString(); }
export function cleanText(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
export function asId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
export function parseObjectArg(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return undefined;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined; } catch { return undefined; }
}
export function logTextContent(text: string): string { return text.trim().length <= 500 ? JSON.stringify(text.trim()) : `${JSON.stringify(text.trim().slice(0, 500))}...[truncated chars=${text.trim().length}]`; }
export function summarizeArgsForLog(value: unknown): string { try { const json = JSON.stringify(value) || "{}"; return json.length <= 800 ? json : `${json.slice(0, 800)}...[truncated chars=${json.length}]`; } catch { return "[unserializable-args]"; } }
export function appendToolLogLine(config: AppConfig, level: "INFO" | "WARN" | "ERROR", message: string): void {
  try { mkdirSync(path.dirname(config.paths.logFile), { recursive: true }); appendFileSync(config.paths.logFile, `[${new Date().toISOString()}] [${level}] ${message}\n`, "utf8"); } catch { /* ignore */ }
}
export function emitToolTerminalLine(config: AppConfig, level: "INFO" | "WARN" | "ERROR", message: string): void {
  try { process.stderr.write(`[bot-tool] ${message}\n`); } catch { /* ignore */ }
  appendToolLogLine(config, level, `tool operation terminal ${message}`);
}

export async function initializeToolContext(args: ToolArgs, configPath?: string): Promise<ToolContext> {
  const config = loadConfig(configPath);
  await migrateSystemStateForFeishu(config);
  await loadPersistentState(config.paths.stateFile);
  const output = (value: unknown): never => { throw new ToolOutput(value); };
  const readJson = <T>(relativePath: string, fallback: T): T => { try { return JSON.parse(readFileSync(path.join(config.paths.repoRoot, relativePath), "utf8")) as T; } catch { return fallback; } };
  const writeJson = (relativePath: string, value: unknown): void => {
    const filePath = path.join(config.paths.repoRoot, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    invalidateContextStoreCache(filePath);
  };
  const usersDoc = () => { const parsed = readJson<{ users?: Record<string, Record<string, unknown>> }>("system/users.json", { users: {} }); return { users: parsed.users && typeof parsed.users === "object" ? parsed.users : {} }; };
  const resolveUserLookup = () => {
    const userId = asId(args.userId);
    const displayName = cleanText(args.displayName);
    const alias = cleanText(args.alias) || cleanText(args.query);
    const resolvedUserId = userId || resolveUserByAlias(config.paths.repoRoot, alias)?.[0] || resolveUserByDisplayName(config.paths.repoRoot, displayName)?.[0];
    return { userId, displayName, alias, resolvedUserId };
  };
  const scheduleEngine = new ScheduleEngine(config, new AiService(config));
  return { config, args, scheduleEngine, output, nowIso, readJson, writeJson, cleanText, asId, parseObjectArg, resolveUserLookup, usersDoc, logTextContent,
    logInfo: (message) => emitToolTerminalLine(config, "INFO", message), logWarn: (message) => emitToolTerminalLine(config, "WARN", message), logError: (message) => emitToolTerminalLine(config, "ERROR", message) };
}

export async function logToolInvocation(config: AppConfig, command: string, rawDomain: string, args: ToolArgs): Promise<void> {
  appendToolLogLine(config, "INFO", `tool operation invoke command=${command} raw=${rawDomain} args=${summarizeArgsForLog(args)}`);
}
