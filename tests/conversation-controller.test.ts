import { describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import type { AppConfig, AiAttachment, UploadedFile } from "../src/bot/app/types";
import { ConversationController } from "../src/bot/runtime/conversations/controller";

function createConfig(overrides: Partial<AppConfig["telegram"]> = {}): AppConfig {
  return {
    telegram: {
      botToken: "test",
      adminUserId: 1,
      waitingMessages: [],
      waitingMessageRotationSeconds: 5,
      inputMergeWindowSeconds: 3,
      menuPageSize: 8,
      ...overrides,
    },
    bot: {
      personaStyle: "",
      language: "zh-CN",
      defaultTimezone: "Asia/Tokyo",
    },
    paths: {
      repoRoot: process.cwd(),
      tmpDir: `${process.cwd()}/tmp`,
      uploadSubdir: "telegram",
      logFile: `${process.cwd()}/logs/bot.log`,
      stateFile: `${process.cwd()}/system/state.json`,
    },
    maintenance: {
      enabled: false,
      idleAfterMs: 0,
      tmpRetentionDays: 1,
    },
  };
}

function createController(config = createConfig()) {
  return new ConversationController({
    config,
    bot: {
      api: {
        deleteMessage: async () => {},
      },
    } as any,
    agentService: {
      abortCurrentSession: async () => {},
      runAssistantTurn: async () => ({
        message: "",
        files: [],
        attachments: [],
        completedActions: [],
        usedNativeExecution: true,
      }),
    } as any,
    isTrustedUserId: () => true,
    isAdminUserId: () => true,
    isAddressedToBot: () => true,
  });
}

function createCtx(messageId: number, userId = 1): Context {
  return {
    chat: { id: 1, type: "private" },
    from: { id: userId },
    message: { message_id: messageId, date: 1 },
  } as any;
}

function createUploadedFile(name: string): UploadedFile {
  return {
    savedPath: `tmp/telegram/${name}`,
    absolutePath: `/tmp/${name}`,
    originalName: name,
    filename: name,
    mimeType: "image/jpeg",
    sizeBytes: 1234,
    source: "photo",
  };
}

function createAttachment(name: string): AiAttachment {
  return {
    mimeType: "image/jpeg",
    filename: name,
    url: `file:///tmp/${name}`,
  };
}

describe("conversation controller input merge window", () => {
  test("merges follow-up text into the active in-flight turn", async () => {
    const controller = createController() as any;
    const starts: Array<{ promptText: string; uploadedFiles: UploadedFile[]; attachments: AiAttachment[]; messageTime?: string }> = [];
    const interrupts: string[] = [];

    controller.startConversationTask = (_ctx: Context, _waitingTemplate: string, promptText: string, uploadedFiles: UploadedFile[], attachments: AiAttachment[], messageTime?: string) => {
      starts.push({ promptText, uploadedFiles, attachments, messageTime });
    };
    controller.interruptActiveTask = async (reason: string, scopeKey?: string) => {
      interrupts.push(`${scopeKey}:${reason}`);
      controller.turns.delete(scopeKey);
      controller.activeTasks.get = () => undefined;
    };
    controller.activeTasks.get = () => ({ id: 7, cancelled: false, userId: 1 });
    controller.turns.set("user:1", {
      taskId: 7,
      phase: "running",
      userId: 1,
      scopeKey: "user:1",
      scopeLabel: "user 1",
      ctx: createCtx(10),
      input: {
        waitingTemplate: "",
        promptText: "Current user message:\n帮我评价一下",
        uploadedFiles: [],
        attachments: [],
        messageTime: "2026-04-06T00:00:00.000Z",
      },
      openedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const restarted = await controller.restartActiveConversationIfMergeable(createCtx(11), { key: "user:1", label: "user 1" }, {
      promptText: "重点看最后一段",
      messageTime: "2026-04-06T00:00:01.000Z",
    }, Date.now());

    expect(restarted).toBe(true);
    expect(interrupts).toEqual(["user:1:merged follow-up input 11"]);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.promptText).toContain("帮我评价一下");
    expect(starts[0]?.promptText).toContain("Follow-up user message in the same turn:\n重点看最后一段");
  });

  test("merges a late file into the active in-flight turn", async () => {
    const controller = createController() as any;
    const starts: Array<{ promptText: string; uploadedFiles: UploadedFile[]; attachments: AiAttachment[] }> = [];

    const uploaded = createUploadedFile("late.jpg");
    const attachment = createAttachment("late.jpg");

    controller.startConversationTask = (_ctx: Context, _waitingTemplate: string, promptText: string, uploadedFiles: UploadedFile[], attachments: AiAttachment[]) => {
      starts.push({ promptText, uploadedFiles, attachments });
    };
    controller.interruptActiveTask = async () => {
      controller.turns.clear();
      controller.activeTasks.get = () => undefined;
    };
    controller.activeTasks.get = () => ({ id: 8, cancelled: false, userId: 1 });
    controller.turns.set("user:1", {
      taskId: 8,
      phase: "running",
      userId: 1,
      scopeKey: "user:1",
      scopeLabel: "user 1",
      ctx: createCtx(10),
      input: {
        waitingTemplate: "",
        promptText: "Current user message:\n怎么评价",
        uploadedFiles: [],
        attachments: [],
        messageTime: "2026-04-06T00:00:00.000Z",
      },
      openedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const restarted = await controller.restartActiveConversationIfMergeable(createCtx(12), { key: "user:1", label: "user 1" }, {
      uploadedFiles: [uploaded],
      attachments: [attachment],
      messageTime: "2026-04-06T00:00:01.000Z",
    }, Date.now());

    expect(restarted).toBe(true);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.promptText).toBe("Current user message:\n怎么评价");
    expect(starts[0]?.uploadedFiles).toEqual([uploaded]);
    expect(starts[0]?.attachments).toEqual([attachment]);
  });

  test("merges follow-up input into a pending turn before runtime startup finishes", async () => {
    const controller = createController() as any;
    const starts: unknown[] = [];
    const uploaded = createUploadedFile("pending.jpg");
    const attachment = createAttachment("pending.jpg");
    const now = Date.now();

    controller.startConversationTask = () => {
      starts.push(true);
    };
    controller.interruptActiveTask = async () => {};
    controller.turns.set("user:1", {
      taskId: 21,
      phase: "collecting",
      userId: 1,
      scopeKey: "user:1",
      scopeLabel: "user 1",
      ctx: createCtx(17),
      input: {
        waitingTemplate: "",
        promptText: "Current user message:\n怎么评价",
        uploadedFiles: [],
        attachments: [],
        messageTime: "2026-04-06T00:00:00.000Z",
      },
      openedAt: now,
      updatedAt: now,
    });

    const restarted = await controller.restartActiveConversationIfMergeable(createCtx(18), { key: "user:1", label: "user 1" }, {
      uploadedFiles: [uploaded],
      attachments: [attachment],
      messageTime: "2026-04-06T00:00:01.000Z",
    }, now + 300);

    expect(restarted).toBe(true);
    expect(starts).toHaveLength(0);
    expect(controller.turns.get("user:1")).toMatchObject({
      taskId: 21,
      phase: "collecting",
      input: {
        promptText: "Current user message:\n怎么评价",
        uploadedFiles: [uploaded],
        attachments: [attachment],
        messageTime: "2026-04-06T00:00:01.000Z",
      },
    });
  });

  test("does not merge after the input window expires", async () => {
    const controller = createController() as any;
    const starts: unknown[] = [];
    const now = Date.now();

    controller.startConversationTask = () => {
      starts.push(true);
    };
    controller.interruptActiveTask = async () => {};
    controller.activeTasks.get = () => ({ id: 9, cancelled: false, userId: 1 });
    controller.turns.set("user:1", {
      taskId: 9,
      phase: "running",
      userId: 1,
      scopeKey: "user:1",
      scopeLabel: "user 1",
      ctx: createCtx(12),
      input: {
        waitingTemplate: "",
        promptText: "Current user message:\n第一句",
        uploadedFiles: [],
        attachments: [],
        messageTime: "2026-04-06T00:00:00.000Z",
      },
      openedAt: now,
      updatedAt: now - 4000,
    });

    const restarted = await controller.restartActiveConversationIfMergeable(createCtx(13), { key: "user:1", label: "user 1" }, {
      promptText: "第二句",
      messageTime: "2026-04-06T00:00:04.000Z",
    }, now);

    expect(restarted).toBe(false);
    expect(starts).toHaveLength(0);
  });

  test("merges three consecutive messages within the window", async () => {
    const controller = createController() as any;
    const starts: Array<{ promptText: string }> = [];
    let mergeCount = 0;

    controller.startConversationTask = (_ctx: Context, _waitingTemplate: string, promptText: string) => {
      starts.push({ promptText });
    };
    controller.interruptActiveTask = async (reason: string, scopeKey?: string) => {
      mergeCount += 1;
      // After interrupt, simulate the new startConversationTask creating a new active input
      controller.turns.delete(scopeKey);
      controller.activeTasks.get = () => undefined;
    };

    // First message already active
    controller.activeTasks.get = () => ({ id: 10, cancelled: false, userId: 1 });
    controller.turns.set("user:1", {
      taskId: 10,
      phase: "running",
      userId: 1,
      scopeKey: "user:1",
      scopeLabel: "user 1",
      ctx: createCtx(13),
      input: {
        waitingTemplate: "",
        promptText: "Current user message:\n第一条消息",
        uploadedFiles: [],
        attachments: [],
        messageTime: "2026-04-06T00:00:00.000Z",
      },
      openedAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Second message merges
    const restarted1 = await controller.restartActiveConversationIfMergeable(createCtx(14), { key: "user:1", label: "user 1" }, {
      promptText: "第二条消息",
    }, Date.now());
    expect(restarted1).toBe(true);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.promptText).toContain("第一条消息");
    expect(starts[0]?.promptText).toContain("Follow-up user message in the same turn:\n第二条消息");

    // Simulate the restarted task creating a new active input with merged text
    controller.activeTasks.get = () => ({ id: 11, cancelled: false, userId: 1 });
    controller.turns.set("user:1", {
      taskId: 11,
      phase: "running",
      userId: 1,
      scopeKey: "user:1",
      scopeLabel: "user 1",
      ctx: createCtx(14),
      input: {
        waitingTemplate: "",
        promptText: starts[0]!.promptText,
        uploadedFiles: [],
        attachments: [],
        messageTime: "2026-04-06T00:00:01.000Z",
      },
      openedAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Third message merges again
    const restarted2 = await controller.restartActiveConversationIfMergeable(createCtx(15), { key: "user:1", label: "user 1" }, {
      promptText: "第三条消息",
    }, Date.now());
    expect(restarted2).toBe(true);
    expect(starts).toHaveLength(2);
    expect(starts[1]?.promptText).toContain("第一条消息");
    expect(starts[1]?.promptText).toContain("第二条消息");
    expect(starts[1]?.promptText).toContain("Follow-up user message in the same turn:\n第三条消息");
  });

  test("does not merge messages from a different user", async () => {
    const controller = createController() as any;
    const starts: unknown[] = [];

    controller.startConversationTask = () => {
      starts.push(true);
    };
    controller.interruptActiveTask = async () => {};
    // Active input belongs to user 1
    controller.activeTasks.get = () => ({ id: 12, cancelled: false, userId: 1 });
    controller.turns.set("user:1", {
      taskId: 12,
      phase: "running",
      userId: 1,
      scopeKey: "user:1",
      scopeLabel: "user 1",
      ctx: createCtx(15),
      input: {
        waitingTemplate: "",
        promptText: "Current user message:\n用户1的消息",
        uploadedFiles: [],
        attachments: [],
        messageTime: "2026-04-06T00:00:00.000Z",
      },
      openedAt: Date.now(),
      updatedAt: Date.now(),
    });

    // User 2 tries to merge within the window — should fail because userId differs
    const restarted = await controller.restartActiveConversationIfMergeable(createCtx(16, 2), { key: "user:1", label: "user 1" }, {
      promptText: "用户2的消息",
    }, Date.now());

    expect(restarted).toBe(false);
    expect(starts).toHaveLength(0);
  });

  test("uses handler-entry time for collecting merge instead of post-ingest completion time", async () => {
    const controller = createController() as any;
    const now = Date.now();

    controller.turns.set("user:1", {
      taskId: 31,
      phase: "collecting",
      userId: 1,
      scopeKey: "user:1",
      scopeLabel: "user 1",
      ctx: createCtx(30),
      input: {
        waitingTemplate: "",
        promptText: "Current user message:\n评价一下",
        uploadedFiles: [],
        attachments: [],
        messageTime: "2026-04-06T00:00:00.000Z",
      },
      openedAt: now,
      updatedAt: now,
    });

    const uploaded = createUploadedFile("after-ingest.jpg");
    const attachment = createAttachment("after-ingest.jpg");
    const restarted = await controller.restartActiveConversationIfMergeable(createCtx(31), { key: "user:1", label: "user 1" }, {
      uploadedFiles: [uploaded],
      attachments: [attachment],
      messageTime: "2026-04-06T00:00:01.000Z",
    }, now + 260);

    expect(restarted).toBe(true);
    expect(controller.turns.get("user:1")?.input.uploadedFiles).toEqual([uploaded]);
    expect(controller.turns.get("user:1")?.input.attachments).toEqual([attachment]);
  });

  test("continues the assistant turn when the waiting message send fails", async () => {
    const controller = createController(createConfig({ waitingMessages: ["processing"], inputMergeWindowSeconds: 0 })) as any;
    const ctx = {
      ...createCtx(41),
      reply: async () => {
        throw new Error("Network request for 'sendMessage' failed!");
      },
      api: {
        deleteMessage: async () => {},
      },
    } as any;

    await expect(controller.beginConversationTurn(ctx, "", "Current user message:\nhi", [], [], "2026-06-05T00:00:00.000Z")).resolves.toBeUndefined();
    expect(controller.turns.get("user:1")).toBeUndefined();
  });


  test("rotates multiple waiting messages in order", async () => {
    const edits: string[] = [];
    const controller = new ConversationController({
      config: createConfig({ waitingMessages: ["one", "two", "three"], waitingMessageRotationSeconds: 0.01, inputMergeWindowSeconds: 0 }),
      bot: {
        api: {
          deleteMessage: async () => {},
        },
      } as any,
      agentService: {
        abortCurrentSession: async () => {},
        runAssistantTurn: async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return { message: "", files: [], attachments: [], completedActions: [], usedNativeExecution: true };
        },
      } as any,
      isTrustedUserId: () => true,
      isAdminUserId: () => true,
      isAddressedToBot: () => true,
    } as any) as any;
    const ctx = {
      ...createCtx(42),
      reply: async (text: string) => {
        edits.push(text);
        return { message_id: 99 };
      },
      api: {
        editMessageText: async (_chatId: number, _messageId: number, text: string) => {
          edits.push(text);
        },
        deleteMessage: async () => {},
      },
    } as any;

    await controller.beginConversationTurn(ctx, "", "Current user message:\nhi", [], [], "2026-06-05T00:00:00.000Z");

    expect(edits.slice(0, 3)).toEqual(["one", "two", "three"]);
  });

  test("does not merge when active task is cancelled", async () => {
    const controller = createController() as any;
    const starts: unknown[] = [];

    controller.startConversationTask = () => {
      starts.push(true);
    };
    controller.interruptActiveTask = async () => {};
    // Active task is cancelled
    controller.activeTasks.get = () => ({ id: 13, cancelled: true, userId: 1 });
    controller.turns.set("user:1", {
      taskId: 13,
      phase: "running",
      userId: 1,
      scopeKey: "user:1",
      scopeLabel: "user 1",
      ctx: createCtx(16),
      input: {
        waitingTemplate: "",
        promptText: "Current user message:\n原始消息",
        uploadedFiles: [],
        attachments: [],
        messageTime: "2026-04-06T00:00:00.000Z",
      },
      openedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const restarted = await controller.restartActiveConversationIfMergeable(createCtx(17), { key: "user:1", label: "user 1" }, {
      promptText: "后续消息",
    }, Date.now());

    expect(restarted).toBe(false);
    expect(starts).toHaveLength(0);
  });
});
