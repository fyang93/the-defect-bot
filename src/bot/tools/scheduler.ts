import { mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AppConfig } from "bot/app/types";

function bunCommand(): string {
  return basename(process.execPath).includes("bun") ? process.execPath : "bun";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}


function atTimeSpec(sendAt: string): string {
  const date = new Date(sendAt);
  const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}${hh}${mi}.${ss}`;
}

function writeScheduledScript(config: AppConfig, command: string, args: Record<string, unknown>): string {
  const dir = path.join(config.paths.tmpDir, "scheduled-tools");
  mkdirSync(dir, { recursive: true });
  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const scriptPath = path.join(dir, `${id}.sh`);
  const toolArgs = JSON.stringify(args);
  const content = [
    "#!/bin/sh",
    "set -eu",
    `cd ${shellQuote(config.paths.repoRoot)}`,
    `exec ${shellQuote(bunCommand())} src/bot/tools/run-scheduled.ts ${shellQuote(command)} ${shellQuote(toolArgs)}`,
  ].join("\n") + "\n";
  writeFileSync(scriptPath, content, { encoding: "utf8", mode: 0o700 });
  return scriptPath;
}

function tryAtScheduler(config: AppConfig, command: string, args: Record<string, unknown>, sendAt: string): { ok: true; scheduler: "at"; handle: string } | null {
  const scriptPath = writeScheduledScript(config, command, args);
  const result = spawnSync("at", ["-t", atTimeSpec(sendAt)], {
    input: `/bin/sh ${shellQuote(scriptPath)}\n`,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const handle = output.match(/job\s+([0-9]+)/i)?.[1] || scriptPath;
  return { ok: true, scheduler: "at", handle };
}

export function scheduleRepoToolCommand(config: AppConfig, command: string, args: Record<string, unknown>, sendAt: string): { ok: true; scheduler: "at"; handle: string } | { ok: false; error: string } {
  const parsed = Date.parse(sendAt);
  if (!Number.isFinite(parsed) || parsed <= Date.now()) {
    return { ok: false, error: "invalid-sendAt" };
  }
  return tryAtScheduler(config, command, args, sendAt)
    || { ok: false, error: "at-unavailable" };
}
