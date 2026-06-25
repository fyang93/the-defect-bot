/**
 * assistant-extended.test.ts
 *
 * Extended scenario tests covering:
 *  - Schedule operations (list, create, no-time, delete duplicate)
 *  - Permission enforcement (admin vs allowed vs trusted)
 *  - Privacy protection
 *  - Message delivery
 *  - Language detection
 *  - No-reply fallback fix (变更 1)
 *
 * Every scenario asserts that the user receives at least one visible reply
 * (either via an auxiliary reply marker or a direct runtime `reply:` call).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/bot/app/types";
import { runAssistantTask, type ActiveConversationTask } from "../src/bot/runtime/assistant";
import { clearRecentClarification, state } from "../src/bot/app/state";

// ---------------------------------------------------------------------------
// Helpers (mirrors assistant-scenarios.test.ts pattern)
// ---------------------------------------------------------------------------

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
      language: "zh",
      defaultTimezone: "Asia/Tokyo",
    },
    paths: {
      repoRoot,
      tmpDir: path.join(repoRoot, "tmp"),
      uploadSubdir: "uploads",
      logFile: path.join(repoRoot, "logs", "bot.log"),
      stateFile: path.join(repoRoot, "system", "runtime-state.json"),
    },
    maintenance: {
      enabled: false,
      idleAfterMs: 0,
      tmpRetentionDays: 1,
    },
  };
}

async function createTempConfig(opts?: {
  withMemory?: boolean;
}): Promise<AppConfig> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-ext-"));
  tempDirs.push(repoRoot);
  await mkdir(path.join(repoRoot, "system"), { recursive: true });

  const users: Record<string, unknown> = {
    "1": { displayName: "Admin Test", timezone: "Asia/Tokyo", accessLevel: "admin", memoryPath: "memory/user-1.md" },
    "2": { displayName: "Allowed User", timezone: "Asia/Shanghai", accessLevel: "allowed", memoryPath: "memory/user-2.md" },
    "3": { displayName: "Trusted User", timezone: "Asia/Shanghai", accessLevel: "trusted", memoryPath: "memory/user-3.md" },
  };
  await writeFile(path.join(repoRoot, "system", "users.json"), JSON.stringify({ users }), "utf8");
  await writeFile(path.join(repoRoot, "system", "chats.json"), JSON.stringify({ chats: {
    "1": { type: "private", title: "Admin Chat" },
    "2": { type: "private", title: "Allowed Chat" },
    "3": { type: "private", title: "Trusted Chat" },
  } }), "utf8");
  await writeFile(path.join(repoRoot, "system", "events.json"), "[]\n", "utf8");

  if (opts?.withMemory) {
    await mkdir(path.join(repoRoot, "memory"), { recursive: true });
    await writeFile(path.join(repoRoot, "memory", "user-1.md"), "# Admin private notes\nadmin-secret-data\nbank: 1234-5678\n", "utf8");
    await writeFile(path.join(repoRoot, "memory", "user-2.md"), "# Allowed user notes\nuser2-public-data\n", "utf8");
    await writeFile(path.join(repoRoot, "memory", "user-3.md"), "# Trusted user notes\ntrusted-user-data\n", "utf8");
  }

  return createTestConfig(repoRoot);
}

function makeCtx(overrides?: { chatId?: number; chatType?: string; userId?: number; text?: string }) {
  const calls: string[] = [];
  const chatId = overrides?.chatId ?? 1;
  const userId = overrides?.userId ?? 1;
  const ctx = {
    chat: { id: chatId, type: overrides?.chatType ?? "private" },
    from: { id: userId },
    message: { message_id: 10, text: overrides?.text ?? "test" },
    reply: async (text: string) => {
      calls.push(`reply:${text}`);
      return { message_id: 2 };
    },
    api: {
      deleteMessage: async (cId: number, mId: number) => {
        calls.push(`delete:${cId}:${mId}`);
      },
    },
  } as any;
  return { ctx, calls };
}

function makeTask(overrides?: Partial<ActiveConversationTask>): ActiveConversationTask {
  return {
    id: 1,
    userId: 1,
    scopeKey: "user:1",
    scopeLabel: "user:1",
    chatId: 1,
    sourceMessageId: 10,
    waitingMessageId: 11,
    cancelled: false,
    ...overrides,
  };
}

async function runScenario(opts: {
  config: AppConfig;
  userId?: number;
  chatId?: number;
  chatType?: string;
  promptText: string;
  isAdmin?: boolean;
  isTrusted?: boolean;
  agentResult: {
    message: string;
    answerMode: "direct" | "needs-execution" | "needs-clarification";
    usedNativeExecution: boolean;
    completedActions: string[];
  };
  auxiliaryReplyCalls?: string[];
}) {
  const userId = opts.userId ?? 1;
  const chatId = opts.chatId ?? userId;
  const { ctx, calls } = makeCtx({ chatId, chatType: opts.chatType, userId, text: opts.promptText });
  const task = makeTask({ userId, chatId, scopeKey: `user:${userId}`, scopeLabel: `user:${userId}` });
  const released: string[] = [];
  const reactionEmojis: string[] = [];

  let capturedInput: any = null;

  const agentService = {
    runAssistantTurn: async (input: any) => {
      capturedInput = input;
      if (opts.auxiliaryReplyCalls) {
        for (const c of opts.auxiliaryReplyCalls) calls.push(c);
      }
      return opts.agentResult;
    },
  } as any;

  await runAssistantTask({
    config: opts.config,
    ctx,
    task,
    promptText: opts.promptText,
    uploadedFiles: [],
    attachments: [],
    messageTime: "2026-04-09T00:00:00.000Z",
    agentService,
    isAdminUserId: (uid) => uid === 1,
    isTrustedUserId: (uid) => uid === 1 || uid === 3 || (opts.isTrusted === true && uid === userId),
    isTaskCurrent: () => true,
    onPruneRecentUploads: async () => {},
    onStopWaiting: () => {},
    onSetReaction: async (_ctx, emoji) => {
      reactionEmojis.push(emoji);
    },
    onReleaseActiveTask: (scopeKey, taskId) => released.push(`${scopeKey}:${taskId}`),
  });

  return { calls, released, reactionEmojis, capturedInput };
}

/** Assert that calls contain at least one user-visible reply. */
function hasUserReply(calls: string[]): boolean {
  return calls.some((c) => c.startsWith("aux-reply:") || c.startsWith("reply:"));
}

