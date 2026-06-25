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

function packageRunner(): { command: string; argsPrefix: string[] } {
  return process.versions.bun
    ? { command: "bun", argsPrefix: ["run", "repo:cli", "--"] }
    : { command: "npm", argsPrefix: ["run", "repo:cli", "--"] };
}

async function runRepoCommand(command: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const root = repoRootFromCwd();
  const runner = packageRunner();
  const result = await spawnCollect(runner.command, [...runner.argsPrefix, command, JSON.stringify(payload)], { cwd: root, signal });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `repo:cli ${command} exited with ${result.code}`;
    throw new Error(message);
  }
  const stdout = result.stdout.trim();
  try {
    return stdout ? JSON.parse(stdout) : { ok: true };
  } catch {
    return { ok: true, text: stdout };
  }
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function atomicTool(name: string, label: string, description: string, parameters: any, command: string) {
  return defineTool({
    name,
    label,
    description,
    parameters,
    async execute(_toolCallId, params, signal) {
      return toolResult(await runRepoCommand(command, params as Record<string, unknown>, signal));
    },
  });
}

const optionalRequester = Type.Optional(Type.Number({ description: "Telegram user id of the requester for permission checks." }));
const recipientKind = Type.Optional(Type.Union([Type.Literal("groups"), Type.Literal("users"), Type.Literal("all")], { default: "groups" }));

const defectEvents = defineTool({
  name: "defect_events",
  label: "Defect Events",
  description: "Create/list/get/update/pause/resume/delete reminders, events, routines, and automations. This remains a compact event-command tool because event payloads are structured and already deterministic.",
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
    payload: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Event command payload." })),
  }),
  async execute(_toolCallId, params, signal) {
    return toolResult(await runRepoCommand(params.command, params.payload ?? {}, signal));
  },
});

const telegramListRecipients = atomicTool(
  "telegram_list_recipients",
  "List Telegram Recipients",
  "List known Telegram recipients, optionally filtered by name/alias/username/title. If one result, use its recipientId; if multiple, ask the user to choose; if empty, say no recipient was found or add an alias after clarification.",
  Type.Object({ query: Type.Optional(Type.String({ description: "Optional name, alias, username, or group title filter, e.g. 李博 or 全流程AI." })), kind: recipientKind }),
  "telegram:list-recipients",
);


const telegramSendMessage = atomicTool(
  "telegram_send_message",
  "Send Telegram Message",
  "Send content to a resolved Telegram recipientId. Requires trusted/admin requesterUserId. Never use this to duplicate the current-turn reply back to the current chat.",
  Type.Object({
    requesterUserId: Type.Number(),
    recipientId: Type.Number(),
    recipientLabel: Type.Optional(Type.String()),
    content: Type.String(),
  }),
  "telegram:send-message",
);

const telegramSendFile = atomicTool(
  "telegram_send_file",
  "Send Telegram File",
  "Send a local repo file to a resolved Telegram recipientId. Requires trusted/admin requesterUserId.",
  Type.Object({
    requesterUserId: Type.Number(),
    recipientId: Type.Number(),
    recipientLabel: Type.Optional(Type.String()),
    filePath: Type.String(),
    caption: Type.Optional(Type.String()),
  }),
  "telegram:send-file",
);

const usersAddAlias = atomicTool(
  "user_add_alias",
  "Add User Alias",
  "Persist a learned canonical alias for a Telegram user id. Use after resolving or after user clarification.",
  Type.Object({ requesterUserId: Type.Number(), userId: Type.Number(), alias: Type.String() }),
  "users:add-alias",
);


const userSetTimezone = atomicTool(
  "user_set_timezone",
  "Set User Timezone",
  "Set a user's timezone.",
  Type.Object({ requesterUserId: Type.Number(), userId: Type.Number(), timezone: Type.String() }),
  "users:set-timezone",
);

const userSetPersonPath = atomicTool(
  "user_set_person_path",
  "Set User Person Path",
  "Link a Telegram user to a memory/people README path.",
  Type.Object({ requesterUserId: Type.Number(), userId: Type.Number(), personPath: Type.String() }),
  "users:set-person-path",
);

const userUpdateRules = atomicTool(
  "user_update_rules",
  "Update User Rules",
  "Add and/or remove durable future-facing assistant rules for a user. To edit a rule, remove the old text and add the new text in one call.",
  Type.Object({ requesterUserId: Type.Number(), userId: Type.Optional(Type.Number()), add: Type.Optional(Type.Array(Type.String())), remove: Type.Optional(Type.Array(Type.String())) }),
  "users:update-rules",
);

const authAddPending = atomicTool(
  "auth_add_pending",
  "Add Pending Authorization",
  "Create a pending authorization claim. Admin only.",
  Type.Object({ requesterUserId: Type.Number(), userId: Type.Number(), accessLevel: Type.Union([Type.Literal("allowed"), Type.Literal("trusted")]), expiresAt: Type.Optional(Type.String()) }),
  "auth:add-pending",
);

export default function defectBotTools(pi: any) {
  pi.registerTool(defectEvents);
  pi.registerTool(telegramListRecipients);
  pi.registerTool(telegramSendMessage);
  pi.registerTool(telegramSendFile);
  pi.registerTool(usersAddAlias);
  pi.registerTool(userSetTimezone);
  pi.registerTool(userSetPersonPath);
  pi.registerTool(userUpdateRules);
  pi.registerTool(authAddPending);
}
