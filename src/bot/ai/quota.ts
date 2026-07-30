import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type QuotaMode = "used" | "left";

type QuotaWindow = { label: string; usedPercent: number };
type CodexWindow = { limit_window_seconds?: number; used_percent?: number };
type CodexRateLimit = { primary_window?: CodexWindow; secondary_window?: CodexWindow };

let apiCache: { at: number; agentDir: string; windows: QuotaWindow[] } | undefined;

export function formatQuotaWindows(windows: readonly QuotaWindow[], mode: QuotaMode): string {
  const seen = new Set<string>();
  return windows.flatMap((window) => {
    const normalized = window.label.toLowerCase();
    const label = /\b5h\b/.test(normalized) ? "5h" : /\bweek\b/.test(normalized) ? "week" : "";
    if (!label || seen.has(label)) return [];
    seen.add(label);
    const percentage = Math.round(mode === "left" ? 100 - window.usedPercent : window.usedPercent);
    return [`${label} ${percentage}% ${mode}`];
  }).join(" / ");
}

function readJson(filePath: string): Record<string, unknown> | undefined {
  try {
    return existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function codexCredentials(agentDir: string): { accessToken?: string; accountId?: string } {
  const envAccessToken = process.env.OPENAI_CODEX_OAUTH_TOKEN || process.env.OPENAI_CODEX_ACCESS_TOKEN || process.env.CODEX_OAUTH_TOKEN || process.env.CODEX_ACCESS_TOKEN;
  if (envAccessToken) return { accessToken: envAccessToken, accountId: process.env.OPENAI_CODEX_ACCOUNT_ID || process.env.CHATGPT_ACCOUNT_ID };

  for (const authPath of [path.join(agentDir, "auth.json"), path.join(process.env.HOME || "", ".pi", "agent", "auth.json")]) {
    const auth = readJson(authPath);
    const codex = auth?.["openai-codex"] as { access?: unknown; accountId?: unknown } | undefined;
    if (typeof codex?.access === "string") return { accessToken: codex.access, accountId: typeof codex.accountId === "string" ? codex.accountId : undefined };
  }

  const legacy = readJson(path.join(process.env.CODEX_HOME || path.join(process.env.HOME || "", ".codex"), "auth.json"));
  if (typeof legacy?.OPENAI_API_KEY === "string") return { accessToken: legacy.OPENAI_API_KEY };
  const tokens = legacy?.tokens as { access_token?: unknown; account_id?: unknown } | undefined;
  return typeof tokens?.access_token === "string"
    ? { accessToken: tokens.access_token, accountId: typeof tokens.account_id === "string" ? tokens.account_id : undefined }
    : {};
}

function labelFor(seconds: unknown, fallback: number): string {
  const hours = Math.round((typeof seconds === "number" && seconds > 0 ? seconds : fallback) / 3600);
  if (hours >= 144) return "week";
  if (hours >= 24) return "day";
  return `${hours}h`;
}

function addCodexWindows(output: QuotaWindow[], rateLimit: CodexRateLimit | undefined): void {
  const primary = rateLimit?.primary_window;
  const secondary = rateLimit?.secondary_window;
  if (typeof primary?.used_percent === "number") output.push({ label: labelFor(primary.limit_window_seconds, 18_000), usedPercent: primary.used_percent });
  if (typeof secondary?.used_percent === "number") output.push({ label: labelFor(secondary.limit_window_seconds, 604_800), usedPercent: secondary.used_percent });
}

export async function quotaText(agentDir: string, mode: QuotaMode = "left"): Promise<string> {
  if (apiCache && apiCache.agentDir === agentDir && Date.now() - apiCache.at < 60_000) return formatQuotaWindows(apiCache.windows, mode);
  const { accessToken, accountId } = codexCredentials(agentDir);
  if (!accessToken) return "";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers, signal: controller.signal });
    if (!response.ok) return "";
    const data = await response.json() as { rate_limit?: CodexRateLimit; additional_rate_limits?: Array<{ rate_limit?: CodexRateLimit }> };
    const windows: QuotaWindow[] = [];
    addCodexWindows(windows, data.rate_limit);
    for (const extra of data.additional_rate_limits || []) addCodexWindows(windows, extra.rate_limit);
    apiCache = { at: Date.now(), agentDir, windows };
    return formatQuotaWindows(windows, mode);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}
