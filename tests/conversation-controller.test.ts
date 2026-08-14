import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { Readable } from "node:stream";
import path from "node:path";
import type { LarkChannel, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { AppConfig } from "../src/bot/app/types";
import { ConversationController } from "../src/bot/runtime/conversations/controller";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function message(id: string, content: string, mentionedBot: boolean): NormalizedMessage { return { messageId: id, chatId: "oc_chat", chatType: "group", senderId: "ou_user", senderName: "用户", content, mentionedBot, mentionAll: false, mentions: [], resources: [], rawContentType: "text", createTime: Date.now() }; }

describe("Feishu conversation controller", () => {
  test("uses recent unaddressed group input and grants the same full mode", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "defect-conversation-")); roots.push(root);
    const config: AppConfig = { feishu: { appId: "cli", appSecret: "secret", inputMergeWindowSeconds: 0, menuPageSize: 8 }, bot: { personaStyle: "", language: "zh-CN", defaultTimezone: "UTC" }, paths: { repoRoot: root, tmpDir: path.join(root, "tmp"), uploadSubdir: "feishu", logFile: path.join(root, "bot.log"), stateFile: path.join(root, "system/state.json") }, maintenance: { enabled: false, idleAfterMs: 0, tmpRetentionDays: 7 } };
    const sent: unknown[] = []; const streamed: string[] = []; let captured: Record<string, unknown> | undefined;
    const channel = {
      addReaction: async () => "reaction",
      removeReaction: async () => undefined,
      recallMessage: async () => undefined,
      send: async (...args: unknown[]) => { sent.push(args); return { messageId: "reply" }; },
      stream: async (...args: any[]) => {
        sent.push(args);
        let content = "思考中…";
        await args[1].markdown({
          messageId: "waiting",
          setContent: async (text: string) => { content = text; streamed.push(content); },
          append: async (text: string) => { content += text; streamed.push(content); },
        });
        return { messageId: "waiting" };
      },
    } as unknown as LarkChannel;
    const agentService = {
      runAssistantTurn: async (input: Record<string, unknown>) => {
        captured = input;
        await (input.onProgress as ((text: string) => Promise<void> | void))("正在调用工具：read");
        await (input.onTextDelta as ((text: string) => Promise<void> | void))("收");
        await (input.onTextDelta as ((text: string) => Promise<void> | void))("到");
        return { message: "收到", usedNativeExecution: false, completedActions: [], files: [], attachments: [] };
      },
      abortCurrentSession: async () => true,
      newSession: async () => "session",
    } as any;
    const controller = new ConversationController({ config, channel, agentService });
    await controller.stash(message("m1", "先看这段上下文", false));
    await controller.handleMessage(message("m2", "请总结", true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(captured?.permissionMode).toBe("full");
    expect(String(captured?.userRequestText)).toContain("先看这段上下文");
    expect(sent).toHaveLength(1);
    expect(streamed).toContain("正在调用工具：read");
    expect(streamed.at(-1)).toBe("收到");
  });

  test("stops a running turn before downloading and processing the latest message", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "defect-latest-message-")); roots.push(root);
    const config: AppConfig = { feishu: { appId: "cli", appSecret: "secret", inputMergeWindowSeconds: 0.01, menuPageSize: 8 }, bot: { personaStyle: "", language: "zh-CN", defaultTimezone: "UTC" }, paths: { repoRoot: root, tmpDir: path.join(root, "tmp"), uploadSubdir: "feishu", logFile: path.join(root, "bot.log"), stateFile: path.join(root, "system/state.json") }, maintenance: { enabled: false, idleAfterMs: 0, tmpRetentionDays: 7 } };
    const order: string[] = [];
    const get = vi.fn(async (payload: { path: { message_id: string; file_key: string } }) => {
      order.push(`download:${payload.path.message_id}`);
      return { getReadableStream: () => Readable.from([Buffer.from(payload.path.file_key)]) };
    });
    let startFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { startFirst = resolve; });
    let finishFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => { finishFirst = resolve; });
    let runCount = 0;
    let latestInput: Record<string, unknown> | undefined;
    const agentService = {
      runAssistantTurn: async (input: Record<string, unknown>) => {
        runCount += 1;
        if (runCount === 1) {
          order.push("run:first");
          startFirst();
          await firstFinished;
          return { message: "旧回复", usedNativeExecution: false, completedActions: [], files: [], attachments: [] };
        }
        order.push("run:latest");
        latestInput = input;
        return { message: "新回复", usedNativeExecution: false, completedActions: [], files: [], attachments: [] };
      },
      abortCurrentSession: async () => { order.push("abort:first"); finishFirst(); return true; },
      newSession: async () => "session",
    } as any;
    const channel = {
      rawClient: { im: { v1: { messageResource: { get } } } },
      addReaction: async () => "reaction",
      removeReaction: async () => undefined,
      recallMessage: async () => undefined,
      send: async () => ({ messageId: "reply" }),
      stream: async (_chatId: string, input: { markdown: (stream: object) => Promise<void> }) => {
        await input.markdown({ messageId: `waiting-${runCount + 1}`, setContent: async () => undefined, append: async () => undefined });
        return { messageId: "waiting" };
      },
    } as unknown as LarkChannel;
    const controller = new ConversationController({ config, channel, agentService });
    const first = { ...message("old", "旧请求", true), rawContentType: "image", resources: [{ type: "image", fileKey: "old-key", fileName: "old.png" }] } satisfies NormalizedMessage;
    const latest = { ...message("latest", "新请求", true), rawContentType: "image", resources: [{ type: "image", fileKey: "latest-key", fileName: "latest.png" }] } satisfies NormalizedMessage;

    await controller.handleMessage(first);
    await firstStarted;
    await controller.handleMessage(latest);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(order.indexOf("abort:first")).toBeLessThan(order.indexOf("download:latest"));
    expect(order).toContain("run:latest");
    expect((latestInput?.attachments as unknown[])).toHaveLength(1);
    expect((latestInput?.uploadedFiles as Array<{ filename: string }>).map((file) => file.filename)).toEqual(["latest-0-latest.png"]);
    expect(String(latestInput?.userRequestText)).not.toContain("旧请求");
  });

  test("keeps each consecutive image bound to its originating Feishu message", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "defect-consecutive-images-")); roots.push(root);
    const config: AppConfig = { feishu: { appId: "cli", appSecret: "secret", inputMergeWindowSeconds: 0.01, menuPageSize: 8 }, bot: { personaStyle: "", language: "zh-CN", defaultTimezone: "UTC" }, paths: { repoRoot: root, tmpDir: path.join(root, "tmp"), uploadSubdir: "feishu", logFile: path.join(root, "bot.log"), stateFile: path.join(root, "system/state.json") }, maintenance: { enabled: false, idleAfterMs: 0, tmpRetentionDays: 7 } };
    const get = vi.fn(async (payload: { path: { message_id: string; file_key: string } }) => ({
      getReadableStream: () => Readable.from([Buffer.from(`${payload.path.message_id}:${payload.path.file_key}`)]),
    }));
    let captured: Record<string, unknown> | undefined;
    const channel = {
      rawClient: { im: { v1: { messageResource: { get } } } },
      addReaction: async () => "reaction",
      removeReaction: async () => undefined,
      recallMessage: async () => undefined,
      send: async () => ({ messageId: "reply" }),
      stream: async (_chatId: string, input: { markdown: (stream: object) => Promise<void> }) => {
        await input.markdown({ messageId: "waiting", setContent: async () => undefined, append: async () => undefined });
        return { messageId: "waiting" };
      },
    } as unknown as LarkChannel;
    const agentService = {
      runAssistantTurn: async (input: Record<string, unknown>) => { captured = input; return { message: "看到了两张图片", usedNativeExecution: true, completedActions: ["read"], files: [], attachments: [] }; },
      abortCurrentSession: async () => true,
      newSession: async () => "session",
    } as any;
    const first = { ...message("img-1", "", true), rawContentType: "image", resources: [{ type: "image", fileKey: "key-1", fileName: "first.png" }] } satisfies NormalizedMessage;
    const second = { ...message("img-2", "", true), rawContentType: "image", resources: [{ type: "image", fileKey: "key-2", fileName: "second.png" }] } satisfies NormalizedMessage;
    const controller = new ConversationController({ config, channel, agentService });

    await controller.handleMessage(first);
    await controller.handleMessage(second);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(get).toHaveBeenNthCalledWith(1, { path: { message_id: "img-1", file_key: "key-1" }, params: { type: "image" } });
    expect(get).toHaveBeenNthCalledWith(2, { path: { message_id: "img-2", file_key: "key-2" }, params: { type: "image" } });
    expect((captured?.attachments as unknown[])).toHaveLength(2);
    expect((captured?.uploadedFiles as Array<{ filename: string }>).map((file) => file.filename)).toEqual([
      "img-1-0-first.png",
      "img-2-0-second.png",
    ]);
  });
});
