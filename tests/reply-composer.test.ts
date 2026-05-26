import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { ReplyComposer } from "../src/bot/ai/reply-composer";
import type { AppConfig } from "../src/bot/app/types";

function createTestConfig(): AppConfig {
  const repoRoot = path.join(os.tmpdir(), "defect-bot-reply-composer-test");
  return {
    telegram: {
      botToken: "test",
      adminUserId: 1,
      waitingMessage: "",
      inputMergeWindowSeconds: 3,
      menuPageSize: 10,
    },
    bot: {
      personaStyle: "冷静、简洁、稳定",
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

describe("reply composer sanitization", () => {
  test("generateReminderText requests persona-aware reminder wording with explicit local time", async () => {
    let captured = "";
    const composer = new ReplyComposer(createTestConfig(), async (prompt) => {
      captured = prompt;
      return "18:00，记得 review 论文。";
    });
    await composer.generateReminderText("review论文", "2026-04-05T18:00:00.000Z", "一次性提醒", "Asia/Tokyo", {
      eventScheduledAt: "2026-04-06T18:00:00.000Z",
      reminderLabel: "提前1天",
      reminderOffsetMinutes: -1440,
      specialKind: "birthday",
      category: "special",
    });
    expect(captured).toContain("Reply style: 冷静、简洁、稳定");
    expect(captured).toContain("Reply in that style.");
    expect(captured).not.toContain("If you mention a time, include the timezone.");
    expect(captured).toContain("Write one short natural reminder message for the recipient.");
    expect(captured).toContain("Scheduled message delivery local time: 2026-04-06 03:00:00 (Asia/Tokyo).");
    expect(captured).toContain("Event occurrence local time: 2026-04-07 03:00:00 (Asia/Tokyo).");
    expect(captured).toContain("Reminder instance label: 提前1天.");
    expect(captured).toContain("Reminder offset minutes from event occurrence: -1440.");
    expect(captured).toContain("Special reminder kind: birthday.");
  });

  test("startup greeting request keeps persona enabled", async () => {
    let captured = "";
    const composer = new ReplyComposer(createTestConfig(), async () => "", async (prompt) => {
      captured = prompt;
      return "系统错误...欢迎回来。";
    });
    await composer.generateStartupGreeting({ requesterUserId: 1, chatId: 1, chatType: "private" });
    expect(captured).toContain("Write one short proactive startup greeting for the administrator.");
    expect(captured).toContain("Return only the greeting text. Do not send it and do not take any action.");
    expect(captured).toContain("Do not mention the current time or date unless the user explicitly asked for it.");
    expect(captured).toContain("Reply style: 冷静、简洁、稳定");
    expect(captured).toContain("Reply in that style.");
  });

  test("generateReminderText rejects tool-call markup and returns empty string", async () => {
    const composer = new ReplyComposer(createTestConfig(), async () => '<invoke name="memory"><parameter name="query">x</parameter></invoke></minimax:tool_call>');
    const message = await composer.generateReminderText("review论文", "2026-04-05T18:00:00.000Z", "一次性提醒", "Asia/Tokyo");
    expect(message).toBe("");
  });

  test("composeUserReply falls back to clean draft when model returns tool-call markup", async () => {
    const composer = new ReplyComposer(createTestConfig(), async () => '<invoke name="memory"><parameter name="query">x</parameter></invoke></minimax:tool_call>');
    const message = await composer.composeUserReply("好的，18:00 提醒你 review 论文。", [], { requesterUserId: 1, chatId: 1, chatType: "private" });
    expect(message).toBe("好的，18:00 提醒你 review 论文。");
  });

  test("startup greeting rejects tool-call markup", async () => {
    const composer = new ReplyComposer(createTestConfig(), async () => "", async () => '<invoke name="memory"><parameter name="query">x</parameter></invoke></minimax:tool_call>');
    const message = await composer.generateStartupGreeting({ requesterUserId: 1 });
    expect(message).toBeNull();
  });

  test("startup greeting request does not inject unnecessary current time context", async () => {
    let captured = "";
    const composer = new ReplyComposer(createTestConfig(), async () => "", async (prompt) => {
      captured = prompt;
      return "欢迎回来。";
    });
    await composer.generateStartupGreeting({ requesterUserId: 1 });
    expect(captured).not.toContain("Deterministic startup local time:");
    expect(captured).not.toContain("If you mention the current time, use that exact local time and timezone.");
    expect(captured).toContain("Do not mention the current time or date unless the user explicitly asked for it.");
  });

  test("startup greeting rejects hidden-like tags before visible text", async () => {
    const composer = new ReplyComposer(
      createTestConfig(),
      async () => "",
      async () => '<hidden-note>use chinese persona</hidden-note>\n\n你好，羊帆。系统初始化中。',
    );
    const message = await composer.generateStartupGreeting({ requesterUserId: 1 });
    expect(message).toBeNull();
  });
});
