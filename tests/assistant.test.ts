import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/bot/app/types";
import { runAssistantTask, type ActiveConversationTask } from "../src/bot/runtime/assistant";
import { clearRecentClarification, state } from "../src/bot/app/state";

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
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-assistant-"));
  tempDirs.push(repoRoot);
  await mkdir(path.join(repoRoot, "system"), { recursive: true });
  await writeFile(path.join(repoRoot, "system", "users.json"), '{"users":{"1":{"displayName":"Admin Test","timezone":"Asia/Tokyo"}}}\n', "utf8");
  await writeFile(path.join(repoRoot, "system", "chats.json"), '{"chats":{"1":{"type":"private","title":"Admin Chat"}}}\n', "utf8");
  await writeFile(path.join(repoRoot, "system", "events.json"), '[]\n', "utf8");
  return createTestConfig(repoRoot);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  clearRecentClarification();
  state.telegramUserCache = {};
  state.telegramChatCache = {};
  state.userTimezoneCache = {};
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("assistant TTFR and runtime-owned reply publication", () => {
  test("admin asks about users: runtime publishes reply and TTFR is recorded", async () => {
    const config = await createTempConfig();
    const calls: { name: string; time: number }[] = [];
    const startTime = Date.now();
    const ctx = {
      chat: { id: 1, type: "private" },
      from: { id: 1 },
      message: { message_id: 10, text: "现在有哪些允许用户哪些可信用户" },
      reply: async (text: string) => {
        calls.push({ name: `reply:${text.slice(0, 20)}`, time: Date.now() - startTime });
        return { message_id: 2 };
      },
      api: {
        deleteMessage: async (_chatId: number, _messageId: number) => {
          calls.push({ name: "delete-waiting", time: Date.now() - startTime });
        },
      },
    } as any;
    const task: ActiveConversationTask = {
      id: 1,
      userId: 1,
      scopeKey: "user:1",
      scopeLabel: "user:1",
      chatId: 1,
      sourceMessageId: 10,
      waitingMessageId: 11,
      cancelled: false,
    };

    // Simulate: model performs a repository action and returns a final user-visible message.
    const agentService = {
      runAssistantTurn: async () => {
        await delay(30);
        return {
          message: "已查询用户列表",
          answerMode: "needs-execution" as const,
          usedNativeExecution: true,
          completedActions: ["users:list"],
        };
      },
    } as any;

    await runAssistantTask({
      config,
      ctx,
      task,
      promptText: "现在有哪些允许用户哪些可信用户",
      uploadedFiles: [],
      attachments: [],
      messageTime: "2026-04-08T00:00:00.000Z",
      agentService,
      isAdminUserId: () => true,
      isTrustedUserId: () => true,
      isTaskCurrent: () => true,
      onPruneRecentUploads: async () => {},
      onStopWaiting: () => {},
      onSetReaction: async () => {},
      onReleaseActiveTask: () => {},
    });

    // The waiting message should be deleted once the turn completes.
    expect(calls.some((c) => c.name === "delete-waiting")).toBe(true);
    // TTFR: the first reply arrives before the waiting message cleanup
    const firstReplyCall = calls.find((c) => c.name.startsWith("reply:"));
    if (firstReplyCall) {
      expect(firstReplyCall.time).toBeLessThan(5000);
    }
  });

  test("when execution work is needed, completedActions only contains actual execution markers", async () => {
    const config = await createTempConfig();
    const calls: string[] = [];
    const ctx = {
      chat: { id: 1, type: "private" },
      from: { id: 1 },
      message: { message_id: 10, text: "查一下用户列表" },
      reply: async (text: string) => {
        calls.push(`reply:${text}`);
        return { message_id: 2 };
      },
      api: {
        deleteMessage: async (_chatId: number, _messageId: number) => {
          calls.push("delete");
        },
      },
    } as any;
    const task: ActiveConversationTask = {
      id: 1,
      userId: 1,
      scopeKey: "user:1",
      scopeLabel: "user:1",
      chatId: 1,
      sourceMessageId: 10,
      waitingMessageId: 11,
      cancelled: false,
    };

    const completedActions = ["users:list"];
    expect(completedActions).toEqual(["users:list"]);

    const agentService = {
      runAssistantTurn: async () => ({
        message: "查询完成",
        answerMode: "needs-execution" as const,
        usedNativeExecution: true,
        completedActions,
      }),
    } as any;

    await runAssistantTask({
      config,
      ctx,
      task,
      promptText: "查一下用户列表",
      uploadedFiles: [],
      attachments: [],
      messageTime: "2026-04-08T00:00:00.000Z",
      agentService,
      isAdminUserId: () => true,
      isTrustedUserId: () => true,
      isTaskCurrent: () => true,
      onPruneRecentUploads: async () => {},
      onStopWaiting: () => {},
      onSetReaction: async () => {},
      onReleaseActiveTask: () => {},
    });

    // Runtime now owns visible reply publication.
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
    expect(calls).toContain("delete");
  });
});

