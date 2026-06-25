import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { AppConfig } from "./types";
import { loadConfig } from "./config";
import { logger } from "./logger";

export const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "config.toml");

export type ConfigReloadResult = {
  warnings: string[];
  reloadedKeys: string[];
  restartRequiredKeys: string[];
};

function diffConfigKeys(before: AppConfig, after: AppConfig): string[] {
  const changed: string[] = [];
  if (before.telegram.botToken !== after.telegram.botToken) changed.push("telegram.bot_token");
  if (before.telegram.adminUserId !== after.telegram.adminUserId) changed.push("telegram.admin_user_id");
  if (before.telegram.waitingMessage !== after.telegram.waitingMessage) changed.push("telegram.waiting_message");
  if (before.telegram.menuPageSize !== after.telegram.menuPageSize) changed.push("telegram.menu_page_size");
  if (before.bot.personaStyle !== after.bot.personaStyle) changed.push("bot.persona_style");
  if (before.bot.language !== after.bot.language) changed.push("bot.language");
  if (before.bot.defaultTimezone !== after.bot.defaultTimezone) changed.push("bot.default_timezone");
  if (before.maintenance.enabled !== after.maintenance.enabled) changed.push("maintenance.enabled");
  if (before.maintenance.idleAfterMs !== after.maintenance.idleAfterMs) changed.push("maintenance.idle_after_minutes");
  return changed;
}

export function applyReloadedConfig(target: AppConfig, next: AppConfig): ConfigReloadResult {
  const warnings: string[] = [];
  const requestedChanges = diffConfigKeys(target, next);
  const restartRequiredKeys: string[] = [];

  if (target.telegram.botToken !== next.telegram.botToken) {
    warnings.push("telegram.bot_token changed but requires process restart; keeping the current runtime token");
    restartRequiredKeys.push("telegram.bot_token");
    next.telegram.botToken = target.telegram.botToken;
  }
  target.telegram = { ...next.telegram };
  target.bot = { ...next.bot };
  target.paths = { ...next.paths };
  target.maintenance = { ...next.maintenance };

  const reloadedKeys = requestedChanges.filter((key) => !restartRequiredKeys.includes(key));
  return { warnings, reloadedKeys, restartRequiredKeys };
}

export function startConfigWatcher(
  configPath: string,
  config: AppConfig,
  onReload: (config: AppConfig, result: ConfigReloadResult) => Promise<void> | void,
): FSWatcher {
  const dir = path.dirname(configPath);
  const basename = path.basename(configPath);
  let timer: NodeJS.Timeout | null = null;
  let reloading = false;

  const scheduleReload = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (reloading) return;
      reloading = true;
      try {
        const next = loadConfig(configPath);
        const result = applyReloadedConfig(config, next);
        await logger.info(`reloaded config from ${configPath}`);
        for (const warning of result.warnings) {
          await logger.warn(`config reload warning: ${warning}`);
        }
        await onReload(config, result);
      } catch (error) {
        await logger.warn(`config reload failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        reloading = false;
      }
    }, 250);
  };

  return watch(dir, (_eventType, filename) => {
    if (!filename) {
      scheduleReload();
      return;
    }
    if (filename.toString() === basename) {
      scheduleReload();
    }
  });
}
