import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/bot/app/config";
import { runRepoTool } from "../src/bot/tools/registry";
import { scheduleTelegramMessage } from "../src/bot/tools/commands/telegram";
import { ToolOutput } from "../src/bot/tools/runtime";

async function createTempRepo() {
  const repoRoot = path.join(os.tmpdir(), `defect-bot-messages-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(repoRoot, { recursive: true });
  await mkdir(path.join(repoRoot, "system"), { recursive: true });
  await mkdir(path.join(repoRoot, "logs"), { recursive: true });
  await mkdir(path.join(repoRoot, "tmp"), { recursive: true });
  await writeFile(path.join(repoRoot, "config.toml"), [
    "[telegram]",
    'bot_token = "test"',
    "admin_user_id = 1",
    'waiting_messages = []',
    "waiting_message_rotation_seconds = 5",
    "input_merge_window_seconds = 0",
    "menu_page_size = 8",
    "",
    "[bot]",
    'persona_style = "test"',
    'language = "zh-CN"',
    'default_timezone = "Asia/Tokyo"',
    "",
    "[maintenance]",
    "enabled = false",
    "idle_after_minutes = 15",
  ].join("\n"));
  await writeFile(path.join(repoRoot, "system/users.json"), JSON.stringify({ users: { "1": { accessLevel: "admin", username: "admin_test", displayName: "Admin Test", timezone: "Asia/Tokyo" }, "200": { accessLevel: "allowed", username: "foo", displayName: "Foo" } } }, null, 2));
  await writeFile(path.join(repoRoot, "system/chats.json"), JSON.stringify({ chats: { "-1003674455331": { id: -1003674455331, type: "group", title: "锅巴之家" } } }, null, 2));
  await writeFile(path.join(repoRoot, "system/state.json"), JSON.stringify({ pendingAuthorizations: [] }, null, 2));
  return repoRoot;
}

async function runTool(repoRoot: string, command: string, args: Record<string, unknown>) {
  return await runRepoTool(command, args, { configPath: path.join(repoRoot, "config.toml") }) as Record<string, unknown>;
}

describe("message delivery flow", () => {
  let repoRoot: string | undefined;
  afterEach(async () => {
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    repoRoot = undefined;
  });

  test("telegram:send-message requires recipientId", async () => {
    repoRoot = await createTempRepo();
    await expect(runTool(repoRoot, "telegram:send-message", { content: "hi" })).resolves.toEqual({ ok: false, error: "missing-recipientId-for-message" });
  });

  test("telegram:send-message still requires outbound privilege for explicit recipientId", async () => {
    repoRoot = await createTempRepo();
    await expect(runTool(repoRoot, "telegram:send-message", { requesterUserId: 200, recipientId: 300, content: "hi" })).resolves.toEqual({ ok: false, error: "outbound-delivery-not-allowed" });
  });

  test("events:create accepts schedule passed as JSON string", async () => {
    repoRoot = await createTempRepo();
    const result = await runTool(repoRoot, "events:create", { requesterUserId: 1, title: "喝鸡汤", schedule: JSON.stringify({ kind: "once", scheduledAt: "2026-04-10T06:00:00.000Z" }) });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
  });

  test("auth:add-pending defaults expiresAt in code", async () => {
    repoRoot = await createTempRepo();
    const startedAt = Date.now();
    const result = await runTool(repoRoot, "auth:add-pending", { requesterUserId: 1, username: "foo", createdBy: 1 });
    expect(result.ok).toBe(true);
    expect(Date.parse(result.expiresAt as string)).toBeGreaterThan(startedAt + 23 * 60 * 60 * 1000);
  });

  test("auth:add-pending accepts durations longer than 24 hours", async () => {
    repoRoot = await createTempRepo();
    const startedAt = Date.now();
    const result = await runTool(repoRoot, "auth:add-pending", { requesterUserId: 1, username: "foo", createdBy: 1, durationMinutes: 7 * 24 * 60 });
    expect(result.ok).toBe(true);
    expect(Date.parse(result.expiresAt as string)).toBeGreaterThan(startedAt + 6 * 24 * 60 * 60 * 1000);
  });

  test("auth:add-pending rejects past or invalid expiresAt", async () => {
    repoRoot = await createTempRepo();
    await expect(runTool(repoRoot, "auth:add-pending", { requesterUserId: 1, username: "foo", createdBy: 1, expiresAt: "2000-01-01T00:00:00.000Z" })).resolves.toEqual({ ok: false, error: "invalid-expiresAt" });
  });

  test("telegram:resolve-recipient resolves remembered chat and user by display name", async () => {
    repoRoot = await createTempRepo();
    await expect(runTool(repoRoot, "telegram:resolve-recipient", { displayName: "锅巴之家" })).resolves.toEqual({ ok: true, status: "resolved", recipientKind: "chat", recipientId: -1003674455331, recipientLabel: "锅巴之家" });
    await expect(runTool(repoRoot, "telegram:resolve-recipient", { displayName: "Admin Test" })).resolves.toEqual({ ok: true, status: "resolved", recipientKind: "user", recipientId: 1, recipientLabel: "Admin Test (@admin_test)" });
  });

  test("users:add-rule and users:set-rules mutate durable user rules", async () => {
    repoRoot = await createTempRepo();
    expect((await runTool(repoRoot, "users:add-rule", { requesterUserId: 1, userId: 200, rule: "总是先确认收件人" })).ok).toBe(true);
    const set = await runTool(repoRoot, "users:set-rules", { requesterUserId: 1, userId: 200, rules: ["A", "B"] });
    expect(set.ok).toBe(true);
    expect((set.user as any).rules).toEqual(["A", "B"]);
  });

  test("users:set-person-path and users:set-timezone update narrow fields", async () => {
    repoRoot = await createTempRepo();
    await mkdir(path.join(repoRoot, "memory/people/yang-fan"), { recursive: true });
    await writeFile(path.join(repoRoot, "memory/people/yang-fan/README.md"), "# Yang Fan\n");
    expect((await runTool(repoRoot, "users:set-person-path", { requesterUserId: 1, userId: 200, personPath: "memory/people/yang-fan/README.md" })).ok).toBe(true);
    const tz = await runTool(repoRoot, "users:set-timezone", { requesterUserId: 1, userId: 200, timezone: "Asia/Tokyo" });
    expect(tz.ok).toBe(true);
    expect((tz.user as any).timezone).toBe("Asia/Tokyo");
  });

  test("users:list and users:get return ok true on success", async () => {
    repoRoot = await createTempRepo();
    expect((await runTool(repoRoot, "users:list", { requesterUserId: 1 })).ok).toBe(true);
    expect((await runTool(repoRoot, "users:get", { requesterUserId: 1, userId: 1 })).ok).toBe(true);
  });

  test("telegram:schedule-message delegates to an external scheduler instead of writing tasks.json", async () => {
    repoRoot = await createTempRepo();
    const config = loadConfig(path.join(repoRoot, "config.toml"));
    const context = {
      config,
      args: {},
      asInt: (value: unknown) => Number(value),
      cleanText: (value: unknown) => typeof value === "string" ? value : undefined,
      output: (value: unknown) => { throw new ToolOutput(value); },
      logTextContent: (text: string) => JSON.stringify(text),
    } as any;

    let output: Record<string, unknown> | undefined;
    try {
      await scheduleTelegramMessage(context, 1, "测试消息", new Date(Date.now() + 60_000).toISOString(), "锅巴之家", 1, () => ({ ok: true, scheduler: "at", handle: "job-123" }));
    } catch (error) {
      if (error instanceof ToolOutput) output = error.value as Record<string, unknown>;
      else throw error;
    }

    expect(output).toMatchObject({ ok: true, scheduled: true, scheduler: "at", handle: "job-123" });
  });
});