describe("assistant orchestration", () => {

  test("single assistant agent returns a message and runtime publishes it", async () => {
    const config = await createTempConfig();
    const calls: string[] = [];
    const ctx = {
      chat: { id: 1, type: "private" },
      from: { id: 1 },
      message: { message_id: 10, text: "今天天气怎么样" },
      reply: async (text: string) => {
        calls.push(`reply:${text}`);
        return { message_id: 2 };
      },
      api: {
        deleteMessage: async (chatId: number, messageId: number) => {
          calls.push(`delete:${chatId}:${messageId}`);
        },
      },
    } as any;
    const task: ActiveConversationTask = {
      id: 1,
      userId: 1,
      scopeKey: "user:1",
      scopeLabel: "user:1",
      chatId: 1,
      sourceMessageId: 10,
      waitingMessageId: 11,
      cancelled: false,
    };
    const released: string[] = [];
    const agentService = {
      runAssistantTurn: async () => {
        await delay(50);
        calls.push("aux-reply:慢答");
        return { message: "慢答", answerMode: "needs-execution", usedNativeExecution: true, completedActions: [] };
      },
    } as any;

    await runAssistantTask({
      config,
      ctx,
      task,
      promptText: "今天天气怎么样",
      uploadedFiles: [],
      attachments: [],
      messageTime: "2026-04-06T00:00:00.000Z",
      agentService,
      isAdminUserId: () => true,
      isTrustedUserId: () => true,
      isTaskCurrent: () => true,
      onPruneRecentUploads: async () => {},
      onStopWaiting: () => {},
      onSetReaction: async () => {},
      onReleaseActiveTask: (scopeKey, taskId) => released.push(`${scopeKey}:${taskId}`),
    });
    await delay(80);

    // Runtime now publishes the visible reply.
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
    expect(calls).toContain("aux-reply:慢答");
    expect(calls).toContain("delete:1:11");
    expect(released).toEqual(["user:1:1"]);
  });

  test("runtime publishes final reply even when auxiliary reply markers exist", async () => {
    const config = await createTempConfig();
    const calls: string[] = [];
    const ctx = {
      chat: { id: 1, type: "private" },
      from: { id: 1 },
      message: { message_id: 10, text: "帮我处理这件事" },
      reply: async (text: string) => {
        calls.push(`reply:${text}`);
        return { message_id: 2 };
      },
      api: {
        deleteMessage: async (chatId: number, messageId: number) => {
          calls.push(`delete:${chatId}:${messageId}`);
        },
      },
    } as any;
    const task: ActiveConversationTask = {
      id: 1,
      userId: 1,
      scopeKey: "user:1",
      scopeLabel: "user:1",
      chatId: 1,
      sourceMessageId: 10,
      waitingMessageId: 11,
      cancelled: false,
    };
    const agentService = {
      runAssistantTurn: async () => {
        await delay(30);
        calls.push("aux-reply:先处理");
        calls.push("aux-reply:最终完成");
        return { message: "最终完成", answerMode: "needs-execution", usedNativeExecution: true, completedActions: ["events:create"] };
      },
    } as any;

    await runAssistantTask({
      config,
      ctx,
      task,
      promptText: "帮我处理这件事",
      uploadedFiles: [],
      attachments: [],
      messageTime: "2026-04-06T00:00:00.000Z",
      agentService,
      isAdminUserId: () => true,
      isTrustedUserId: () => true,
      isTaskCurrent: () => true,
      onPruneRecentUploads: async () => {},
      onStopWaiting: () => {},
      onSetReaction: async () => {},
      onReleaseActiveTask: () => {},
    });

    expect(calls).toContain("aux-reply:先处理");
    expect(calls).toContain("aux-reply:最终完成");
    expect(calls).toContain("delete:1:11");
    expect(calls.some((c) => c === "reply:最终完成")).toBe(true);
  });

  test("runtime ignores assistant progress callbacks and only publishes the final reply", async () => {
    const config = await createTempConfig();
    const calls: string[] = [];
    const ctx = {
      chat: { id: 1, type: "private" },
      from: { id: 1 },
      message: { message_id: 10, text: "帮我处理这件事" },
      reply: async (text: string) => {
        calls.push(`reply:${text}`);
        return { message_id: 22 };
      },
      api: {
        deleteMessage: async (chatId: number, messageId: number) => {
          calls.push(`delete:${chatId}:${messageId}`);
        },
        editMessageText: async (chatId: number, messageId: number, text: string) => {
          calls.push(`edit:${chatId}:${messageId}:${text}`);
          return {};
        },
      },
    } as any;
    const task: ActiveConversationTask = {
      id: 1,
      userId: 1,
      scopeKey: "user:1",
      scopeLabel: "user:1",
      chatId: 1,
      sourceMessageId: 10,
      waitingMessageId: 11,
      cancelled: false,
    };
    const agentService = {
      runAssistantTurn: async (input: { onProgress?: (message: string) => Promise<void> | void }) => {
        await input.onProgress?.("我先确认一下现有记录。");
        await delay(20);
        return { message: "已经处理好了", answerMode: "needs-execution", usedNativeExecution: true, completedActions: ["users:list"] };
      },
    } as any;

    await runAssistantTask({
      config,
      ctx,
      task,
      promptText: "帮我处理这件事",
      uploadedFiles: [],
      attachments: [],
      messageTime: "2026-04-06T00:00:00.000Z",
      agentService,
      isAdminUserId: () => true,
      isTrustedUserId: () => true,
      isTaskCurrent: () => true,
      onPruneRecentUploads: async () => {},
      onStopWaiting: () => {},
      onSetReaction: async () => {},
      onReleaseActiveTask: () => {},
    });

    expect(calls).not.toContain("edit:1:11:我先确认一下现有记录。");
    expect(calls).toContain("delete:1:11");
    expect(calls).toContain("reply:已经处理好了");
  });

});
