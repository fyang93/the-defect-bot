import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildProjectSystemPrompt } from "../src/bot/ai/prompt";
import { loadConfig } from "../src/bot/app/config";

describe("role prompts stay aligned with current routing design", () => {
  test("assistant prompt stays narrow", () => {
    const assistant = buildProjectSystemPrompt("简洁", "assistant");

    expect(assistant).toContain("Follow the Defect Bot assistant instructions loaded from AGENTS.md.");
    expect(assistant).toContain("Do the work, then return one user-visible reply.");
    expect(assistant.length).toBeLessThan(400);
  });
});


test("config accepts legacy waiting_messages rotation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "defect-config-"));
  const configPath = path.join(dir, "config.toml");
  await writeFile(configPath, `
[telegram]
bot_token = "token"
admin_user_id = 1
waiting_messages = ["机宝启动中", "机宝启动中..."]
waiting_message_rotation_seconds = 1

[bot]
default_timezone = "Asia/Tokyo"
`, "utf8");

  const config = loadConfig(configPath);
  expect(config.telegram.waitingMessage).toBe("机宝启动中");
  expect(config.telegram.waitingMessages).toEqual(["机宝启动中", "机宝启动中..."]);
  expect(config.telegram.waitingMessageRotationSeconds).toBe(1);
});
