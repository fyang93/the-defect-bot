import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/bot/app/types";
import { buildEventRecord, createEventRecord, readEventRecords } from "../src/bot/operations/events/store";
import { runEventTask, type TaskRecord } from "../src/bot/operations/events/task-actions";
import { rememberTelegramUser } from "../src/bot/telegram/registry";
import { resolveUser } from "../src/bot/operations/context/store";
import { clearStoredUserAccessLevel, clearStoredUserAccessLevels, setStoredUserAccessLevel, setStoredUserAccessLevels } from "../src/bot/operations/access/roles";
import { loadPersistentState, state } from "../src/bot/app/state";

const tempDirs: string[] = [];
const originalCwd = process.cwd();
const hostRepoRoot = process.cwd();
const REGRESSION_TEST_TIMEOUT_MS = 30_000;

function createTestConfig(repoRoot: string): AppConfig {
  return {
    telegram: {
      botToken: "test",
      adminUserId: 1,
      waitingMessage: "",
      inputMergeWindowSeconds: 3,
      menuPageSize: 10,
    },
    bot: {
      personaStyle: "",
      language: "zh-CN",
      defaultTimezone: "Asia/Tokyo",
    },
    paths: {
      repoRoot,
      tmpDir: path.join(repoRoot, "tmp"),
      uploadSubdir: "uploads",
      logFile: path.join(repoRoot, "logs", "bot.log"),
      stateFile: path.join(repoRoot, "system", "state.json"),
    },
    maintenance: {
      enabled: false,
      idleAfterMs: 0,
      tmpRetentionDays: 1,
    },
  };
}

async function createTempConfig(): Promise<AppConfig> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-nl-test-"));
  tempDirs.push(repoRoot);
  await mkdir(path.join(repoRoot, "system"), { recursive: true });
  await mkdir(path.join(repoRoot, "logs", "test-runs"), { recursive: true });
  await mkdir(path.join(hostRepoRoot, "logs", "test-runs"), { recursive: true });
  await mkdir(path.join(repoRoot, "memory", "people"), { recursive: true });
  await writeFile(path.join(repoRoot, "system", "users.json"), '{"users":{}}\n', "utf8");
  await writeFile(path.join(repoRoot, "system", "chats.json"), '{"chats":{}}\n', "utf8");
  await writeFile(path.join(repoRoot, "system", "state.json"), '{}\n', "utf8");
  const config = createTestConfig(repoRoot);
  process.chdir(repoRoot);
  await loadPersistentState(config.paths.stateFile);
  return config;
}

async function appendScenarioLog(config: AppConfig, entry: Record<string, unknown>): Promise<void> {
  const filePath = path.join(hostRepoRoot, "logs", "test-runs", "nl-regression.log");
  await appendFile(filePath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, "utf8");
}

