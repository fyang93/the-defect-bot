import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "@iarna/toml";
import type { AppConfig } from "./types";

type TomlRecord = Record<string, unknown>;

function asRecord(value: unknown): TomlRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as TomlRecord : {};
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function requiredString(value: unknown, fieldPath: string, configPath: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${fieldPath} in ${configPath}`);
  return value.trim();
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function asLanguage(value: unknown): "zh-CN" | "en" {
  return stringOr(value, "zh-CN").trim().toLowerCase() === "en" ? "en" : "zh-CN";
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function loadEnv(repoRoot: string): Record<string, string> {
  const values: Record<string, string> = {};
  const envPath = path.join(repoRoot, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      values[match[1]] = value;
    }
  }
  return { ...values, ...process.env } as Record<string, string>;
}

function resolveEnv(value: unknown, env: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveEnv(item, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as TomlRecord).map(([key, item]) => [key, resolveEnv(item, env)]));
  if (typeof value === "string") return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => env[key] ?? "");
  return value;
}

export function loadConfig(configPath = path.resolve(process.cwd(), "config.toml")): AppConfig {
  const resolvedPath = path.resolve(configPath);
  const repoRoot = path.dirname(resolvedPath);
  const parsed = asRecord(resolveEnv(parse(readFileSync(resolvedPath, "utf8")), loadEnv(repoRoot)));
  const feishu = asRecord(parsed.feishu);
  const bot = asRecord(parsed.bot);
  const maintenance = asRecord(parsed.maintenance);
  const defaultTimezone = requiredString(bot.default_timezone, "bot.default_timezone", resolvedPath);

  const config: AppConfig = {
    feishu: {
      appId: requiredString(feishu.app_id, "feishu.app_id", resolvedPath),
      appSecret: requiredString(feishu.app_secret, "feishu.app_secret", resolvedPath),
      inputMergeWindowSeconds: Math.max(0, numberOr(feishu.input_merge_window_seconds, 3)),
      menuPageSize: Math.max(1, numberOr(feishu.menu_page_size, 8)),
    },
    bot: {
      personaStyle: stringOr(bot.persona_style, ""),
      language: asLanguage(bot.language),
      defaultTimezone,
    },
    paths: {
      repoRoot,
      tmpDir: path.join(repoRoot, "tmp"),
      uploadSubdir: "feishu",
      logFile: path.join(repoRoot, "logs", "bot.log"),
      stateFile: path.join(repoRoot, "system", "state.json"),
    },
    maintenance: {
      enabled: booleanOr(maintenance.enabled, true),
      idleAfterMs: Math.max(0, numberOr(maintenance.idle_after_minutes, 15)) * 60 * 1000,
      tmpRetentionDays: Math.max(1, numberOr(maintenance.tmp_retention_days, 7)),
    },
  };

  if (!isValidTimezone(defaultTimezone)) throw new Error(`Invalid bot.default_timezone in ${resolvedPath}: ${defaultTimezone}`);
  return config;
}
