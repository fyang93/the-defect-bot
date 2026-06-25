import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/bot/app/types";
import { extractCandidateFilePaths } from "../src/bot/telegram/transport";
import { deliverAiOutputs } from "../src/bot/runtime/conversations/output";
import { sendTelegramLocalFile } from "../src/bot/telegram/delivery";

function createTestConfig(repoRoot: string): AppConfig {
  return {
    telegram: {
      botToken: "test",
      adminUserId: 1,
      waitingMessage: "",
      inputMergeWindowSeconds: 3,
      menuPageSize: 8,
    },
    bot: {
      personaStyle: "",
      language: "zh-CN",
      defaultTimezone: "Asia/Tokyo",
    },
    paths: {
      repoRoot,
      tmpDir: path.join(repoRoot, "tmp"),
      uploadSubdir: "telegram",
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

describe("telegram current-turn output", () => {
  test("extractCandidateFilePaths resolves markdown relative memory links", () => {
    expect(extractCandidateFilePaths("照片在这里：[锅巴照片](../memory/shared/households/yang-fan-family/guoba.jpg)")).toEqual(["memory/shared/households/yang-fan-family/guoba.jpg"]);
  });

  test("deliverAiOutputs does not auto-send files merely because the reply text mentions a markdown path", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-output-test-"));
    try {
      await mkdir(path.join(repoRoot, "memory", "shared", "households", "yang-fan-family"), { recursive: true });
      await writeFile(path.join(repoRoot, "memory", "shared", "households", "yang-fan-family", "guoba.jpg"), "fake-jpg", "utf8");
      const config = createTestConfig(repoRoot);
      const calls: string[] = [];
      const ctx = {
        chat: { id: 42, type: "private" },
        from: { id: 1 },
        api: {
          sendPhoto: async (chatId: number) => {
            calls.push(`sendPhoto:${chatId}`);
            return { message_id: 99 };
          },
          sendVoice: async () => {
            calls.push("sendVoice");
            return { message_id: 1 };
          },
          sendVideo: async () => {
            calls.push("sendVideo");
            return { message_id: 1 };
          },
          sendAudio: async () => {
            calls.push("sendAudio");
            return { message_id: 1 };
          },
          sendDocument: async () => {
            calls.push("sendDocument");
            return { message_id: 1 };
          },
        },
        reply: async (text: string) => {
          calls.push(`reply:${text}`);
          return { message_id: 100 };
        },
      } as any;

      await deliverAiOutputs(ctx, config, {
        message: "我已经更新好了，内容存放在 [memory/shared/households/yang-fan-family/guoba.jpg](../memory/shared/households/yang-fan-family/guoba.jpg)。",
        files: [],
        attachments: [],
      });

      expect(calls).not.toContain("sendPhoto:42");
      expect(calls.some((entry) => entry.startsWith("reply:"))).toBe(false);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("sendTelegramLocalFile quotes multipart filenames so Telegram preserves parentheses", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-output-test-filename-"));
    try {
      const filePath = path.join(repoRoot, "YANG_FAN_研究業務日誌（2026.5）.xlsx");
      await writeFile(filePath, "fake-xlsx", "utf8");
      let seenFilename = "";
      const api = {
        sendPhoto: async () => ({ message_id: 1 }),
        sendVoice: async () => ({ message_id: 1 }),
        sendVideo: async () => ({ message_id: 1 }),
        sendAudio: async () => ({ message_id: 1 }),
        sendDocument: async (_chatId: number, document: any) => {
          seenFilename = String(document.filename || "");
          return { message_id: 1 };
        },
      };

      await sendTelegramLocalFile(api, 42, filePath, { filename: path.basename(filePath) });

      expect(seenFilename).toBe('"YANG_FAN_研究業務日誌（2026.5）.xlsx"');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("deliverAiOutputs sends files only when answer.files explicitly requests publication", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-output-test-explicit-"));
    try {
      await mkdir(path.join(repoRoot, "memory", "shared", "households", "yang-fan-family"), { recursive: true });
      await writeFile(path.join(repoRoot, "memory", "shared", "households", "yang-fan-family", "guoba.jpg"), "fake-jpg", "utf8");
      const config = createTestConfig(repoRoot);
      const calls: string[] = [];
      const ctx = {
        chat: { id: 42, type: "private" },
        from: { id: 1 },
        api: {
          sendPhoto: async (chatId: number) => {
            calls.push(`sendPhoto:${chatId}`);
            return { message_id: 99 };
          },
          sendVoice: async () => ({ message_id: 1 }),
          sendVideo: async () => ({ message_id: 1 }),
          sendAudio: async () => ({ message_id: 1 }),
          sendDocument: async () => ({ message_id: 1 }),
        },
      } as any;

      await deliverAiOutputs(ctx, config, {
        message: "这是你要的文件。",
        files: ["memory/shared/households/yang-fan-family/guoba.jpg"],
        attachments: [],
      });

      expect(calls).toContain("sendPhoto:42");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
