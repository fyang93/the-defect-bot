import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { state } from "../src/bot/app/state";
import type { AppConfig } from "../src/bot/app/types";
import { runToolCommand } from "../src/bot/operations/tools/execute";
import { rememberTelegramChat, rememberTelegramUser } from "../src/bot/telegram/registry";
import { resolveTelegramTargetUser } from "../src/bot/telegram/targets";

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
      personaStyle: "模仿杀戮尖塔里的故障机器人说话。",
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

async function createTempConfig(): Promise<{ config: AppConfig; repoRoot: string; originalCwd: string }> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-messages-test-"));
  await mkdir(path.join(repoRoot, "system"), { recursive: true });
  await writeFile(path.join(repoRoot, "system", "users.json"), '{"users":{}}\n', "utf8");
  await writeFile(path.join(repoRoot, "system", "chats.json"), '{"chats":{}}\n', "utf8");
  await writeFile(path.join(repoRoot, "system", "state.json"), '{}\n', "utf8");
  await writeFile(path.join(repoRoot, "config.toml"), [
    "[telegram]",
    'bot_token = "test"',
    "admin_user_id = 1",
    "",
    "[bot]",
    'language = "zh-CN"',
    'persona_style = ""',
    'default_timezone = "Asia/Tokyo"',
    "",
    "[maintenance]",
    "enabled = false",
    'idle_after_minutes = 15',
    "",
    "",
  ].join("\n"), "utf8");
  const originalCwd = process.cwd();
  process.chdir(repoRoot);
  return { config: createTestConfig(repoRoot), repoRoot, originalCwd };
}

async function runTool(command: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  return await runToolCommand(command, args) as Record<string, any>;
}