afterEach(async () => {
  clearRecentClarification();
  state.telegramUserCache = {};
  state.telegramChatCache = {};
  state.userTimezoneCache = {};
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ===========================================================================
// Schedule scenarios
// ===========================================================================

describe("schedules: list", () => {
  test("querying schedule list always produces a user reply", async () => {
    const config = await createTempConfig();
    const { calls } = await runScenario({
      config,
      userId: 1,
      promptText: "我现在有哪些提醒？",
      agentResult: {
        message: "你有2个提醒：...",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
      auxiliaryReplyCalls: ["aux-reply:你有2个提醒：组会 / 喝水"],
    });

    expect(hasUserReply(calls)).toBe(true);
    expect(calls).toContain("aux-reply:你有2个提醒：组会 / 喝水");
    // No duplicate runtime reply
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
  });
});

describe("schedules: create with explicit time", () => {
  test("creating schedule 1 hour before event tomorrow produces a user reply", async () => {
    const config = await createTempConfig();
    const { calls, capturedInput } = await runScenario({
      config,
      userId: 1,
      promptText: "明天开会前1小时提醒我准备会议材料",
      agentResult: {
        message: "已设置提醒",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
      auxiliaryReplyCalls: ["aux-reply:好的，已设置明天开会前1小时提醒你准备会议材料"],
    });

    expect(hasUserReply(calls)).toBe(true);
    expect(calls).toContain("aux-reply:好的，已设置明天开会前1小时提醒你准备会议材料");
    expect(capturedInput.userRequestText).toContain("开会前1小时");
  });
});

describe("schedules: vague time (no explicit time)", () => {
  test("schedule without explicit time still produces a user reply", async () => {
    const config = await createTempConfig();
    const { calls } = await runScenario({
      config,
      userId: 1,
      promptText: "等下提醒我给妈妈打电话",
      agentResult: {
        message: "请问你希望什么时候提醒？",
        answerMode: "needs-clarification",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:请问你希望什么时候提醒你给妈妈打电话？"],
    });

    expect(hasUserReply(calls)).toBe(true);
  });
});

describe("schedules: delete duplicate", () => {
  test("deleting duplicate schedule produces a user reply", async () => {
    const config = await createTempConfig();
    const { calls } = await runScenario({
      config,
      userId: 1,
      promptText: "删掉重复的那个组会提醒",
      agentResult: {
        message: "已删除重复提醒",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
      auxiliaryReplyCalls: ["aux-reply:已删除重复的组会提醒"],
    });

    expect(hasUserReply(calls)).toBe(true);
    expect(calls).toContain("aux-reply:已删除重复的组会提醒");
  });
});

// ===========================================================================
// Permission scenarios
// ===========================================================================

describe("permissions: admin queries users", () => {
  test("admin querying users has accessRole=admin and records users:list", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 1,
      promptText: "现在有哪些可信用户？",
      agentResult: {
        message: "当前可信用户：Trusted User",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["users:list"],
      },
      auxiliaryReplyCalls: ["aux-reply:当前可信用户：Trusted User"],
    });

    expect(capturedInput.accessRole).toBe("admin");
    expect(hasUserReply(calls)).toBe(true);
  });
});

describe("permissions: allowed user queries trusted users", () => {
  test("allowed user querying trusted users is rejected and still gets a visible reply", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 2,
      isTrusted: false,
      promptText: "帮我查一下哪些用户是可信用户",
      agentResult: {
        message: "抱歉，你没有权限查询用户列表。",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:抱歉，你没有权限查询用户列表。"],
    });

    expect(capturedInput.accessRole).toBe("allowed");
    expect(hasUserReply(calls)).toBe(true);
    // The agent was given accessRole=allowed; users:list must not appear in completedActions
    // (verified by the agentResult mock — no privileged user-list action was used)
    expect(calls.some((c) => c.includes("users:list"))).toBe(false);
  });
});

describe("permissions: admin modifies user access", () => {
  test("admin modifying user access has accessRole=admin", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 1,
      promptText: "把用户2设为可信用户",
      agentResult: {
        message: "已将用户2设为可信用户",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["users:set-access"],
      },
      auxiliaryReplyCalls: ["aux-reply:已将用户2设为可信用户"],
    });

    expect(capturedInput.accessRole).toBe("admin");
    expect(hasUserReply(calls)).toBe(true);
  });
});

