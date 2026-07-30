import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
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
    const sent: unknown[] = []; let captured: Record<string, unknown> | undefined;
    const channel = { addReaction: async () => "reaction", removeReaction: async () => undefined, send: async (...args: unknown[]) => { sent.push(args); return { messageId: "reply" }; } } as unknown as LarkChannel;
    const agentService = {
      runAssistantTurn: async (input: Record<string, unknown>) => { captured = input; return { message: "收到", usedNativeExecution: false, completedActions: [], files: [], attachments: [] }; },
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
  });
});
