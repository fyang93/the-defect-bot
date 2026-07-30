import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig, AiAttachment } from "../src/bot/app/types";
import { configureLogger } from "../src/bot/app/logger";
import { StructuredReasoner } from "../src/bot/ai/structured-reasoner";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function config(root: string): AppConfig {
  return {
    feishu: { appId: "cli", appSecret: "secret", inputMergeWindowSeconds: 0, menuPageSize: 8 },
    bot: { personaStyle: "", language: "zh-CN", defaultTimezone: "UTC" },
    paths: { repoRoot: root, tmpDir: path.join(root, "tmp"), uploadSubdir: "feishu", logFile: path.join(root, "bot.log"), stateFile: path.join(root, "system/state.json") },
    maintenance: { enabled: false, idleAfterMs: 0, tmpRetentionDays: 7 },
  };
}

describe("StructuredReasoner attachments", () => {
  test("forwards native image attachments to the Pi prompt", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "defect-reasoner-"));
    roots.push(root);
    const app = config(root);
    await configureLogger(app.paths.logFile);
    const image: AiAttachment = { mimeType: "image/png", filename: "chart.png", url: "data:image/png;base64,AQID" };
    const executePrompt = vi.fn(async () => ({ message: "ok", files: [], attachments: [] }));
    const reasoner = new StructuredReasoner(app, executePrompt, () => []);

    await reasoner.run("分析图片", [], [image], undefined, "full", "chat:oc_chat");

    expect(executePrompt).toHaveBeenCalledOnce();
    expect(executePrompt.mock.calls[0][1]).toEqual([image]);
    expect(executePrompt.mock.calls[0][2]).toBe("chat:oc_chat");
  });
});