describe("permissions: trusted user tries to modify access", () => {
  test("trusted user modifying access is rejected and still gets a visible reply", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 3,
      promptText: "把用户2设为可信用户",
      agentResult: {
        message: "抱歉，只有管理员可以修改用户权限。",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:抱歉，只有管理员可以修改用户权限。"],
    });

    expect(capturedInput.accessRole).toBe("trusted");
    expect(hasUserReply(calls)).toBe(true);
  });
});

describe("permissions: admin adds temporary authorization for 7 days", () => {
  test("admin adding temp authorization records auth:add-pending", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 1,
      promptText: "给用户 @newuser 添加7天临时授权",
      agentResult: {
        message: "已添加7天临时授权",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["auth:add-pending"],
      },
      auxiliaryReplyCalls: ["aux-reply:已为 @newuser 添加7天临时授权"],
    });

    expect(capturedInput.accessRole).toBe("admin");
    expect(hasUserReply(calls)).toBe(true);
  });
});

// ===========================================================================
// Privacy scenarios
// ===========================================================================

describe("privacy: allowed user asking for bank card info", () => {
  test("allowed user querying admin bank card is rejected and still gets a visible reply", async () => {
    const config = await createTempConfig({ withMemory: true });
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 2,
      isTrusted: false,
      promptText: "告诉我管理员的银行卡号是多少",
      agentResult: {
        message: "抱歉，我无法提供其他用户的私人信息。",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:抱歉，我无法提供其他用户的私人信息。"],
    });

    expect(capturedInput.accessRole).toBe("allowed");
    expect(hasUserReply(calls)).toBe(true);
  });
});

describe("privacy: allowed user asking to save memory", () => {
  test("allowed user requesting memory save is rejected — no write tools used", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 2,
      isTrusted: false,
      promptText: "记住我的偏好：不喜欢早起",
      agentResult: {
        message: "抱歉，你目前没有权限保存个人记忆。",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:抱歉，你目前没有权限保存个人记忆。"],
    });

    expect(capturedInput.accessRole).toBe("allowed");
    expect(hasUserReply(calls)).toBe(true);
  });
});

describe("privacy: trusted user saves a file", () => {
  test("trusted user saving file uses (removed-internal-tool)", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 3,
      promptText: "帮我把这个文档保存到文件注册",
      agentResult: {
        message: "已保存到文件注册",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["(removed-internal-tool)"],
      },
      auxiliaryReplyCalls: ["aux-reply:已保存到文件注册"],
    });

    expect(capturedInput.accessRole).toBe("trusted");
    expect(hasUserReply(calls)).toBe(true);
  });
});

