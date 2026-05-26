import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/bot/app/types";
import { AiService } from "../src/bot/ai";

function createTestConfig(): AppConfig {
  const repoRoot = path.join(os.tmpdir(), "defect-bot-gateway-tools-test");
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

describe("gateway execution history", () => {
  test("generateReminderText uses text-only writer mode without tool execution", async () => {
    const service = new AiService(createTestConfig()) as any;
    let capturedBody: any = null;
    service.client = {
      path: {
        get: async () => ({ data: {} }),
      },
      session: {
        create: async () => ({ data: { id: "ses_writer" } }),
        abort: async () => ({ data: {} }),
        prompt: async ({ body }: any) => {
          capturedBody = body;
          return {
            data: {
              parts: [
                { type: "text", text: "明早 8 点提醒你带钱包。" },
              ],
            },
          };
        },
      },
    };

    const result = await service.generateReminderText("带钱包", "2026-04-12T08:00:00.000Z", "一次性提醒", "Asia/Tokyo");
    expect(result).toBe("明早 8 点提醒你带钱包。");
    expect(capturedBody?.agent).toBeUndefined();
    expect(String(capturedBody?.system || "")).toContain("text-only reply writer");
    expect(String(capturedBody?.parts?.[0]?.text || "")).toContain("Write one short natural reminder message for the recipient.");
    expect(String(capturedBody?.parts?.[0]?.text || "")).toContain("Scheduled message delivery local time: 2026-04-12 17:00:00 (Asia/Tokyo).");
  });

  test("automation content generation uses the assistant build lane instead of writer mode", async () => {
    const service = new AiService(createTestConfig()) as any;
    let capturedBody: any = null;
    service.client = {
      path: {
        get: async () => ({ data: {} }),
      },
      session: {
        create: async () => ({ data: { id: "ses_assistant_scheduled_task" } }),
        abort: async () => ({ data: {} }),
        prompt: async ({ body }: any) => {
          capturedBody = body;
          return {
            data: {
              parts: [
                { type: "tool", tool: "web_search", state: { status: "completed" } },
                { type: "text", text: "今日要闻：……" },
              ],
            },
          };
        },
      },
    };

    const result = await service.generateScheduledTaskContent("生成一段每日简报");
    expect(result).toBe("今日要闻：……");
    expect(capturedBody?.agent).toBe("build");
    expect(String(capturedBody?.system || "")).toContain("main assistant for a local-first Telegram bot");
  });

  test("startup greeting and other reply-composer text generation methods use writer mode", async () => {
    const service = new AiService(createTestConfig()) as any;
    const capturedBodies: any[] = [];
    service.client = {
      path: {
        get: async () => ({ data: {} }),
      },
      session: {
        create: async () => ({ data: { id: `ses_writer_${capturedBodies.length}` } }),
        abort: async () => ({ data: {} }),
        prompt: async ({ body }: any) => {
          capturedBodies.push(body);
          return {
            data: {
              parts: [
                { type: "text", text: "好的。" },
              ],
            },
          };
        },
      },
    };

    await service.generateStartupGreeting({ requesterUserId: 1 });
    await service.composeUserReply("草稿", ["事实1"], { requesterUserId: 1, chatId: 1, chatType: "private" });

    expect(capturedBodies.length).toBe(2);
    for (const body of capturedBodies) {
      expect(body?.agent).toBeUndefined();
      expect(String(body?.system || "")).toContain("text-only reply writer");
    }
  });

  test("writer mode rejects tool execution in light text sessions", async () => {
    const service = new AiService(createTestConfig()) as any;
    service.client = {
      path: {
        get: async () => ({ data: {} }),
      },
      session: {
        create: async () => ({ data: { id: "ses_writer_tool_violation" } }),
        abort: async () => ({ data: {} }),
        prompt: async () => ({
          data: {
            parts: [
              { type: "tool", tool: "telegram:send-message", state: { status: "completed" } },
              { type: "text", text: "已发送启动问候给管理员。" },
            ],
          },
        }),
      },
    };

    await expect(service.generateStartupGreeting({ requesterUserId: 1 })).rejects.toThrow("writer text generation must not execute tools");
  });

  test("assistant can recover completed actions from session history when final payload omits execution parts", async () => {
    const service = new AiService(createTestConfig()) as any;
    service.client = {
      session: {
        prompt: async () => ({
          data: {
            info: { parentID: "msg_user_1" },
            parts: [
              { type: "step-start" },
              { type: "text", text: "已创建提醒" },
              { type: "step-finish" },
            ],
          },
        }),
        messages: async () => ({
          data: [
            {
              info: { role: "assistant", parentID: "msg_user_1" },
              parts: [
                { type: "tool", tool: "telegram:send-message", state: { status: "completed" } },
                { type: "tool", tool: "events:create", state: { status: "completed" } },
              ],
            },
            {
              info: { role: "assistant", parentID: "msg_user_1" },
              parts: [
                { type: "text", text: "已创建提醒" },
              ],
            },
            {
              info: { role: "assistant", parentID: "msg_other" },
              parts: [
                { type: "tool", tool: "users:list", state: { status: "completed" } },
              ],
            },
          ],
        }),
      },
    };

    const result = await service.promptSessionForAssistant("ses_test", "创建提醒：明天下午3点开会", []);
    expect(result.usedNativeExecution).toBe(true);
    expect(result.completedActions).toEqual(["telegram:send-message", "events:create"]);
  });

});
