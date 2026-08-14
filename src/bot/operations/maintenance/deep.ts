import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AiService } from "bot/ai";
import { ScheduleEngine } from "bot/operations/events";
import type { AppConfig } from "bot/app/types";
import { logger } from "bot/app/logger";
import { persistState, state } from "bot/app/state";
import { loadUsers } from "bot/operations/context/store";
import { diffSnapshots, memorySnapshot, recentlyChangedFiles } from "./snapshot";
import { appendMaintenanceLogSection } from "./log";

function maintenanceTrigger(force: boolean, idleMs: number, suffix: string): string {
  return `${force ? "forced" : `idle ${Math.round(idleMs / 1000)}s`} + ${suffix}`;
}

const MAINTENANCE_TICK_MS = 60 * 1000;

function buildMaintenanceRequest(lastMaintainedAt: string | null, changedFiles: string[]): string {
  return [
    "Load and follow the memory-maintenance skill.",
    lastMaintainedAt ? `Last maintainer pass: ${lastMaintainedAt}` : "Last maintainer pass: none",
    changedFiles.length > 0
      ? `Repository-root-relative files changed since then:\n${changedFiles.map((filePath) => `- ${filePath}`).join("\n")}`
      : "Files changed since then: none",
  ].join("\n\n");
}

async function notifyMaintenanceChanges(
  config: AppConfig,
  agentService: AiService,
  deps: MaintainerDeps,
  facts: string[],
): Promise<void> {
  if (!deps.onChange || facts.length === 0) return;

  const draft = facts.join("\n");
  try {
    const message = await agentService.composeMaintenanceReport(facts, { preferredLanguage: config.bot.language });
    await deps.onChange(message.trim() || draft);
  } catch {
    await deps.onChange(draft);
  }
}

async function refreshFeishuEntityRegistryLinks(config: AppConfig): Promise<{ userUpdates: number; chatUpdates: number }> {
  const users = loadUsers(config.paths.repoRoot);
  let userUpdates = 0;
  for (const [feishuUserId, user] of Object.entries(state.feishuUserCache)) {
    const canonical = users[feishuUserId];
    if (!canonical) continue;
    if (canonical.displayName && user.displayName !== canonical.displayName) {
      user.displayName = canonical.displayName;
      userUpdates += 1;
      continue;
    }
  }
  return { userUpdates, chatUpdates: 0 };
}

async function clearTmpContents(root: string, cutoffMs: number, dir = root): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".gitkeep") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removed.push(...await clearTmpContents(root, cutoffMs, fullPath));
      try {
        const remaining = (await readdir(fullPath)).filter((name) => name !== ".gitkeep");
        if (remaining.length === 0 && fullPath !== root) {
          await rm(fullPath, { recursive: true, force: true });
          removed.push(path.relative(root, fullPath));
        }
      } catch {
        // ignore concurrent or permission failures
      }
      continue;
    }
    try {
      const info = await stat(fullPath);
      if (info.mtimeMs >= cutoffMs) continue;
      await rm(fullPath, { force: true });
      removed.push(path.relative(root, fullPath));
    } catch {
      // ignore concurrent or permission failures
    }
  }

  return removed.sort((a, b) => a.localeCompare(b));
}

type MaintainerDeps = { isBusy: () => boolean; onChange?: (summary: string) => Promise<void> };

export type MaintainerRunner = {
  timer: NodeJS.Timeout | null;
  runNow: () => Promise<void>;
};

