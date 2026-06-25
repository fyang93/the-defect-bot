import { describe, expect, test } from "vitest";
import { executeAssistantActions } from "../src/bot/runtime/assistant-actions";
import type { AppConfig } from "../src/bot/app/types";

function config(): AppConfig {
  return {
    telegram: { botToken: "test", adminUserId: 1, waitingMessage: "", inputMergeWindowSeconds: 3, menuPageSize: 10 },
    bot: { personaStyle: "", language: "zh-CN", defaultTimezone: "Asia/Tokyo" },
    paths: { repoRoot: process.cwd(), tmpDir: "tmp", uploadSubdir: "uploads", logFile: "logs/bot.log", stateFile: "system/state.json" },
    maintenance: { enabled: false, idleAfterMs: 0, tmpRetentionDays: 1 },
  };
}

describe("assistant action execution", () => {
  test("retries outbound delivery requests when the model answers without tools", async () => {
    const prompts: string[] = [];
    const agentService = {
      runAssistantTurn: async ({ userRequestText }: { userRequestText: string }) => {
        prompts.push(userRequestText);
        return prompts.length === 1
          ? { message: "嗡…李博你好。", facts: [], files: [], attachments: [], completedActions: [], usedNativeExecution: false }
          : { message: "已发送。", facts: [], files: [], attachments: [], completedActions: ["telegram_send_message"], usedNativeExecution: true };
      },
    };

    const result = await executeAssistantActions({
      config: config(),
      agentService: agentService as any,
      ctx: { chat: { id: 1, type: "private" } } as any,
      requesterUserId: 1,
      uploadedFiles: [],
      attachments: [],
      requesterTimezone: "Asia/Tokyo",
      canDeliverOutbound: true,
      accessRole: "admin",
      userRequestText: "用你的身份给李博打个招呼",
      sharedConversationContextText: "",
      scopeKey: "user:1",
      scopeLabel: "user 1",
      isTaskCurrent: () => true,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("outbound Telegram delivery request");
    expect(result.completedActions).toEqual(["telegram_send_message"]);
  });
});
