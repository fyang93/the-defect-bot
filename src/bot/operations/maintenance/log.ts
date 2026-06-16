import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "bot/app/types";

export async function appendMaintenanceLog(config: AppConfig, entry: string): Promise<void> {
  const logPath = path.join(config.paths.repoRoot, "logs", "maintenance.log");
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, entry, "utf8");
}

export async function appendMaintenanceLogSection(
  config: AppConfig,
  startedAt: string,
  trigger: string,
  fields: Record<string, string>,
): Promise<void> {
  await appendMaintenanceLog(config, [
    `## ${startedAt}`,
    `trigger: ${trigger}`,
    ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`),
    "",
  ].join("\n"));
}
