import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/bot/app/types";
import { AiService } from "../src/bot/ai";

function createTestConfig(): AppConfig {
  const repoRoot = path.join(os.tmpdir(), "defect-bot-gateway-tools-test");
  return {
    telegram: { botToken: "test", adminUserId: 1, waitingMessage: "", inputMergeWindowSeconds: 3, menuPageSize: 10 },
    bot: { personaStyle: "模仿杀戮尖塔里的故障机器人说话。", language: "zh-CN", defaultTimezone: "Asia/Tokyo" },
    paths: {
      repoRoot,
      tmpDir: path.join(repoRoot, "tmp"),
      uploadSubdir: "uploads",
      logFile: path.join(repoRoot, "logs", "bot.log"),
      stateFile: path.join(repoRoot, "system", "state.json"),
    },
    maintenance: { enabled: false, idleAfterMs: 0, tmpRetentionDays: 1 },
  };
}

type FakeMessage = { role: string; content?: Array<{ type: string; text?: string; name?: string }> };

function installFakePiSession(service: any, responses: FakeMessage[], calls: any[] = [], toolNames: string[] = []): void {
  service.ensureReady = async () => {};
  service.createSession = async (_scopeKey: string | undefined, scopeLabel: string | undefined, role: string, useTools = role === "assistant", options?: any) => {
    const listeners: Array<(event: any) => void> = [];
    const session: any = {
      sessionId: `ses_${role}_${calls.length}`,
      messages: [],
      setSessionName: () => {},
      subscribe: (listener: (event: any) => void) => {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
      prompt: async (text: string) => {
        calls.push({ text, role, useTools, scopeLabel, options });
        session.messages.push({ role: "user", content: text, timestamp: Date.now() });
        for (const toolName of toolNames) {
          for (const listener of listeners) listener({ type: "tool_execution_end", toolName, isError: false });
        }
        session.messages.push(...responses);
      },
      abort: async () => {},
      dispose: () => {},
    };
    return { sessionId: session.sessionId, session };
  };
}

function installFakePiSessionWithUserEchoAfterAssistant(service: any, calls: any[] = []): void {
  service.ensureReady = async () => {};
  service.createSession = async (_scopeKey: string | undefined, scopeLabel: string | undefined, role: string, useTools = role === "assistant", options?: any) => {
    const listeners: Array<(event: any) => void> = [];
    const session: any = {
      sessionId: `ses_${role}_${calls.length}`,
      messages: [],
      setSessionName: () => {},
      subscribe: (listener: (event: any) => void) => {
        listeners.push(listener);
        return () => {};
      },
      prompt: async (text: string) => {
        calls.push({ text, role, useTools, scopeLabel, options });
        session.messages.push({ role: "assistant", content: [{ type: "text", text: "启动完成。" }] });
        session.messages.push({ role: "user", content: [{ type: "text", text }] });
      },
      abort: async () => {},
      dispose: () => {},
    };
    return { sessionId: session.sessionId, session };
  };
}

describe("gateway execution history", () => {
  test("generateReminderText uses text-only writer mode without tool execution", async () => {
    const service = new AiService(createTestConfig()) as any;
    const calls: any[] = [];
    installFakePiSession(service, [{ role: "assistant", content: [{ type: "text", text: "明早 8 点提醒你带钱包。" }] }], calls);

    const result = await service.generateReminderText("带钱包", "2026-04-12T08:00:00.000Z", "一次性提醒", "Asia/Tokyo");
    expect(result).toBe("明早 8 点提醒你带钱包。");
    expect(calls[0].role).toBe("writer");
    expect(calls[0].useTools).toBe(false);
    expect(calls[0].text).toContain("Write one short natural reminder message for the recipient.");
    expect(calls[0].text).toContain("Scheduled message delivery local time: 2026-04-12 17:00:00 (Asia/Tokyo).");
  });

  test("automation content generation uses composer web mode with only web tools", async () => {
    const service = new AiService(createTestConfig()) as any;
    const calls: any[] = [];
    installFakePiSession(service, [{ role: "assistant", content: [{ type: "text", text: "今日要闻：……" }] }], calls, ["web_search"]);

    const result = await service.generateScheduledTaskContent("生成一段每日简报");
    expect(result).toBe("今日要闻：……");
    expect(calls[0].role).toBe("writer");
    expect(calls[0].useTools).toBe(true);
    expect(calls[0].options).toMatchObject({ noContextFiles: true, noSkills: true, toolAllowlist: ["web_search", "fetch_content", "get_search_content"] });
    expect(calls[0].text).toContain("Generate fresh, useful content");
    expect(calls[0].text).toContain("Task: scheduled-content");
  });

  test("startup greeting and other reply-composer text generation methods use writer mode", async () => {
    const service = new AiService(createTestConfig()) as any;
    const calls: any[] = [];
    installFakePiSession(service, [{ role: "assistant", content: [{ type: "text", text: "好的。" }] }], calls);

    await service.generateStartupGreeting({ requesterUserId: 1 });
    await service.composeMaintenanceReport(["事实1"], { requesterUserId: 1, chatId: 1, chatType: "private" });

    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.role).toBe("writer");
      expect(call.useTools).toBe(false);
    }
  });

  test("writer mode extracts assistant text instead of echoing the user prompt", async () => {
    const service = new AiService(createTestConfig()) as any;
    installFakePiSessionWithUserEchoAfterAssistant(service);

    const result = await service.generateStartupGreeting({ requesterUserId: 1 });
    expect(result).toBe("启动完成。");
  });

  test("writer mode rejects tool execution in light text sessions", async () => {
    const service = new AiService(createTestConfig()) as any;
    installFakePiSession(service, [{ role: "assistant", content: [{ type: "toolCall", name: "telegram_send_message" }, { type: "text", text: "已发送启动问候给管理员。" }] }]);

    await expect(service.generateStartupGreeting({ requesterUserId: 1 })).rejects.toThrow("writer text generation must not execute tools");
  });

  test("assistant empty output throws so runtime can react failure", async () => {
    const service = new AiService(createTestConfig()) as any;
    const calls: any[] = [];
    installFakePiSession(service, [{ role: "assistant", content: [] }], calls);

    await expect(service.runAssistantTurn({ userRequestText: "记录一下李博", accessRole: "admin" })).rejects.toThrow("Assistant returned no displayable output");
    expect(calls).toHaveLength(2);
  });

  test("assistant records completed actions from Pi SDK tool events", async () => {
    const service = new AiService(createTestConfig()) as any;
    const calls: any[] = [];
    installFakePiSession(service, [{ role: "assistant", content: [{ type: "text", text: "已创建提醒" }] }], calls, ["telegram_send_message", "event_create"]);
    const entry = await service.createSession(undefined, "test", "assistant", true);

    const result = await service.promptSessionForAssistant(entry.session, "创建提醒：明天下午3点开会", []);
    expect(result.usedNativeExecution).toBe(true);
    expect(result.completedActions).toEqual(["telegram_send_message", "event_create"]);
  });
});
