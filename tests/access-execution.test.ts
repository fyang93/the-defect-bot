import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/bot/app/types";
import { executeAssistantActions } from "../src/bot/runtime/assistant-actions";
import { tForUser, userLocale } from "../src/bot/app/i18n";
import { rememberTelegramUser } from "../src/bot/telegram/registry";
import { ensureAdminUserAccessLevel, setStoredUserAccessLevel } from "../src/bot/operations/access/roles";

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

async function createTempConfig(): Promise<{ config: AppConfig; repoRoot: string; originalCwd: string }> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-access-exec-"));
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

describe("access execution", () => {
  test("admin access level is derived from config and synced into users.json", async () => {
    const { config, repoRoot, originalCwd } = await createTempConfig();
    try {
      const changed = await ensureAdminUserAccessLevel(config);
      expect(changed).toBe(true);
      const usersDoc = JSON.parse(await readFile(path.join(repoRoot, "system", "users.json"), "utf8")) as { users?: Record<string, Record<string, unknown>> };
      expect(usersDoc.users?.["1"]?.accessLevel).toBe("admin");
      expect(usersDoc.users?.["1"]?.timezone).toBe("Asia/Tokyo");
    } finally {
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("executeAssistantActions keeps assistant inputs text-first instead of forcing raw attachments into the model call", async () => {
    const { config, repoRoot, originalCwd } = await createTempConfig();
    try {
      let captured: Record<string, unknown> | null = null;

      await executeAssistantActions({
        config,
        agentService: {
          runAssistantTurn: async (input: any) => {
            captured = input;
            return {
              message: "看到了文件。",
              answerMode: "direct",
              usedNativeExecution: false,
              completedActions: [],
            };
          },
        } as any,
        ctx: { chat: { id: 1, type: "private" }, message: { message_id: 1, text: "你怎么看" } } as any,
        requesterUserId: 1,
        canDeliverOutbound: true,
        accessRole: "admin",
        userRequestText: "你怎么看\n\nSaved files:\n- tmp/example.jpg (image/jpeg, 1 KB)",
        isTaskCurrent: () => true,
      });

      expect(captured?.uploadedFiles).toEqual([]);
      expect(captured?.attachments).toEqual([]);
      expect(String(captured?.userRequestText || "")).toContain("Saved files:");
      expect(String(captured?.userRequestText || "")).toContain("tmp/example.jpg");
    } finally {
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("access.set-access-level is applied immediately without queueing a task", async () => {
    const { config, repoRoot, originalCwd } = await createTempConfig();
    try {
      rememberTelegramUser({ id: 8631425224, username: "test_rain", first_name: "测试", last_name: "雨" });

      await executeAssistantActions({
        config,
        agentService: {
          runAssistantTurn: async () => {
            await setStoredUserAccessLevel(config, 8631425224, "trusted", { username: "test_rain" });
            return {
              message: "好的，已把 test_rain 设为 trusted。",
              answerMode: "needs-execution",
              usedNativeExecution: true,
              completedActions: ["users:set-access"],
            };
          },
        } as any,
        ctx: { chat: { id: 1, type: "private" }, message: { message_id: 1, text: "把 test_rain 设为 trusted" } } as any,
        requesterUserId: 1,
        canDeliverOutbound: true,
        accessRole: "admin",
        userRequestText: "把 test_rain 设为 trusted",
        isTaskCurrent: () => true,
      });

      const usersDoc = JSON.parse(await readFile(path.join(repoRoot, "system", "users.json"), "utf8")) as { users?: Record<string, Record<string, unknown>> };
      expect(usersDoc.users?.["8631425224"]?.accessLevel).toBe("trusted");
      expect(usersDoc.users?.["8631425224"]?.timezone).toBe("Asia/Tokyo");

      await expect(readFile(path.join(repoRoot, "system", "tasks.json"), "utf8")).rejects.toThrow();
    } finally {
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("rememberTelegramUser writes default timezone and language code when recording a new user", async () => {
    const { config, repoRoot, originalCwd } = await createTempConfig();
    try {
      rememberTelegramUser({ id: 9182637451, username: "test_rain_new", first_name: "测试", last_name: "雨", language_code: "en-US" });
      const usersDoc = JSON.parse(await readFile(path.join(repoRoot, "system", "users.json"), "utf8")) as { users?: Record<string, Record<string, unknown>> };
      expect(usersDoc.users?.["9182637451"]?.username).toBe("test_rain_new");
      expect(usersDoc.users?.["9182637451"]?.timezone).toBe("Asia/Tokyo");
      expect(usersDoc.users?.["9182637451"]?.languageCode).toBe("en-US");
      expect(userLocale(config, 9182637451)).toBe("en");
      expect(tForUser(config, 9182637451, "command_help")).toBe("Get help");
    } finally {
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("Chinese Telegram UI language maps to zh-CN fixed UI text", async () => {
    const { config, repoRoot, originalCwd } = await createTempConfig();
    try {
      rememberTelegramUser({ id: 7, username: "zh_user", first_name: "中", last_name: "文", language_code: "zh-Hans" });
      expect(userLocale(config, 7)).toBe("zh-CN");
      expect(tForUser(config, 7, "command_help")).toBe("查看帮助");
    } finally {
      process.chdir(originalCwd);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
