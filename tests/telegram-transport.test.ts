import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/bot/app/types";
import { saveTelegramFileFromMessage } from "../src/bot/telegram/transport";

function createTestConfig(repoRoot: string): AppConfig {
  return {
    telegram: {
      botToken: "test-token",
      adminUserId: 1,
      waitingMessages: [],
      waitingMessageRotationSeconds: 5,
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

describe("telegram file persistence", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("preserves CJK document filenames with only conservative sanitization", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-transport-"));
    try {
      await mkdir(path.join(repoRoot, "tmp"), { recursive: true });
      const config = createTestConfig(repoRoot);
      globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch;

      const uploaded = await saveTelegramFileFromMessage({
        api: {
          getFile: async () => ({ file_path: "docs/file.xlsx" }),
        },
      } as any, config, {
        document: {
          file_id: "f1",
          file_unique_id: "u1",
          file_name: "研究業務日誌（2026.4）.xlsx",
          mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      });

      expect(uploaded).not.toBeNull();
      expect(uploaded?.originalName).toBe("研究業務日誌（2026.4）.xlsx");
      expect(uploaded?.filename).toBe("研究業務日誌（2026.4）.xlsx");
      expect(uploaded?.savedPath).toContain("研究業務日誌（2026.4）.xlsx");
      await access(uploaded!.absolutePath);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("strips path separators but keeps Unicode meaning", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-transport-"));
    try {
      await mkdir(path.join(repoRoot, "tmp"), { recursive: true });
      const config = createTestConfig(repoRoot);
      globalThis.fetch = (async () => new Response(new Uint8Array([4, 5, 6]), { status: 200 })) as typeof fetch;

      const uploaded = await saveTelegramFileFromMessage({
        api: {
          getFile: async () => ({ file_path: "docs/file.xlsx" }),
        },
      } as any, config, {
        document: {
          file_id: "f2",
          file_unique_id: "u2",
          file_name: "foo\\研究業務日誌/2026年4月.xlsx",
          mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      });

      expect(uploaded).not.toBeNull();
      expect(uploaded?.originalName).toBe("2026年4月.xlsx");
      expect(uploaded?.filename).toBe("2026年4月.xlsx");
      expect(uploaded?.savedPath).toContain("2026年4月.xlsx");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("retries transient Telegram file download fetch failures", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-transport-"));
    try {
      await mkdir(path.join(repoRoot, "tmp"), { recursive: true });
      const config = createTestConfig(repoRoot);
      let fetchCount = 0;
      globalThis.fetch = (async () => {
        fetchCount += 1;
        if (fetchCount === 1) throw new Error("fetch failed");
        return new Response(new Uint8Array([7, 8, 9]), { status: 200 });
      }) as typeof fetch;

      const uploaded = await saveTelegramFileFromMessage({
        api: {
          getFile: async () => ({ file_path: "docs/retry.txt" }),
        },
      } as any, config, {
        document: {
          file_id: "retry",
          file_unique_id: "retry-u",
          file_name: "retry.txt",
          mime_type: "text/plain",
        },
      });

      expect(fetchCount).toBe(2);
      expect(Array.from(new Uint8Array(await readFile(uploaded!.absolutePath)))).toEqual([7, 8, 9]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("same-name uploads overwrite the previous saved file instead of creating suffixed copies", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-transport-"));
    try {
      await mkdir(path.join(repoRoot, "tmp"), { recursive: true });
      const config = createTestConfig(repoRoot);
      let downloadCount = 0;
      globalThis.fetch = (async () => new Response(new Uint8Array(downloadCount++ === 0 ? [1, 2, 3] : [9, 8, 7]), { status: 200 })) as typeof fetch;

      const first = await saveTelegramFileFromMessage({
        api: {
          getFile: async () => ({ file_path: "docs/file.xlsx" }),
        },
      } as any, config, {
        document: {
          file_id: "f3",
          file_unique_id: "u3",
          file_name: "周报.xlsx",
          mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      });

      const second = await saveTelegramFileFromMessage({
        api: {
          getFile: async () => ({ file_path: "docs/file.xlsx" }),
        },
      } as any, config, {
        document: {
          file_id: "f4",
          file_unique_id: "u4",
          file_name: "周报.xlsx",
          mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      });

      expect(first?.filename).toBe("周报.xlsx");
      expect(second?.filename).toBe("周报.xlsx");
      expect(first?.absolutePath).toBe(second?.absolutePath);
      expect(second?.savedPath.endsWith("周报.xlsx")).toBe(true);
      expect(path.basename(second?.savedPath || "").includes("-1")).toBe(false);
      expect(Array.from(new Uint8Array(await readFile(second!.absolutePath)))).toEqual([9, 8, 7]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
