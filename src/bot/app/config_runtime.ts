import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { AppConfig } from "./types";
import { loadConfig } from "./config";
import { logger } from "./logger";

export const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "config.toml");
export type ConfigReloadResult = { warnings: string[]; reloadedKeys: string[]; restartRequiredKeys: string[] };

function changedKeys(before: AppConfig, after: AppConfig): string[] {
  const changed: string[] = [];
  if (before.feishu.appId !== after.feishu.appId) changed.push("feishu.app_id");
  if (before.feishu.appSecret !== after.feishu.appSecret) changed.push("feishu.app_secret");
  if (before.feishu.inputMergeWindowSeconds !== after.feishu.inputMergeWindowSeconds) changed.push("feishu.input_merge_window_seconds");
  if (before.feishu.menuPageSize !== after.feishu.menuPageSize) changed.push("feishu.menu_page_size");
  if (before.bot.personaStyle !== after.bot.personaStyle) changed.push("bot.persona_style");
  if (before.bot.language !== after.bot.language) changed.push("bot.language");
  if (before.bot.defaultTimezone !== after.bot.defaultTimezone) changed.push("bot.default_timezone");
  if (before.maintenance.enabled !== after.maintenance.enabled) changed.push("maintenance.enabled");
  if (before.maintenance.idleAfterMs !== after.maintenance.idleAfterMs) changed.push("maintenance.idle_after_minutes");
  return changed;
}

export function applyReloadedConfig(target: AppConfig, next: AppConfig): ConfigReloadResult {
  const requested = changedKeys(target, next);
  const restartRequiredKeys: string[] = requested.filter((key) => key === "feishu.app_id" || key === "feishu.app_secret");
  const warnings = restartRequiredKeys.length ? ["Feishu credentials changed and require a process restart; keeping current runtime credentials"] : [];
  if (restartRequiredKeys.length) next.feishu = { ...next.feishu, appId: target.feishu.appId, appSecret: target.feishu.appSecret };
  target.feishu = { ...next.feishu }; target.bot = { ...next.bot }; target.paths = { ...next.paths }; target.maintenance = { ...next.maintenance };
  return { warnings, reloadedKeys: requested.filter((key) => !restartRequiredKeys.includes(key)), restartRequiredKeys };
}

export function startConfigWatcher(configPath: string, config: AppConfig, onReload: (config: AppConfig, result: ConfigReloadResult) => Promise<void> | void): FSWatcher {
  let timer: NodeJS.Timeout | undefined;
  return watch(path.dirname(configPath), (_event, filename) => {
    if (filename && filename.toString() !== path.basename(configPath)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const result = applyReloadedConfig(config, loadConfig(configPath));
        await onReload(config, result);
        await logger.info(`reloaded config from ${configPath}`);
      } catch (error) { await logger.warn(`config reload failed: ${error instanceof Error ? error.message : String(error)}`); }
    }, 250);
  });
}
