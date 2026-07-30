import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { AppConfig } from "../src/bot/app/types";
import { listKnownFeishuChats, listKnownFeishuUsers, rememberFeishuMessage } from "../src/bot/feishu/registry";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function app(root: string): AppConfig { return { feishu: { appId: "cli", appSecret: "secret", inputMergeWindowSeconds: 0, menuPageSize: 8 }, bot: { personaStyle: "", language: "zh-CN", defaultTimezone: "Asia/Shanghai" }, paths: { repoRoot: root, tmpDir: path.join(root, "tmp"), uploadSubdir: "feishu", logFile: path.join(root, "logs/bot.log"), stateFile: path.join(root, "system/state.json") }, maintenance: { enabled: false, idleAfterMs: 0, tmpRetentionDays: 7 } }; }

describe("Feishu entity registry", () => {
  test("persists string open IDs and chat IDs without role fields", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "defect-registry-")); roots.push(root);
    const config = app(root);
    const message = { messageId: "om_1", chatId: "oc_1", chatType: "group", senderId: "ou_1", senderName: "小明", content: "hi", resources: [], mentions: [], mentionAll: false, mentionedBot: true, rawContentType: "text", createTime: Date.now() } satisfies NormalizedMessage;
    rememberFeishuMessage(config, message, "研发群", "topic");
    expect(listKnownFeishuUsers(config)[0]).toMatchObject({ id: "ou_1", displayName: "小明" });
    expect(listKnownFeishuChats(config)[0]).toMatchObject({ id: "oc_1", title: "研发群", type: "topic" });
    const users = readFileSync(path.join(root, "system/users.json"), "utf8");
    expect(users).not.toMatch(/role|access/i);
  });
});
