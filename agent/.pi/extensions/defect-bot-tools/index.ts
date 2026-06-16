import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

function repoRootFromCwd(cwd = process.cwd()): string {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "src", "cli.ts"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

type CliSpec = { command: string; payload?: Record<string, unknown> };

type SpawnResult = { code: number | null; stdout: string; stderr: string };

function spawnCollect(command: string, args: string[], options: { cwd: string; signal?: AbortSignal }): Promise<SpawnResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, signal: options.signal });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function runRepoCli(spec: CliSpec, signal?: AbortSignal): Promise<unknown> {
  const root = repoRootFromCwd();
  const payload = spec.payload ?? {};
  const result = await spawnCollect("bun", ["run", "repo:cli", "--", spec.command, JSON.stringify(payload)], { cwd: root, signal });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `repo:cli ${spec.command} exited with ${result.code}`;
    throw new Error(message);
  }
  const stdout = result.stdout.trim();
  try {
    return stdout ? JSON.parse(stdout) : { ok: true };
  } catch {
    return { ok: true, text: stdout };
  }
}

function cliToolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

const payload = Type.Optional(Type.Record(Type.String(), Type.Any(), {
  description: "Exact JSON payload accepted by the repository CLI command. Include requesterUserId when permission checks matter.",
}));

const defectEvents = defineTool({
  name: "defect_events",
  label: "Defect Events",
  description:
    "Deterministically create, list, inspect, update, pause, resume, or delete reminder/event/automation state through the repository CLI. Use for reminders, dated events, recurring schedules, automations, and pause/resume/delete. For new events, clarify only when a required field is truly missing; interpret relative times in requester-local timezone; use category=automation for recurring generated content; do not claim success unless this tool succeeds.",
  parameters: Type.Object({
    command: Type.Union([
      Type.Literal("events:list"),
      Type.Literal("events:get"),
      Type.Literal("events:create"),
      Type.Literal("events:update"),
      Type.Literal("events:delete"),
      Type.Literal("events:pause"),
      Type.Literal("events:resume"),
    ], { default: "events:list" }),
    payload,
  }),
  async execute(_toolCallId, params, signal) {
    return cliToolResult(await runRepoCli(params, signal));
  },
});

const defectUsers = defineTool({
  name: "defect_users",
  label: "Defect Users/Auth/Rules",
  description:
    "Deterministically inspect or change repository user/access state, person-path identity links, pending authorization, user timezone, and durable per-user assistant rules. Use users:list/get before ambiguous mutations. Only admins may change access or pending auth. Use users:add-rule for one future-facing rule and users:set-rules only for explicit full replacement. Do not use for ordinary memory facts.",
  parameters: Type.Object({
    command: Type.Union([
      Type.Literal("users:list"),
      Type.Literal("users:get"),
      Type.Literal("users:set-access"),
      Type.Literal("users:set-timezone"),
      Type.Literal("users:set-person-path"),
      Type.Literal("users:add-rule"),
      Type.Literal("users:set-rules"),
      Type.Literal("auth:add-pending"),
    ], { default: "users:list" }),
    payload,
  }),
  async execute(_toolCallId, params, signal) {
    return cliToolResult(await runRepoCli(params, signal));
  },
});

const defectTelegram = defineTool({
  name: "defect_telegram",
  label: "Defect Telegram Delivery",
  description:
    "Deterministically resolve Telegram recipients, send messages/files, or schedule Telegram delivery through the repository CLI. Resolve ambiguous recipients first. Do not duplicate the same final reply to the same current chat. Do not claim a delivery or scheduled delivery succeeded unless this tool succeeds. Use send-file when the user expects an actual Telegram file, not just a local path.",
  parameters: Type.Object({
    command: Type.Union([
      Type.Literal("telegram:resolve-recipient"),
      Type.Literal("telegram:send-message"),
      Type.Literal("telegram:send-file"),
      Type.Literal("telegram:schedule-message"),
    ], { default: "telegram:resolve-recipient" }),
    payload,
  }),
  async execute(_toolCallId, params, signal) {
    return cliToolResult(await runRepoCli(params, signal));
  },
});

export default function defectBotTools(pi: any) {
  pi.registerTool(defectEvents);
  pi.registerTool(defectUsers);
  pi.registerTool(defectTelegram);
}