async function runMaintainerCycle(
  config: AppConfig,
  agentService: AiService,
  deps: MaintainerDeps,
  input: { force: boolean; runningRef: { value: boolean } },
): Promise<void> {
  const { force, runningRef } = input;
  if (runningRef.value) return;
  if (!force && deps.isBusy()) return;

  const lastActivityAt = state.lastActivityAt;
  const idleMs = lastActivityAt ? Date.now() - new Date(lastActivityAt).getTime() : Number.POSITIVE_INFINITY;
  if (!force && (!Number.isFinite(idleMs) || idleMs < config.maintenance.idleAfterMs)) return;

  const scheduleCleanup = await new ScheduleEngine(config, agentService).prune();
  if (scheduleCleanup.removed > 0) {
    await logger.info(`maintainer loop pruned ${scheduleCleanup.removed} inactive schedules`);
    await appendMaintenanceLogSection(config, new Date().toISOString(), maintenanceTrigger(force, idleMs, "schedule cleanup"), {
      summary: `pruned ${scheduleCleanup.removed} inactive schedules`,
      deleted: scheduleCleanup.removedSummaries.join(", "),
    });
  }

  const removedTmpEntries = await clearTmpContents(config.paths.tmpDir, Date.now() - config.maintenance.tmpRetentionDays * 24 * 60 * 60 * 1000);
  if (removedTmpEntries.length > 0) {
    const removedTmpPaths = removedTmpEntries.map((item) => path.join(path.relative(config.paths.repoRoot, config.paths.tmpDir), item));
    await logger.info(`maintainer loop cleared ${removedTmpEntries.length} tmp entries olderThanDays=${config.maintenance.tmpRetentionDays}`);
    await appendMaintenanceLogSection(config, new Date().toISOString(), maintenanceTrigger(force, idleMs, "tmp cleanup"), {
      summary: `cleared ${removedTmpEntries.length} tmp entries older than ${config.maintenance.tmpRetentionDays} day(s)`,
      deleted: removedTmpPaths.join(", "),
    });
  }

  const beforeSnapshot = await memorySnapshot(config.paths.repoRoot);
  const changedFiles = force ? [...beforeSnapshot.keys()].sort((a, b) => a.localeCompare(b)) : recentlyChangedFiles(beforeSnapshot, state.lastMaintainedAt);
  if (!force && changedFiles.length === 0) {
    return;
  }

  runningRef.value = true;
  const startedAt = new Date().toISOString();
  try {
    await logger.info(`maintainer loop starting${force ? " (forced)" : ""} after ${Number.isFinite(idleMs) ? `${idleMs}ms` : "unknown"} idle changedFiles=${changedFiles.length}`);
    const request = buildMaintenanceRequest(force ? null : state.lastMaintainedAt, changedFiles);
    const summary = await agentService.runMaintenancePass(request);
    const afterSnapshot = await memorySnapshot(config.paths.repoRoot);
    const changes = diffSnapshots(beforeSnapshot, afterSnapshot);
    let registryLinkRefresh = { userUpdates: 0, chatUpdates: 0 };
    try {
      registryLinkRefresh = await refreshFeishuEntityRegistryLinks(config);
    } catch (error) {
      await logger.warn(`maintainer loop registry link refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    state.lastMaintainedAt = new Date().toISOString();
    await persistState(config.paths.stateFile);
    await logger.info(`maintainer loop finished: ${summary || "(empty summary)"} userRegistryLinksUpdated=${registryLinkRefresh.userUpdates} chatRegistryLinksUpdated=${registryLinkRefresh.chatUpdates}`);
    await appendMaintenanceLogSection(config, startedAt, maintenanceTrigger(force, idleMs, "memory changed"), {
      summary: summary || "no summary",
      created: changes.created.length ? changes.created.join(", ") : "-",
      updated: changes.updated.length ? changes.updated.join(", ") : "-",
      deleted: changes.deleted.length ? changes.deleted.join(", ") : "-",
      userRegistryLinksUpdated: String(registryLinkRefresh.userUpdates),
      chatRegistryLinksUpdated: String(registryLinkRefresh.chatUpdates),
    });
    const memoryChanged = changes.created.length > 0 || changes.updated.length > 0 || changes.deleted.length > 0;
    const facts: string[] = [];
    if (summary) facts.push(`记忆整理摘要：${summary}`);
    if (changes.created.length > 0) facts.push(`新建文件：${changes.created.join(", ")}`);
    if (changes.updated.length > 0) facts.push(`更新文件：${changes.updated.join(", ")}`);
    if (changes.deleted.length > 0) facts.push(`删除文件：${changes.deleted.join(", ")}`);
    if (memoryChanged && facts.length > 0) {
      await notifyMaintenanceChanges(config, agentService, deps, facts);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logger.warn(`maintainer loop failed: ${message}`);
    await appendMaintenanceLogSection(config, startedAt, maintenanceTrigger(force, idleMs, "memory changed"), {
      failed: message,
    });
  } finally {
    runningRef.value = false;
  }
}

async function runMaintainerTick(
  config: AppConfig,
  agentService: AiService,
  deps: MaintainerDeps,
  runningRef: { value: boolean },
): Promise<void> {
  try {
    await runMaintainerCycle(config, agentService, deps, { force: false, runningRef });
  } catch (error) {
    await logger.warn(`maintainer loop tick failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createMaintainerRunner(
  config: AppConfig,
  agentService: AiService,
  deps: MaintainerDeps,
): MaintainerRunner {
  const runningRef = { value: false };
  const runNow = async (): Promise<void> => {
    await runMaintainerCycle(config, agentService, deps, { force: true, runningRef });
  };
  const timer = !config.maintenance.enabled ? null : setInterval(() => {
    void runMaintainerTick(config, agentService, deps, runningRef);
  }, MAINTENANCE_TICK_MS);

  if (timer) {
    void runMaintainerTick(config, agentService, deps, runningRef);
  }

  return { timer, runNow };
}

export function startMaintainerLoop(
  config: AppConfig,
  agentService: AiService,
  deps: MaintainerDeps,
): NodeJS.Timeout | null {
  return createMaintainerRunner(config, agentService, deps).timer;
}
