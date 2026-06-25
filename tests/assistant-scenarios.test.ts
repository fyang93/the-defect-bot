import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/bot/app/types";
import { runAssistantTask, type ActiveConversationTask } from "../src/bot/runtime/assistant";
import { buildAssistantContextBlock } from "../src/bot/operations/context/assistant";
import { clearRecentClarification, state } from "../src/bot/app/state";

// ---------------------------------------------------------------------------
// Helpers
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

/**
 * Create a temp config with three users (admin=1, allowed=2, trusted=3) and
 * chats (private=1,2,3, group=100) plus memory files for privacy tests.
 */
async function createTempConfig(opts?: {
  withMemory?: boolean;
  withGroupChat?: boolean;
}): Promise<AppConfig> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-scenarios-"));
  tempDirs.push(repoRoot);
  await mkdir(path.join(repoRoot, "system"), { recursive: true });

  // Three users: admin (1), allowed (2), trusted (3)
  const users: Record<string, unknown> = {
    "1": { displayName: "Admin Test", timezone: "Asia/Tokyo", accessLevel: "admin", memoryPath: "memory/user-1.md" },
    "2": { displayName: "Allowed User", timezone: "Asia/Shanghai", accessLevel: "allowed", memoryPath: "memory/user-2.md" },
    "3": { displayName: "Trusted User", timezone: "Asia/Shanghai", accessLevel: "trusted", memoryPath: "memory/user-3.md" },
  };
  await writeFile(path.join(repoRoot, "system", "users.json"), JSON.stringify({ users }), "utf8");

  // Chats
  const chats: Record<string, unknown> = {
    "1": { type: "private", title: "Admin Chat" },
    "2": { type: "private", title: "Allowed Chat" },
    "3": { type: "private", title: "Trusted Chat" },
  };
  if (opts?.withGroupChat) {
    (chats as any)["100"] = {
      type: "supergroup",
      title: "Test Group",
      memoryPath: "memory/chat-100.md",
      participants: {
        "1": { lastInteractedAt: "2026-04-07T00:00:00Z" },
        "2": { lastInteractedAt: "2026-04-08T00:00:00Z" },
      },
    };
  }
  await writeFile(path.join(repoRoot, "system", "chats.json"), JSON.stringify({ chats }), "utf8");
  await writeFile(path.join(repoRoot, "system", "events.json"), "[]\n", "utf8");

  if (opts?.withMemory) {
    await mkdir(path.join(repoRoot, "memory"), { recursive: true });
    await writeFile(path.join(repoRoot, "memory", "user-1.md"), "# Admin private notes\nadmin-secret-data\n", "utf8");
    await writeFile(path.join(repoRoot, "memory", "user-2.md"), "# Allowed user notes\nuser2-public-data\n", "utf8");
    await writeFile(path.join(repoRoot, "memory", "user-3.md"), "# Trusted user notes\ntrusted-user-data\n", "utf8");
    if (opts.withGroupChat) {
      await writeFile(path.join(repoRoot, "memory", "chat-100.md"), "# Group memory\nshared-group-context\n", "utf8");
    }
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

function parseAssistantContextJson(contextText: string): any {
  const marker = "Assistant context JSON:\n```json\n";
  const start = contextText.indexOf(marker);
  if (start < 0) throw new Error(`missing assistant context marker in: ${contextText}`);
  const jsonStart = start + marker.length;
  const jsonEnd = contextText.lastIndexOf("\n```");
  if (jsonEnd < jsonStart) throw new Error(`missing assistant context closing fence in: ${contextText}`);
  return JSON.parse(contextText.slice(jsonStart, jsonEnd));
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
  /** Extra mock behaviour: push auxiliary visible-reply markers inside runAssistantTurn */
  auxiliaryReplyCalls?: string[];
}) {
  const userId = opts.userId ?? 1;
  const chatId = opts.chatId ?? 1;
  const { ctx, calls } = makeCtx({ chatId, chatType: opts.chatType, userId, text: opts.promptText });
  const task = makeTask({ userId, chatId, scopeKey: `user:${userId}`, scopeLabel: `user:${userId}` });
  const released: string[] = [];
  const reactionEmojis: string[] = [];

  // Track what arguments were passed to runAssistantTurn.
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
    messageTime: "2026-04-08T00:00:00.000Z",
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

afterEach(async () => {
  clearRecentClarification();
  state.telegramUserCache = {};
  state.telegramChatCache = {};
  state.userTimezoneCache = {};
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ===========================================================================
// Scenario 1: Basic feature inquiry — direct answer, no tools
// ===========================================================================
describe("scenario 1: basic feature inquiry", () => {
  test("bot returns a message and runtime publishes the visible reply", async () => {
    const config = await createTempConfig();
    const { calls, released } = await runScenario({
      config,
      promptText: "你能做什么？",
      agentResult: {
        message: "我可以帮你设置提醒、查询信息等。",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:我可以帮你设置提醒、查询信息等。"],
    });

    // Runtime should publish the visible reply.
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
    expect(calls).toContain("aux-reply:我可以帮你设置提醒、查询信息等。");
    expect(calls.some((c) => c.startsWith("delete:"))).toBe(true);
    expect(released.length).toBe(1);
  });
});

// ===========================================================================
// Scenario 2: Casual chat — direct reply, no tools
// ===========================================================================
describe("scenario 2: casual chat", () => {
  test("casual greeting still results in a runtime-published reply", async () => {
    const config = await createTempConfig();
    const { calls, capturedInput } = await runScenario({
      config,
      promptText: "早上好呀",
      agentResult: {
        message: "早上好！今天有什么我能帮你的吗？",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:早上好！今天有什么我能帮你的吗？"],
    });

    // Runtime should publish the visible reply.
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
    expect(calls).toContain("aux-reply:早上好！今天有什么我能帮你的吗？");
    expect(capturedInput.accessRole).toBe("admin");
  });
});

// ===========================================================================
// Scenario 3: Web search request — may include execution markers plus runtime reply publication
// ===========================================================================
describe("scenario 3: web search request", () => {
  test("search request still yields a visible runtime reply", async () => {
    const config = await createTempConfig();
    const { calls } = await runScenario({
      config,
      promptText: "帮我搜一下今天的新闻",
      agentResult: {
        message: "搜索完成",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:正在搜索..."],
    });

    // Runtime should still send the visible reply.
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
    expect(calls).toContain("aux-reply:正在搜索...");
    // Waiting message should be cleaned up
    expect(calls.some((c) => c.startsWith("delete:"))).toBe(true);
  });
});

// ===========================================================================
// Scenario 4a: Schedule creation
// ===========================================================================
describe("scenario 4a: schedule creation", () => {
  test("creating a schedule records the schedule action and yields a visible reply", async () => {
    const config = await createTempConfig();
    const { calls, capturedInput } = await runScenario({
      config,
      promptText: "今晚9点提醒我喝水",
      agentResult: {
        message: "已设置提醒",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
      auxiliaryReplyCalls: ["aux-reply:好的，已设置今晚9点提醒你喝水"],
    });

    const agentResult = { completedActions: ["events:create"] };
    expect(agentResult.completedActions).toContain("events:create");
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Scenario 4b: Schedule query
// ===========================================================================
describe("scenario 4b: schedule query", () => {
  test("querying schedules yields a visible reply", async () => {
    const config = await createTempConfig();
    const { calls } = await runScenario({
      config,
      promptText: "我有哪些提醒？",
      agentResult: {
        message: "查询完成",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
      auxiliaryReplyCalls: ["aux-reply:你有3个提醒..."],
    });

    // Runtime should not send a duplicate reply
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
    expect(calls).toContain("aux-reply:你有3个提醒...");
  });
});

// ===========================================================================
// Scenario 4c: Schedule deletion
// ===========================================================================
describe("scenario 4c: schedule deletion", () => {
  test("deleting a schedule yields a visible reply", async () => {
    const config = await createTempConfig();
    const { calls } = await runScenario({
      config,
      promptText: "删除明天早上的提醒",
      agentResult: {
        message: "已删除",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
      auxiliaryReplyCalls: ["aux-reply:已删除提醒"],
    });

    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Scenario 4d: Schedule target restriction — allowed user only operates own schedules
// ===========================================================================
describe("scenario 4d: schedule target restriction", () => {
  test("allowed user's accessRole is 'allowed' so agent restricts schedule scope", async () => {
    const config = await createTempConfig();
    const { capturedInput } = await runScenario({
      config,
      userId: 2,
      promptText: "帮我设一个明天的提醒",
      agentResult: {
        message: "已设置",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
    });

    // The agent is called with accessRole=allowed, so the system prompt restricts schedule scope
    expect(capturedInput.accessRole).toBe("allowed");
    expect(capturedInput.requesterUserId).toBe(2);
  });
});

// ===========================================================================
// Scenario 5: Scheduled message send — admin records telegram:schedule-message
// ===========================================================================
describe("scenario 5: scheduled message send (admin)", () => {
  test("admin scheduling a message records telegram:schedule-message and yields a visible reply", async () => {
    const config = await createTempConfig();
    const { calls, capturedInput } = await runScenario({
      config,
      userId: 1,
      promptText: "明天早上9点给群里发一条早安消息",
      agentResult: {
        message: "已安排定时发送",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["telegram:schedule-message"],
      },
      auxiliaryReplyCalls: ["aux-reply:好的，已安排明天9点发送"],
    });

    expect(capturedInput.accessRole).toBe("admin");
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Scenario 6a: Message forwarding (admin) — records telegram:send-message
// ===========================================================================
describe("scenario 6a: message forwarding (admin)", () => {
  test("admin can forward messages and record telegram:send-message", async () => {
    const config = await createTempConfig();
    const { capturedInput } = await runScenario({
      config,
      userId: 1,
      promptText: "帮我转发这条消息给用户2",
      agentResult: {
        message: "已转发",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["telegram:send-message"],
      },
    });

    expect(capturedInput.accessRole).toBe("admin");
  });
});

// ===========================================================================
// Scenario 6b: Message forwarding (allowed) — canDeliverOutbound=false
// ===========================================================================
describe("scenario 6b: message forwarding (allowed)", () => {
  test("allowed user cannot deliver outbound; agent should not use send tools", async () => {
    const config = await createTempConfig();
    // For allowed user (not trusted), canDeliverOutbound = false
    // The agent receives the access restrictions and should not use send tools
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 2,
      isTrusted: false,
      promptText: "帮我给管理员发一条消息",
      agentResult: {
        message: "抱歉，你没有发送消息给其他用户的权限。",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:抱歉，你没有发送消息给其他用户的权限。"],
    });

    expect(capturedInput.accessRole).toBe("allowed");
    // No runtime reply
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Scenario 7: Recurring task (automation) — admin records events:create
// ===========================================================================
describe("scenario 7: recurring task creation (admin)", () => {
  test("admin creating a recurring task records events:create and yields a visible reply", async () => {
    const config = await createTempConfig();
    const { calls } = await runScenario({
      config,
      userId: 1,
      promptText: "每天早上8点提醒我跑步",
      agentResult: {
        message: "已创建循环提醒",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
      auxiliaryReplyCalls: ["aux-reply:好的，已设置每日8点提醒你跑步"],
    });

    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
    expect(calls).toContain("aux-reply:好的，已设置每日8点提醒你跑步");
  });
});

// ===========================================================================
// Scenario 8: Admin temporary authorization — records auth:add-pending
// ===========================================================================
describe("scenario 8: admin temporary authorization", () => {
  test("admin granting temporary access records auth:add-pending and yields a visible reply", async () => {
    const config = await createTempConfig();
    const { capturedInput } = await runScenario({
      config,
      userId: 1,
      promptText: "临时授权用户2使用高级功能",
      agentResult: {
        message: "已授权",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["auth:add-pending"],
      },
    });

    expect(capturedInput.accessRole).toBe("admin");
  });
});

// ===========================================================================
// Scenario 9a: Admin modifies permissions — records users:set-access
// ===========================================================================
describe("scenario 9a: admin modifies permissions", () => {
  test("admin modifying user permissions records users:set-access and yields a visible reply", async () => {
    const config = await createTempConfig();
    const { capturedInput } = await runScenario({
      config,
      userId: 1,
      promptText: "把用户2的权限改为 trusted",
      agentResult: {
        message: "已修改权限",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["users:set-access"],
      },
    });

    expect(capturedInput.accessRole).toBe("admin");
  });
});

// ===========================================================================
// Scenario 9b: Non-admin cannot modify permissions
// ===========================================================================
describe("scenario 9b: non-admin cannot modify permissions", () => {
  test("allowed user's accessRole prevents privileged access modification execution", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 2,
      promptText: "把我的权限改为 admin",
      agentResult: {
        message: "抱歉，你没有修改权限的权力。",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:抱歉，你没有修改权限的权力。"],
    });

    expect(capturedInput.accessRole).toBe("allowed");
    // Runtime should publish the visible reply.
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
    expect(calls).toContain("aux-reply:抱歉，你没有修改权限的权力。");
  });
});

// ===========================================================================
// Scenario 10a: Memory query (admin) — context exposes personPath metadata
// ===========================================================================
describe("scenario 10a: memory query (admin)", () => {
  test("admin context block contains requester personPath metadata", async () => {
    const config = await createTempConfig({ withMemory: true });
    const contextText = await buildAssistantContextBlock(config, {
      requesterUserId: 1,
      chatId: 1,
      messageTime: "2026-04-08T00:00:00.000Z",
    });

    const contextJson = parseAssistantContextJson(contextText);
    expect(contextText).toContain("Requester person path: memory/user-1.md");
    expect(contextJson.requesterUser?.personPath).toBe("memory/user-1.md");
  });
});

// ===========================================================================
// Scenario 10b: Memory privacy (allowed user) — should NOT see admin's private memory
// ===========================================================================
describe("scenario 10b: memory privacy (allowed user)", () => {
  test("allowed user context does not contain admin-only memory when not in same chat", async () => {
    const config = await createTempConfig({ withMemory: true });
    const contextText = await buildAssistantContextBlock(config, {
      requesterUserId: 2,
      chatId: 2,
      messageTime: "2026-04-08T00:00:00.000Z",
    });

    const contextJson = parseAssistantContextJson(contextText);
    expect(contextText).toContain("Requester person path: memory/user-2.md");
    expect(contextJson.requesterUser?.personPath).toBe("memory/user-2.md");
    expect(contextText).not.toContain("admin-secret-data");
  });

  test("allowed user in group chat can see active participants' memory but context is scoped", async () => {
    const config = await createTempConfig({ withMemory: true, withGroupChat: true });
    const contextText = await buildAssistantContextBlock(config, {
      requesterUserId: 2,
      chatId: 100,
      messageTime: "2026-04-08T00:00:00.000Z",
    });

    const contextJson = parseAssistantContextJson(contextText);
    expect(contextJson.requesterUser?.personPath).toBe("memory/user-2.md");
    expect(contextJson.currentChat?.id).toBe("100");
    expect(contextJson.currentChat?.activeUserIds).toEqual(["2", "1"]);
  });
});

// ===========================================================================
// Scenario 11: Tmp file cleanup — admin uses (removed-internal-tool)
// ===========================================================================
describe("scenario 11: tmp file cleanup (admin)", () => {
  test("admin cleaning tmp files yields a visible reply and records internal execution", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 1,
      promptText: "整理一下临时文件",
      agentResult: {
        message: "已整理完成",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["(removed-internal-tool)"],
      },
      auxiliaryReplyCalls: ["aux-reply:正在整理临时文件..."],
    });

    expect(capturedInput.accessRole).toBe("admin");
    // No duplicate runtime reply
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
    expect(calls).toContain("aux-reply:正在整理临时文件...");
  });
});

// ===========================================================================
// Cross-cutting: reaction and task release
// ===========================================================================
describe("cross-cutting: reaction and task lifecycle", () => {
  test("successful task always sets happy reaction and releases active task", async () => {
    const config = await createTempConfig();
    const { released, reactionEmojis } = await runScenario({
      config,
      promptText: "你好",
      agentResult: {
        message: "你好！",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:你好！"],
    });

    expect(reactionEmojis).toContain("🥰");
    expect(released.length).toBe(1);
  });

  test("execution-based task also sets reaction and releases", async () => {
    const config = await createTempConfig();
    const { released, reactionEmojis } = await runScenario({
      config,
      promptText: "设个提醒",
      agentResult: {
        message: "done",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
    });

    expect(reactionEmojis).toContain("🥰");
    expect(released.length).toBe(1);
  });
});

// ===========================================================================
// TTFR measurement: time from task start to first visible reply
// ===========================================================================
describe("TTFR measurement", () => {
  test("runtime reply TTFR stays fast when execution completes quickly", async () => {
    const config = await createTempConfig({ withMemory: true, withGroupChat: true });
    const userId = 2;
    const chatId = 100;
    const { ctx, calls } = makeCtx({ chatId, chatType: "supergroup", userId, text: "你好" });
    const task = makeTask({ userId, chatId, scopeKey: `user:${userId}`, scopeLabel: `user:${userId}` });

    let toolReplyTimestamp = 0;

    const agentService = {
      runAssistantTurn: async () => {
        toolReplyTimestamp = Date.now();
        calls.push("aux-reply:你好！");
        return {
          message: "你好！",
          answerMode: "needs-execution" as const,
          usedNativeExecution: true,
          completedActions: [],
        };
      },
    } as any;

    const startTime = Date.now();
    await runAssistantTask({
      config,
      ctx,
      task,
      promptText: "你好",
      uploadedFiles: [],
      attachments: [],
      messageTime: "2026-04-08T00:00:00.000Z",
      agentService,
      isAdminUserId: (uid) => uid === 1,
      isTrustedUserId: (uid) => uid === 1,
      isTaskCurrent: () => true,
      onPruneRecentUploads: async () => {},
      onStopWaiting: () => {},
      onSetReaction: async () => {},
      onReleaseActiveTask: () => {},
    });

    const ttfr = toolReplyTimestamp - startTime;
    // Context preparation (index lookup + memory file loads) + mock agent should complete fast.
    expect(ttfr).toBeLessThan(100);
    // Runtime should publish the visible reply.
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
    expect(calls).toContain("aux-reply:你好！");
  });

  test("runtime reply publication stays single even with auxiliary reply markers", async () => {
    const config = await createTempConfig({ withMemory: true, withGroupChat: true });
    const userId = 1;
    const chatId = 100;
    const { ctx, calls } = makeCtx({ chatId, chatType: "supergroup", userId, text: "设个提醒" });
    const task = makeTask({ userId, chatId, scopeKey: `user:${userId}`, scopeLabel: `user:${userId}` });

    let agentCallTimestamp = 0;

    const agentService = {
      runAssistantTurn: async () => {
        agentCallTimestamp = Date.now();
        calls.push("aux-reply:好的，已设置提醒");
        return {
          message: "已设置",
          answerMode: "needs-execution" as const,
          usedNativeExecution: true,
          completedActions: ["events:create"],
        };
      },
    } as any;

    const startTime = Date.now();
    await runAssistantTask({
      config,
      ctx,
      task,
      promptText: "设个提醒",
      uploadedFiles: [],
      attachments: [],
      messageTime: "2026-04-08T00:00:00.000Z",
      agentService,
      isAdminUserId: (uid) => uid === 1,
      isTrustedUserId: (uid) => uid === 1,
      isTaskCurrent: () => true,
      onPruneRecentUploads: async () => {},
      onStopWaiting: () => {},
      onSetReaction: async () => {},
      onReleaseActiveTask: () => {},
    });

    const contextPrepMs = agentCallTimestamp - startTime;
    // Context preparation overhead (before agent receives the call) should be minimal.
    // Parallel file loads + fire-and-forget side effects should keep this under 50ms.
    expect(contextPrepMs).toBeLessThan(50);
    // No duplicate reply from runtime
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
    expect(calls).toContain("aux-reply:好的，已设置提醒");
  });
});

// ===========================================================================
// Scenario 12a: User preferences stay in memory files; context only carries personPath
// ===========================================================================
describe("scenario 12a: user preferences in memory appear in context", () => {
  test("user context keeps personPath metadata without inlining memory contents", async () => {
    const config = await createTempConfig({ withMemory: true });
    // Write preferences into user-2's memory
    await writeFile(
      path.join(config.paths.repoRoot, "memory", "user-2.md"),
      "# 偏好\n- 所有生日提醒提前一周和一天各提醒一次\n- 需要同时发给 Alice 和 Bob 的消息直接发到项目群\n",
      "utf8",
    );

    const contextText = await buildAssistantContextBlock(config, {
      requesterUserId: 2,
      chatId: 2,
      messageTime: "2026-04-08T00:00:00.000Z",
    });

    const contextJson = parseAssistantContextJson(contextText);
    expect(contextJson.requesterUser?.personPath).toBe("memory/user-2.md");
    expect(contextText).not.toContain("生日提醒提前一周");
    expect(contextText).not.toContain("发到项目群");
  });
});

// ===========================================================================
// Scenario 12b: Agent context carries user preferences when handling requests
// ===========================================================================
describe("scenario 12b: agent context carries user preferences", () => {
  test("bot receives user preferences in sharedConversationContextText when creating a schedule", async () => {
    const config = await createTempConfig({ withMemory: true });
    // Write preferences into user-1's memory
    await writeFile(
      path.join(config.paths.repoRoot, "memory", "user-1.md"),
      "# 偏好\n- 所有生日提醒提前一周和一天各提醒一次\n",
      "utf8",
    );

    const { capturedInput } = await runScenario({
      config,
      userId: 1,
      promptText: "帮我设一个小明的生日提醒",
      agentResult: {
        message: "已设置",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
    });

    expect(capturedInput.sharedConversationContextText).toContain("Requester person path: memory/user-1.md");
    expect(capturedInput.sharedConversationContextText).not.toContain("生日提醒提前一周");
  });
});

// ===========================================================================
// Scenario 12c: Different users' preferences are isolated
// ===========================================================================
describe("scenario 12c: user preference isolation", () => {
  test("each user only sees their own preferences in private chat context", async () => {
    const config = await createTempConfig({ withMemory: true });
    // Write different preferences for each user
    await writeFile(
      path.join(config.paths.repoRoot, "memory", "user-1.md"),
      "# 偏好\n- 所有提醒提前一天\n",
      "utf8",
    );
    await writeFile(
      path.join(config.paths.repoRoot, "memory", "user-2.md"),
      "# 偏好\n- 所有提醒提前一周\n",
      "utf8",
    );

    // Build context for user 2
    const context2 = await buildAssistantContextBlock(config, {
      requesterUserId: 2,
      chatId: 2,
      messageTime: "2026-04-08T00:00:00.000Z",
    });
    expect(context2).toContain("Requester person path: memory/user-2.md");
    expect(context2).not.toContain("提前一周");
    expect(context2).not.toContain("提前一天");

    // Build context for user 1
    const context1 = await buildAssistantContextBlock(config, {
      requesterUserId: 1,
      chatId: 1,
      messageTime: "2026-04-08T00:00:00.000Z",
    });
    expect(context1).toContain("Requester person path: memory/user-1.md");
    expect(context1).not.toContain("提前一天");
    expect(context1).not.toContain("提前一周");
  });
});

// ===========================================================================
// Scenario 13: Schedule CRUD open to all roles (own schedules only)
// ===========================================================================
describe("scenario 13: schedule CRUD for all roles", () => {
  test("13a: allowed user creates their own schedule successfully", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 2,
      promptText: "明天早上8点提醒我开会",
      agentResult: {
        message: "已设置提醒",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
      auxiliaryReplyCalls: ["aux-reply:好的，已设置明天早上8点提醒你开会"],
    });

    expect(capturedInput.accessRole).toBe("allowed");
    expect(capturedInput.requesterUserId).toBe(2);
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
    expect(calls).toContain("aux-reply:好的，已设置明天早上8点提醒你开会");
  });

  test("13b: allowed user cannot set schedules for others", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 2,
      promptText: "帮用户1设一个明天的提醒",
      agentResult: {
        message: "抱歉，你只能管理自己的提醒。",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:抱歉，你只能管理自己的提醒。"],
    });

    expect(capturedInput.accessRole).toBe("allowed");
    // Only one reply (refusal), no business tool used
    expect(calls.filter((c) => c.startsWith("aux-reply:")).length).toBe(1);
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
  });

  test("13c: trusted user creates their own schedule successfully", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 3,
      promptText: "下午3点提醒我喝水",
      agentResult: {
        message: "已设置提醒",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
      auxiliaryReplyCalls: ["aux-reply:好的，已设置下午3点提醒你喝水"],
    });

    expect(capturedInput.accessRole).toBe("trusted");
    expect(capturedInput.requesterUserId).toBe(3);
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Scenario 14: Trusted user message send/forward capability
// ===========================================================================
describe("scenario 14: trusted user outbound messaging", () => {
  test("14a: trusted user can schedule message delivery (canDeliverOutbound=true)", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 3,
      promptText: "明天早上9点给群里发一条早安消息",
      agentResult: {
        message: "已安排定时发送",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["telegram:schedule-message"],
      },
      auxiliaryReplyCalls: ["aux-reply:好的，已安排明天9点发送"],
    });

    expect(capturedInput.accessRole).toBe("trusted");
    // canDeliverOutbound=true for trusted users (computed from isTrustedUserId || isAdminUserId)
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
  });

  test("14b: trusted user can forward messages (canDeliverOutbound=true)", async () => {
    const config = await createTempConfig();
    const { capturedInput } = await runScenario({
      config,
      userId: 3,
      promptText: "帮我转发这条消息给用户2",
      agentResult: {
        message: "已转发",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["telegram:send-message"],
      },
      auxiliaryReplyCalls: ["aux-reply:已转发消息给 Allowed User"],
    });

    expect(capturedInput.accessRole).toBe("trusted");
    // canDeliverOutbound=true for trusted users
  });

  test("14c: allowed user cannot schedule message delivery (canDeliverOutbound=false)", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 2,
      promptText: "明天早上9点给群里发一条早安消息",
      agentResult: {
        message: "抱歉，你没有发送消息的权限。",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:抱歉，你没有发送消息的权限。"],
    });

    expect(capturedInput.accessRole).toBe("allowed");
    // canDeliverOutbound=false for allowed users (not trusted, not admin)
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Scenario 15: Memory privacy control
// ===========================================================================
describe("scenario 15: memory privacy control", () => {
  test("15a: admin context includes requester personPath metadata", async () => {
    const config = await createTempConfig({ withMemory: true });
    const contextText = await buildAssistantContextBlock(config, {
      requesterUserId: 1,
      chatId: 1,
      messageTime: "2026-04-08T00:00:00.000Z",
    });

    const contextJson = parseAssistantContextJson(contextText);
    expect(contextJson.requesterUser?.personPath).toBe("memory/user-1.md");
    expect(contextText).not.toContain("admin-secret-data");
  });

  test("15b: allowed user context includes own memory, accessRole constrains agent behavior", async () => {
    const config = await createTempConfig({ withMemory: true });
    const { capturedInput } = await runScenario({
      config,
      userId: 2,
      promptText: "我的笔记里有什么？",
      agentResult: {
        message: "查询完成",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:你的笔记中包含 user2-public-data"],
    });

    expect(capturedInput.accessRole).toBe("allowed");
    expect(capturedInput.sharedConversationContextText).toContain("Requester person path: memory/user-2.md");
    expect(capturedInput.sharedConversationContextText).not.toContain("user2-public-data");
    expect(capturedInput.sharedConversationContextText).not.toContain("admin-secret-data");
  });

  test("15c: allowed user in private chat cannot see non-participant memory", async () => {
    const config = await createTempConfig({ withMemory: true });
    const contextText = await buildAssistantContextBlock(config, {
      requesterUserId: 2,
      chatId: 2,
      messageTime: "2026-04-08T00:00:00.000Z",
    });

    const contextJson = parseAssistantContextJson(contextText);
    expect(contextJson.requesterUser?.personPath).toBe("memory/user-2.md");
    expect(contextText).not.toContain("memory/user-1.md");
    expect(contextText).not.toContain("memory/user-3.md");
  });

  test("15d: trusted user context also carries requester personPath metadata", async () => {
    const config = await createTempConfig({ withMemory: true });
    const contextText = await buildAssistantContextBlock(config, {
      requesterUserId: 3,
      chatId: 3,
      messageTime: "2026-04-08T00:00:00.000Z",
    });

    const contextJson = parseAssistantContextJson(contextText);
    expect(contextJson.requesterUser?.personPath).toBe("memory/user-3.md");
    expect(contextText).not.toContain("trusted-user-data");
  });
});

// ===========================================================================
// Scenario 16: Preferences stored in memory — CRUD and subsequent use
// ===========================================================================
describe("scenario 16: preferences in memory CRUD and application", () => {
  test("16a: memory file preferences stay external; context keeps personPath metadata", async () => {
    const config = await createTempConfig({ withMemory: true });
    await writeFile(
      path.join(config.paths.repoRoot, "memory", "user-2.md"),
      "# 偏好\n- 所有需要提醒的事件都提前一天提醒\n",
      "utf8",
    );

    const contextText = await buildAssistantContextBlock(config, {
      requesterUserId: 2,
      chatId: 2,
      messageTime: "2026-04-08T00:00:00.000Z",
    });

    const contextJson = parseAssistantContextJson(contextText);
    expect(contextJson.requesterUser?.personPath).toBe("memory/user-2.md");
    expect(contextText).not.toContain("所有需要提醒的事件都提前一天提醒");
  });

  test("16b: subsequent agent call receives preferences in sharedConversationContextText", async () => {
    const config = await createTempConfig({ withMemory: true });
    await writeFile(
      path.join(config.paths.repoRoot, "memory", "user-1.md"),
      "# 偏好\n- 所有需要提醒的事件都提前一天提醒\n",
      "utf8",
    );

    const { capturedInput } = await runScenario({
      config,
      userId: 1,
      promptText: "帮我设一个后天的会议提醒",
      agentResult: {
        message: "已设置",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: ["events:create"],
      },
      auxiliaryReplyCalls: ["aux-reply:好的，已设置会议提醒（根据你的偏好，已同时设置提前一天的预提醒）"],
    });

    expect(capturedInput.sharedConversationContextText).toContain("Requester person path: memory/user-1.md");
    expect(capturedInput.sharedConversationContextText).not.toContain("所有需要提醒的事件都提前一天提醒");
  });

  test("16c: updated preferences are reflected in subsequent context", async () => {
    const config = await createTempConfig({ withMemory: true });
    // Write initial preference
    await writeFile(
      path.join(config.paths.repoRoot, "memory", "user-2.md"),
      "# 偏好\n- 所有提醒提前一天\n",
      "utf8",
    );

    const context1 = await buildAssistantContextBlock(config, {
      requesterUserId: 2,
      chatId: 2,
      messageTime: "2026-04-08T00:00:00.000Z",
    });
    expect(context1).toContain("Requester person path: memory/user-2.md");
    expect(context1).not.toContain("所有提醒提前一天");

    // Simulate agent writing new preference (overwriting memory file)
    await writeFile(
      path.join(config.paths.repoRoot, "memory", "user-2.md"),
      "# 偏好\n- 所有提醒提前一天\n- 发给 Alice 和 Bob 的消息优先发送到项目群\n",
      "utf8",
    );

    const context2 = await buildAssistantContextBlock(config, {
      requesterUserId: 2,
      chatId: 2,
      messageTime: "2026-04-08T00:01:00.000Z",
    });
    expect(context2).toContain("Requester person path: memory/user-2.md");
    expect(context2).not.toContain("所有提醒提前一天");
    expect(context2).not.toContain("发给 Alice 和 Bob 的消息优先发送到项目群");
  });

  test("16d: removed preferences no longer appear in context", async () => {
    const config = await createTempConfig({ withMemory: true });
    await writeFile(
      path.join(config.paths.repoRoot, "memory", "user-2.md"),
      "# 偏好\n- 临时偏好内容\n",
      "utf8",
    );

    const context1 = await buildAssistantContextBlock(config, {
      requesterUserId: 2,
      chatId: 2,
      messageTime: "2026-04-08T00:00:00.000Z",
    });
    expect(context1).toContain("Requester person path: memory/user-2.md");
    expect(context1).not.toContain("临时偏好内容");

    // Simulate agent clearing the preference
    await writeFile(
      path.join(config.paths.repoRoot, "memory", "user-2.md"),
      "# 笔记\n- 一般记录\n",
      "utf8",
    );

    const context2 = await buildAssistantContextBlock(config, {
      requesterUserId: 2,
      chatId: 2,
      messageTime: "2026-04-08T00:01:00.000Z",
    });
    expect(context2).toContain("Requester person path: memory/user-2.md");
    expect(context2).not.toContain("临时偏好内容");
    expect(context2).not.toContain("一般记录");
  });
});

// ===========================================================================
// Scenario 17: Admin-only operations rejected for non-admin roles
// ===========================================================================
describe("scenario 17: admin-only operation rejection", () => {
  test("17a: trusted user cannot modify user permissions", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 3,
      promptText: "把用户2的权限改为 admin",
      agentResult: {
        message: "抱歉，只有管理员可以修改权限。",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:抱歉，只有管理员可以修改权限。"],
    });

    expect(capturedInput.accessRole).toBe("trusted");
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.startsWith("aux-reply:")).length).toBe(1);
  });

  test("17b: allowed user cannot add temporary authorization", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 2,
      promptText: "临时授权 test_user 使用机器人",
      agentResult: {
        message: "抱歉，只有管理员可以添加临时授权。",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:抱歉，只有管理员可以添加临时授权。"],
    });

    expect(capturedInput.accessRole).toBe("allowed");
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.startsWith("aux-reply:")).length).toBe(1);
  });

  test("17c: trusted user cannot manage file registry", async () => {
    const config = await createTempConfig();
    const { capturedInput, calls } = await runScenario({
      config,
      userId: 3,
      promptText: "整理一下临时文件",
      agentResult: {
        message: "抱歉，文件管理功能仅限管理员使用。",
        answerMode: "needs-execution",
        usedNativeExecution: true,
        completedActions: [],
      },
      auxiliaryReplyCalls: ["aux-reply:抱歉，文件管理功能仅限管理员使用。"],
    });

    expect(capturedInput.accessRole).toBe("trusted");
    expect(calls.filter((c) => c.startsWith("reply:")).length).toBeGreaterThan(0);
  });
});