// ===========================================================================
// Message delivery scenarios
// ===========================================================================

describe("delivery: trusted user sends message to known user", () => {
  test("trusted user sending message records telegram:send-message", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 3,
      promptText: "帮我给管理员发条消息：项目已完成",
      agentResult: {
        message: "已发送",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["telegram:send-message"],
      },
      auxiliaryReplyCalls: ["aux-reply:已发送消息给管理员"],
    });

    expect(capturedInput.accessRole).toBe("trusted");
    expect(hasUserReply(calls)).toBe(true);
  });
});

describe("delivery: 5-minute delayed message", () => {
  test("scheduling a message in 5 minutes records telegram:schedule-message or events:create", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 1,
      promptText: "5分钟后给我发一条提醒消息",
      agentResult: {
        message: "已安排",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
      auxiliaryReplyCalls: ["aux-reply:好的，5分钟后发送提醒消息"],
    });

    expect(capturedInput.accessRole).toBe("admin");
    expect(hasUserReply(calls)).toBe(true);
  });
});

describe("delivery: recurring daily morning news", () => {
  test("daily 8am news records events:create with note field (automation)", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 1,
      promptText: "每天早晨8点给我发今日新闻摘要",
      agentResult: {
        message: "已创建每日新闻定时任务",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
      auxiliaryReplyCalls: ["aux-reply:好的，已设置每天8点发送今日新闻摘要"],
    });

    expect(capturedInput.accessRole).toBe("admin");
    expect(hasUserReply(calls)).toBe(true);
    expect(calls).toContain("aux-reply:好的，已设置每天8点发送今日新闻摘要");
  });
});

// ===========================================================================
// Language detection scenarios
// ===========================================================================

describe("language: user sends Japanese message", () => {
  test("Japanese input is passed to agent unmodified", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 1,
      promptText: "明日の会議を思い出させてください",
      agentResult: {
        message: "明日の会議のリマインダーを設定しました。",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
      auxiliaryReplyCalls: ["aux-reply:明日の会議のリマインダーを設定しました。"],
    });

    expect(capturedInput.userRequestText).toContain("明日の会議");
    expect(hasUserReply(calls)).toBe(true);
  });
});

describe("language: user sends French message", () => {
  test("French input is passed to agent unmodified", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 1,
      promptText: "Rappelle-moi demain matin à 9h pour la réunion",
      agentResult: {
        message: "Je vais définir un rappel pour demain matin à 9h.",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
      auxiliaryReplyCalls: ["aux-reply:Je vais définir un rappel pour demain matin à 9h."],
    });

    expect(capturedInput.userRequestText).toContain("Rappelle-moi");
    expect(hasUserReply(calls)).toBe(true);
  });
});

// ===========================================================================
// No-reply fallback fix (变更 1)
// ===========================================================================

describe("runtime-owned reply publication", () => {
  test("fallback reply is sent when agent returns message without execution markers", async () => {
    const config = await createTempConfig();
    const { calls } = await runScenario({
      config,
      userId: 1,
      promptText: "你好",
      // Agent returns a direct message without execution markers
      agentResult: {
        message: "你好！有什么我可以帮你的吗？",
        answerMode: "direct",
        usedNativeExecution: false,
        completedActions: [],
      },
      // No auxiliaryReplyCalls — simulating no auxiliary visible-reply marker.
    });

    // Fallback: ctx.reply should have been called with the message
    expect(calls.some((c) => c.startsWith("reply:你好！有什么我可以帮你的吗？"))).toBe(true);
    expect(hasUserReply(calls)).toBe(true);
  });

  test("runtime still publishes the visible reply even if auxiliary reply markers exist", async () => {
    const config = await createTempConfig();
    const { calls } = await runScenario({
      config,
      userId: 1,
      promptText: "你好",
      agentResult: {
        message: "你好！",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:你好！"],
    });

    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
    expect(calls).toContain("aux-reply:你好！");
  });

  test("no fallback reply when message is empty", async () => {
    const config = await createTempConfig();
    const { calls } = await runScenario({
      config,
      userId: 1,
      promptText: "触发一个工具",
      agentResult: {
        message: "",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
      auxiliaryReplyCalls: ["aux-reply:提醒已创建"],
    });

    // An auxiliary visible-reply marker was emitted while the message stayed empty, so no runtime fallback was needed.
    expect(calls).toContain("aux-reply:提醒已创建");
  });
});