async function runLoggedScenario<T>(config: AppConfig, input: string, category: string, run: () => Promise<T>): Promise<T> {
  await appendScenarioLog(config, { category, input, state: "start" });
  try {
    const result = await run();
    await appendScenarioLog(config, { category, input, state: "pass", result });
    return result;
  } catch (error) {
    await appendScenarioLog(config, {
      category,
      input,
      state: "fail",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function makeScheduleTask(operation: "update" | "delete", payload: Record<string, unknown>, requesterUserId = 1): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: `tsk_${operation}_test`,
    state: "queued",
    domain: "events",
    operation,
    payload,
    source: { requesterUserId },
    createdAt: now,
    updatedAt: now,
  };
}

async function readUsersDocument(repoRoot: string): Promise<Record<string, Record<string, unknown>>> {
  const filePath = path.join(repoRoot, "system", "users.json");
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as { users?: Record<string, unknown> };
  return Object.fromEntries(
    Object.entries(parsed.users && typeof parsed.users === "object" ? parsed.users : {})
      .map(([key, value]) => [key, value && typeof value === "object" ? value as Record<string, unknown> : {}]),
  );
}

async function removeUserRecord(repoRoot: string, userId: number): Promise<boolean> {
  const filePath = path.join(repoRoot, "system", "users.json");
  const users = await readUsersDocument(repoRoot);
  const key = String(userId);
  if (!users[key]) return false;
  delete users[key];
  await writeFile(filePath, `${JSON.stringify({ users }, null, 2)}\n`, "utf8");
  delete state.telegramUserCache[key];
  return true;
}

afterEach(async () => {
  process.chdir(originalCwd);
  state.telegramUserCache = {};
  state.telegramChatCache = {};
  state.userTimezoneCache = {};
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("自然语言回归测试", () => {
  test("提醒的增删查改", { timeout: REGRESSION_TEST_TIMEOUT_MS }, async () => {
    const config = await createTempConfig();

    await runLoggedScenario(config, "添加提醒：4月7日下午3点组会提醒", "schedules.direct-create", async () => {
      const event = buildEventRecord(config, {
        title: "组会提醒",
          timeSemantics: "absolute",
        timezone: "Asia/Tokyo",
        schedule: { kind: "once", scheduledAt: "2026-04-07T06:00:00.000Z" },
        reminders: [{ id: "n1", offsetMinutes: -1440, enabled: true }],
        targets: [{ targetKind: "user", targetId: 872940661 }],
      }, "Asia/Tokyo");
      await createEventRecord(event, config);
      return { eventId: event.id };
    });

    const created = await runLoggedScenario(config, "现在有哪些提醒", "schedules.read", async () => {
      const events = await readEventRecords(config);
      return events.filter((item) => item.status === "active").map((item) => ({ title: item.title, scheduledAt: item.schedule.kind === "once" ? item.schedule.scheduledAt : item.schedule.kind }));
    });
    expect(created.some((item) => item.title === "组会提醒")).toBe(true);

    const updateResult = await runLoggedScenario(config, "把 4/7 的组会提醒改成 4/7 16:00", "schedules.update", async () => runEventTask(config, makeScheduleTask("update", {
      match: { title: "组会提醒", scheduledDate: "2026-04-07" },
      changes: { schedule: { kind: "once", scheduledAt: "2026-04-07T07:00:00.000Z" } },
    })));
    expect(updateResult.changed).toBe(true);

    const updated = await readEventRecords(config);
    expect(updated.find((item) => item.title === "组会提醒")?.schedule.kind).toBe("once");
    expect((updated.find((item) => item.title === "组会提醒")?.schedule as { kind: "once"; scheduledAt: string } | undefined)?.scheduledAt).toBe("2026-04-07T07:00:00.000Z");

    const deleteResult = await runLoggedScenario(config, "删除 4/7 那个提醒", "schedules.delete", async () => runEventTask(config, makeScheduleTask("delete", {
      match: { title: "组会提醒", scheduledDate: "2026-04-07" },
    })));
    expect(deleteResult.changed).toBe(true);
    expect((await readEventRecords(config)).find((item) => item.title === "组会提醒")?.status).toBe("deleted");
  });

  test("个人信息的增删查改", { timeout: REGRESSION_TEST_TIMEOUT_MS }, async () => {
    const config = await createTempConfig();

    await runLoggedScenario(config, "记住 test_rain 是测试雨", "people.create", async () => {
      rememberTelegramUser({ id: 8631425224, username: "test_rain", first_name: "测试", last_name: "雨" });
      return resolveUser(config.paths.repoRoot, 8631425224);
    });
    expect(resolveUser(config.paths.repoRoot, 8631425224)?.username).toBe("test_rain");

    await runLoggedScenario(config, "把 test_rain 的显示名改成 测试小雨", "people.update", async () => {
      rememberTelegramUser({ id: 8631425224, username: "test_rain", first_name: "测试", last_name: "小雨" });
      return resolveUser(config.paths.repoRoot, 8631425224);
    });
    expect(resolveUser(config.paths.repoRoot, 8631425224)?.displayName).toContain("测试");

    const readResult = await runLoggedScenario(config, "查看 test_rain 的个人信息", "people.read", async () => resolveUser(config.paths.repoRoot, 8631425224));
    expect(readResult?.username).toBe("test_rain");

    const removed = await runLoggedScenario(config, "删除 test_rain 的个人信息", "people.delete", async () => removeUserRecord(config.paths.repoRoot, 8631425224));
    expect(removed).toBe(true);
    expect((await readUsersDocument(config.paths.repoRoot))["8631425224"]).toBeUndefined();
  });

  test("用户访问级别的设置", { timeout: REGRESSION_TEST_TIMEOUT_MS }, async () => {
    const config = await createTempConfig();
    rememberTelegramUser({ id: 8631425224, username: "test_rain", first_name: "测试", last_name: "雨" });

    const granted = await runLoggedScenario(config, "管理员把 test_rain 设为 trusted", "access.set-access-level", async () => setStoredUserAccessLevel(config, 8631425224, "trusted", { username: "test_rain" }));
    expect(granted).toBe(true);
    expect((await readUsersDocument(config.paths.repoRoot))["8631425224"]?.accessLevel).toBe("trusted");

    const revoked = await runLoggedScenario(config, "管理员取消 test_rain 的 trusted 权限", "access.clear-access-level", async () => clearStoredUserAccessLevel(config, 8631425224, { username: "test_rain" }));
    expect(revoked).toBe(true);
    expect((await readUsersDocument(config.paths.repoRoot))["8631425224"]?.accessLevel).toBeUndefined();
  });

  test("批量设置用户访问级别", { timeout: REGRESSION_TEST_TIMEOUT_MS }, async () => {
    const config = await createTempConfig();
    rememberTelegramUser({ id: 8631425224, username: "test_rain", first_name: "测试", last_name: "雨" });
    rememberTelegramUser({ id: 5754713371, username: "test_star", first_name: "测试", last_name: "星" });

    const batchGranted = await runLoggedScenario(config, "管理员把 test_rain 和 test_star 批量设为 trusted", "access.set-access-level-batch", async () => setStoredUserAccessLevels(config, [
      { userId: 8631425224, accessLevel: "trusted", patch: { username: "test_rain" } },
      { userId: 5754713371, accessLevel: "trusted", patch: { username: "test_star" } },
    ]));
    expect(batchGranted.changedUserIds).toEqual([8631425224, 5754713371]);
    const usersAfterGrant = await readUsersDocument(config.paths.repoRoot);
    expect(usersAfterGrant["8631425224"]?.accessLevel).toBe("trusted");
    expect(usersAfterGrant["5754713371"]?.accessLevel).toBe("trusted");

    const batchCleared = await runLoggedScenario(config, "管理员批量取消 test_rain 和 test_star 的 trusted 权限", "access.clear-access-level-batch", async () => clearStoredUserAccessLevels(config, [
      { userId: 8631425224, patch: { username: "test_rain" } },
      { userId: 5754713371, patch: { username: "test_star" } },
    ]));
    expect(batchCleared.changedUserIds).toEqual([8631425224, 5754713371]);
    const usersAfterClear = await readUsersDocument(config.paths.repoRoot);
    expect(usersAfterClear["8631425224"]?.accessLevel).toBeUndefined();
    expect(usersAfterClear["5754713371"]?.accessLevel).toBeUndefined();
  });

});