describe("message delivery flow", () => {
  test("telegram_send_message requires recipientId", async () => {
    const { repoRoot, originalCwd } = await createTempConfig();
    try {
      expect(await runTool("telegram_send_message", { content: "hi" })).toEqual({ ok: false, error: "missing-recipientId-for-message" });
    } finally {
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("telegram_send_message still requires outbound privilege for explicit recipientId", async () => {
    const { repoRoot, originalCwd } = await createTempConfig();
    try {
      expect(await runTool("telegram_send_message", { requesterUserId: 200, recipientId: 300, content: "hi" })).toEqual({ ok: false, error: "outbound-delivery-not-allowed" });
    } finally {
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("rememberTelegramUser refreshes stale displayName in users.json", async () => {
    const { repoRoot, originalCwd } = await createTempConfig();
    try {
      await writeFile(path.join(repoRoot, "system", "users.json"), JSON.stringify({ users: { "200": { username: "foo", displayName: "Old Name", accessLevel: "allowed" } } }, null, 2) + "\n", "utf8");
      state.telegramUserCache["200"] = { username: "foo", firstName: "New", lastName: "Name", displayName: "New Name", lastSeenAt: new Date().toISOString() };
      rememberTelegramUser({ id: 200, username: "foo", first_name: "New", last_name: "Name" });
      const users = JSON.parse(await readFile(path.join(repoRoot, "system", "users.json"), "utf8"));
      expect(users.users["200"].displayName).toBe("New Name");
    } finally {
      delete state.telegramUserCache["200"];
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("resolveTelegramTargetUser resolves remembered chat by display name", async () => {
    const { config, originalCwd, repoRoot } = await createTempConfig();
    try {
      rememberTelegramChat({ id: -1003674455331, type: "supergroup", title: "锅巴之家" }, [872940661]);
      const resolved = resolveTelegramTargetUser(
        config,
        { displayName: "锅巴之家" },
        { chat: { id: 872940661, type: "private" }, from: { id: 872940661 }, message: { message_id: 1, text: "发送一条测试消息到锅巴之家" } } as any,
        872940661,
      );
      expect(resolved.status).toBe("resolved");
      expect(resolved.targetKind).toBe("chat");
      expect(resolved.chatId).toBe(-1003674455331);
      expect(resolved.displayName).toBe("锅巴之家");
    } finally {
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("event_create accepts schedule passed as JSON string", async () => {
    const { repoRoot, originalCwd } = await createTempConfig();
    try {
      const parsed = await runTool("event_create", { requesterUserId: 1, title: "喝鸡汤", schedule: JSON.stringify({ kind: "once", scheduledAt: "2026-04-10T06:00:00.000Z" }) });
      expect(parsed.ok).toBe(true);
      expect(parsed.event.title).toBe("喝鸡汤");
    } finally {
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("auth_add_pending defaults expiresAt in code", async () => {
    const { repoRoot, originalCwd } = await createTempConfig();
    try {
      const startedAt = Date.now();
      const parsed = await runTool("auth_add_pending", { requesterUserId: 1, username: "foo", createdBy: 1 });
      expect(parsed.ok).toBe(true);
      expect(typeof parsed.expiresAt).toBe("string");
      const expiresAtMs = Date.parse(parsed.expiresAt);
      expect(Number.isFinite(expiresAtMs)).toBe(true);
      expect(expiresAtMs).toBeGreaterThan(startedAt + (23 * 60 * 60 * 1000));
    } finally {
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("auth_add_pending accepts durations longer than 24 hours", async () => {
    const { repoRoot, originalCwd } = await createTempConfig();
    try {
      const startedAt = Date.now();
      const parsed = await runTool("auth_add_pending", { requesterUserId: 1, username: "foo", createdBy: 1, durationMinutes: 7 * 24 * 60 });
      expect(parsed.ok).toBe(true);
      const expiresAtMs = Date.parse(parsed.expiresAt);
      expect(expiresAtMs).toBeGreaterThan(startedAt + (6 * 24 * 60 * 60 * 1000));
    } finally {
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("auth_add_pending rejects past or invalid expiresAt", async () => {
    const { repoRoot, originalCwd } = await createTempConfig();
    try {
      expect(await runTool("auth_add_pending", { requesterUserId: 1, username: "foo", createdBy: 1, expiresAt: "2000-01-01T00:00:00.000Z" })).toEqual({ ok: false, error: "invalid-expiresAt" });
    } finally {
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("user_update_rules adds and removes assistant rules deterministically", async () => {
    const { config, repoRoot, originalCwd } = await createTempConfig();

    try {
      await runTool("user_update_rules", {
        requesterUserId: 1,
        userId: 200,
        add: ["旧规则", "今后回答前先检查本地记忆"],
      });

      const parsed = await runTool("user_update_rules", {
        requesterUserId: 1,
        userId: 200,
        remove: ["旧规则"],
        add: ["遇到生日提醒先查记忆库"],
      });
      expect(parsed.ok).toBe(true);
      expect(parsed.user.rules).toEqual(["今后回答前先检查本地记忆", "遇到生日提醒先查记忆库"]);

      const users = JSON.parse(await readFile(path.join(repoRoot, "system", "users.json"), "utf8"));
      expect(users.users["200"].rules).toEqual(["今后回答前先检查本地记忆", "遇到生日提醒先查记忆库"]);
    } finally {
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
      void config;
    }
  });

  test("user_set_person_path updates a narrow field deterministically", async () => {
    const { repoRoot, originalCwd } = await createTempConfig();
    try {
      await mkdir(path.join(repoRoot, "memory", "people"), { recursive: true });
      await mkdir(path.join(repoRoot, "memory", "people", "yang-fan"), { recursive: true });
      await writeFile(path.join(repoRoot, "memory", "people", "yang-fan", "README.md"), "# 羊帆\n", "utf8");

      const parsed = await runTool("user_set_person_path", { requesterUserId: 1, userId: 200, personPath: "memory/people/yang-fan/README.md" });
      expect(parsed.ok).toBe(true);
      expect(parsed.user.personPath).toBe("memory/people/yang-fan/README.md");

      const users = JSON.parse(await readFile(path.join(repoRoot, "system", "users.json"), "utf8"));
      expect(users.users["200"].personPath).toBe("memory/people/yang-fan/README.md");
    } finally {
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("user_record_person creates memory and links personPath", async () => {
    const { repoRoot, originalCwd } = await createTempConfig();
    try {
      const parsed = await runTool("user_record_person", {
        requesterUserId: 1,
        userId: 200,
        name: "李博",
        aliases: ["李博闻"],
        facts: ["上海交大博士"],
      });
      expect(parsed.ok).toBe(true);
      expect(parsed.user.personPath).toBe("memory/people/user-200/README.md");
      const note = await readFile(path.join(repoRoot, "memory", "people", "user-200", "README.md"), "utf8");
      expect(note).toContain("# 李博");
      expect(note).toContain("- 上海交大博士");
      const users = JSON.parse(await readFile(path.join(repoRoot, "system", "users.json"), "utf8"));
      expect(users.users["200"].personPath).toBe("memory/people/user-200/README.md");
      expect(users.users["200"].aliases).toEqual(["李博闻", "李博"]);
    } finally {
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("user_set_timezone updates a narrow field deterministically", async () => {
    const { repoRoot, originalCwd } = await createTempConfig();
    try {
      const tz = await runTool("user_set_timezone", { requesterUserId: 1, userId: 200, timezone: "Asia/Tokyo" });
      expect(tz.ok).toBe(true);
      expect(tz.user.timezone).toBe("Asia/Tokyo");

      const users = JSON.parse(await readFile(path.join(repoRoot, "system", "users.json"), "utf8"));
      expect(users.users["200"].timezone).toBe("Asia/Tokyo");
      expect(users.users["200"].memoryPath).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("user:list and user:get return ok true on success", async () => {
    const { repoRoot, originalCwd } = await createTempConfig();
    try {
      const usersPath = path.join(repoRoot, "system", "users.json");
      const users = JSON.parse(await readFile(usersPath, "utf8"));
      users.users["1"] = { displayName: "Admin Test" };
      await writeFile(usersPath, JSON.stringify(users, null, 2) + "\n", "utf8");

      const listed = await runTool("user:list", { requesterUserId: 1 });
      expect(listed.ok).toBe(true);
      expect(typeof listed.users).toBe("object");
      expect(listed.users["1"].timezone).toBe("Asia/Tokyo");

      const got = await runTool("user:get", { requesterUserId: 1, userId: 1 });
      expect(got.ok).toBe(true);
      expect(got.userId).toBe(1);
      expect(got.user.timezone).toBe("Asia/Tokyo");
    } finally {
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
