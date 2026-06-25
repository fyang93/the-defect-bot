import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/bot/app/types";
import { buildAssistantContextBlock } from "../src/bot/operations/context/assistant";
import { clearRecentClarification, state, rememberRecentClarification } from "../src/bot/app/state";

const tempDirs: string[] = [];

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
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-assistant-context-"));
  tempDirs.push(repoRoot);
  await mkdir(path.join(repoRoot, "system"), { recursive: true });
  await writeFile(path.join(repoRoot, "system", "users.json"), '{"users":{"1":{"displayName":"Admin Test","timezone":"Asia/Tokyo","personPath":"memory/people/admin-test/README.md","rules":["今后添加某人的生日提醒时，先查记忆库再创建"]}}}\n', "utf8");
  await writeFile(path.join(repoRoot, "system", "chats.json"), '{"chats":{"1":{"type":"private","title":"Admin Chat"}}}\n', "utf8");
  return createTestConfig(repoRoot);
}

afterEach(async () => {
  clearRecentClarification();
  state.telegramUserCache = {};
  state.telegramChatCache = {};
  state.userTimezoneCache = {};
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("assistant clarification context", () => {
  test("recent clarification is injected into assistant context for the next private-scope turn", async () => {
    const config = await createTempConfig();
    rememberRecentClarification("user:1", "下午提醒我review论文", "好的，下午几点提醒你呢？");

    const context = await buildAssistantContextBlock(config, {
      requesterUserId: 1,
      chatId: 1,
      messageTime: "2026-04-05T16:51:25.000Z",
    });

    expect(context).toContain('"recentClarification"');
    expect(context).toContain("下午提醒我review论文");
    expect(context).toContain("下午几点提醒你呢");
    expect(context).toContain('"turnTime"');
    expect(context).toContain('"rules"');
    expect(context).toContain('今后添加某人的生日提醒时，先查记忆库再创建');
    expect(context).toContain('Requester person path: memory/people/admin-test/README.md');
    expect(context).toContain('"localDateTime": "2026-04-06 01:51:25"');
    expect(context).not.toContain('"messageTimeUtc"');
  });

  test("clearing recent clarification removes it from assistant context", async () => {
    const config = await createTempConfig();
    rememberRecentClarification("user:1", "下午提醒我review论文", "好的，下午几点提醒你呢？");
    clearRecentClarification("user:1");

    const context = await buildAssistantContextBlock(config, {
      requesterUserId: 1,
      chatId: 1,
      messageTime: "2026-04-05T16:51:25.000Z",
    });

    expect(context).toContain('"recentClarification": null');
    expect(context).toContain('"turnTime"');
    expect(context).toContain('Requester person path: memory/people/admin-test/README.md');
  });

  test("missing user timezone falls back to bot.defaultTimezone in injected context", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-assistant-context-missing-tz-"));
    tempDirs.push(repoRoot);
    await mkdir(path.join(repoRoot, "system"), { recursive: true });
    await writeFile(path.join(repoRoot, "system", "users.json"), '{"users":{"1":{"displayName":"Admin Test","personPath":"memory/people/admin-test/README.md"}}}\n', "utf8");
    await writeFile(path.join(repoRoot, "system", "chats.json"), '{"chats":{"1":{"type":"private","title":"Admin Chat"}}}\n', "utf8");
    const config = createTestConfig(repoRoot);

    const context = await buildAssistantContextBlock(config, {
      requesterUserId: 1,
      chatId: 1,
      messageTime: "2026-04-05T16:51:25.000Z",
    });

    expect(context).toContain('"timezone": "Asia/Tokyo"');
    expect(context).toContain('"localDateTime": "2026-04-06 01:51:25"');
  });
});
