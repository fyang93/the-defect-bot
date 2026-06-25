import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { runRepoTool } from "../../../../src/bot/tools/registry";

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function optionalRecord(description: string) {
  return Type.Optional(Type.Record(Type.String(), Type.Any(), { description }));
}

const requesterUserId = Type.Optional(Type.Number({ description: "Telegram user id of the requester for access checks." }));
const match = optionalRecord("Fields used to resolve the target event/reminder, e.g. id, title, scheduledDate.");

function repoTool(name: string, label: string, description: string, commandForOperation: Record<string, string>, parameters: any) {
  return defineTool({
    name,
    label,
    description,
    parameters,
    async execute(_toolCallId, params) {
      const payload = params as Record<string, unknown>;
      const operation = typeof payload.operation === "string" ? payload.operation : "";
      const command = commandForOperation[operation];
      if (!command) return toolResult({ ok: false, error: `unsupported-operation:${operation || "missing"}` });
      return toolResult(await runRepoTool(command, payload));
    },
  });
}

const tools = [
  repoTool(
    "events",
    "Events / Reminders",
    "Manage reminders, schedules, events, routines, and automations. Operations: list, get, create, update, delete, pause, resume. For mutations, resolve ambiguity first and do not claim success unless this tool succeeds.",
    {
      list: "events:list",
      get: "events:get",
      create: "events:create",
      update: "events:update",
      delete: "events:delete",
      pause: "events:pause",
      resume: "events:resume",
    },
    Type.Object({
      operation: Type.Union([Type.Literal("list"), Type.Literal("get"), Type.Literal("create"), Type.Literal("update"), Type.Literal("delete"), Type.Literal("pause"), Type.Literal("resume")]),
      requesterUserId,
      match,
      eventId: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      schedule: optionalRecord("Schedule object for create/update, e.g. {kind:'once', scheduledAt:'...'} or parsed recurrence."),
      changes: optionalRecord("Fields to update on the event/reminder."),
      note: Type.Optional(Type.String()),
      timezone: Type.Optional(Type.String()),
      category: Type.Optional(Type.Union([Type.Literal("routine"), Type.Literal("special"), Type.Literal("automation")])),
      specialKind: Type.Optional(Type.Union([Type.Literal("birthday"), Type.Literal("festival"), Type.Literal("anniversary"), Type.Literal("memorial")])),
      timeSemantics: Type.Optional(Type.Union([Type.Literal("absolute"), Type.Literal("local")])),
      targetUserId: Type.Optional(Type.Number()),
      targetChatId: Type.Optional(Type.Number()),
      targets: optionalRecord("Optional target wrapper for update: {targets:[...]}"),
      reminders: Type.Optional(Type.Array(Type.Any())),
    }),
  ),

  repoTool(
    "users",
    "Users / Authorization",
    "Manage users, access control, timezones, person links, durable assistant rules, and pending authorization. Operations: list, get, set_access, set_timezone, set_person_path, add_rule, set_rules, add_pending_auth.",
    {
      list: "users:list",
      get: "users:get",
      set_access: "users:set-access",
      set_timezone: "users:set-timezone",
      set_person_path: "users:set-person-path",
      add_rule: "users:add-rule",
      set_rules: "users:set-rules",
      add_pending_auth: "auth:add-pending",
    },
    Type.Object({
      operation: Type.Union([Type.Literal("list"), Type.Literal("get"), Type.Literal("set_access"), Type.Literal("set_timezone"), Type.Literal("set_person_path"), Type.Literal("add_rule"), Type.Literal("set_rules"), Type.Literal("add_pending_auth")]),
      requesterUserId,
      userId: Type.Optional(Type.Number()),
      username: Type.Optional(Type.String()),
      displayName: Type.Optional(Type.String()),
      accessLevel: Type.Optional(Type.Union([Type.Literal("allowed"), Type.Literal("trusted"), Type.Literal("none"), Type.Literal("clear")])),
      timezone: Type.Optional(Type.String()),
      personPath: Type.Optional(Type.String()),
      rule: Type.Optional(Type.String()),
      rules: Type.Optional(Type.Array(Type.String())),
      createdBy: Type.Optional(Type.Number()),
      expiresAt: Type.Optional(Type.String()),
      durationMinutes: Type.Optional(Type.Number()),
      lastSeenAt: Type.Optional(Type.String()),
    }),
  ),

  repoTool(
    "telegram",
    "Telegram Delivery",
    "Resolve Telegram recipients and send or schedule Telegram messages/files. Operations: resolve_recipient, send_message, send_file, schedule_message. Do not duplicate the current-turn reply; do not claim success unless this tool succeeds.",
    {
      resolve_recipient: "telegram:resolve-recipient",
      send_message: "telegram:send-message",
      send_file: "telegram:send-file",
      schedule_message: "telegram:schedule-message",
    },
    Type.Object({
      operation: Type.Union([Type.Literal("resolve_recipient"), Type.Literal("send_message"), Type.Literal("send_file"), Type.Literal("schedule_message")]),
      requesterUserId,
      id: Type.Optional(Type.Number()),
      username: Type.Optional(Type.String()),
      displayName: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      recipientKind: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("chat")])),
      recipientId: Type.Optional(Type.Number()),
      recipientLabel: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      filePath: Type.Optional(Type.String()),
      caption: Type.Optional(Type.String()),
      sendAt: Type.Optional(Type.String()),
    }),
  ),
];

export default function registerTools(pi: any) {
  for (const tool of tools) pi.registerTool(tool);
}
