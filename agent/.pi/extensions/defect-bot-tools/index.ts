import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { runToolCommand } from "../../../../src/bot/operations/tools/execute.ts";

const configPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../config.toml");

function compactEvent(event: Record<string, any> | undefined) {
  if (!event) return undefined;
  return {
    id: event.id,
    title: event.title,
    status: event.status,
    category: event.category,
    schedule: event.scheduleSummary || event.schedule,
    scheduledAtLocal: event.scheduledAtRequesterLocal || event.scheduledAtDisplayLocal,
    nextOccurrenceLocal: event.currentOccurrence?.scheduledAtRequesterLocal || event.currentOccurrence?.scheduledAtDisplayLocal,
    reminders: Array.isArray(event.remindersDetailed)
      ? event.remindersDetailed.map((item: Record<string, any>) => ({ label: item.label, notifyAtLocal: item.notifyAtRequesterLocal || item.notifyAtDisplayLocal }))
      : event.reminders,
    targets: event.targets,
  };
}

function compactToolResult(value: unknown): unknown {
  const record = value && typeof value === "object" ? value as Record<string, any> : null;
  if (!record || record.ok === false) return value;

  if (record.delivered) {
    const recipient = record.recipientLabel || record.recipientId;
    return { ok: true, delivered: true, receipt: `已发送给 ${recipient}`, recipientId: record.recipientId, messageId: record.messageId };
  }
  if (record.event) {
    const event = compactEvent(record.event);
    return { ok: true, changed: record.changed, eventId: record.eventId || record.event.id, receipt: `已处理：${record.event.title}`, event };
  }
  if (Array.isArray(record.events)) {
    return { ok: true, count: record.events.length, events: record.events.map(compactEvent) };
  }
  if (record.userId || record.personPath) {
    return { ok: true, changed: record.changed, userId: record.userId, personPath: record.personPath, receipt: record.personPath ? `已记录到 ${record.personPath}` : "用户资料已更新" };
  }
  if (Array.isArray(record.recipients)) {
    return { ok: true, count: record.recipients.length, recipients: record.recipients };
  }
  return value;
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(compactToolResult(value), null, 2) }],
    details: value,
  };
}

function tool(name: string, label: string, description: string, parameters: any, command: string) {
  return defineTool({
    name,
    label,
    description,
    parameters,
    async execute(_toolCallId, params) {
      return toolResult(await runToolCommand(command, params as Record<string, unknown>, { configPath }));
    },
  });
}

const recipientKind = Type.Optional(Type.Union([Type.Literal("groups"), Type.Literal("users"), Type.Literal("all")], { default: "groups" }));
const eventMatch = Type.Optional(Type.Record(Type.String(), Type.Any()));
const eventChanges = Type.Optional(Type.Record(Type.String(), Type.Any()));

const eventList = tool(
  "event_list",
  "List Events",
  "List visible reminders, events, routines, and automations.",
  Type.Object({ requesterUserId: Type.Optional(Type.String()), match: eventMatch }),
  "event_list",
);

const eventGet = tool(
  "event_get",
  "Get Event",
  "Get one event by eventId or match filters. If ambiguous, inspect returned candidates and ask the user.",
  Type.Object({ requesterUserId: Type.Optional(Type.String()), eventId: Type.Optional(Type.String()), match: eventMatch }),
  "event_get",
);

const eventCreate = tool(
  "event_create",
  "Create Event",
  "Create a reminder, event, routine, scheduled Feishu message, or automation. Clear reminder requests should call this directly and trust the returned receipt/event summary; do not call another tool just to verify creation. For recurring schedules, stored schedule.time is interpreted in the target user's local timezone; convert explicit outside timezones to that local time before calling.",
  Type.Object({
    requesterUserId: Type.Optional(Type.String()),
    title: Type.String(),
    note: Type.Optional(Type.String()),
    targetUserId: Type.Optional(Type.String()),
    targetChatId: Type.Optional(Type.String()),
    timezone: Type.Optional(Type.String()),
    schedule: Type.Record(Type.String(), Type.Any()),
    category: Type.Optional(Type.String()),
    specialKind: Type.Optional(Type.String()),
    timeSemantics: Type.Optional(Type.String()),
    reminders: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Any()))),
  }),
  "event_create",
);

const eventUpdate = tool(
  "event_update",
  "Update Event",
  "Update matched events. Prefer exact eventId or explicit ids when available. Trust the returned receipt/event summary; do not call another tool just to verify the update.",
  Type.Object({ requesterUserId: Type.Optional(Type.String()), match: eventMatch, changes: eventChanges }),
  "event_update",
);

const eventDelete = tool(
  "event_delete",
  "Delete Event",
  "Delete matched events. Prefer exact eventId or explicit ids when available. Trust the returned receipt/event summary; do not call another tool just to verify deletion.",
  Type.Object({ requesterUserId: Type.Optional(Type.String()), match: eventMatch }),
  "event_delete",
);

const eventPause = tool(
  "event_pause",
  "Pause Event",
  "Pause matched events. Trust the returned receipt/event summary; do not call another tool just to verify pause.",
  Type.Object({ requesterUserId: Type.Optional(Type.String()), match: eventMatch }),
  "event_pause",
);

const eventResume = tool(
  "event_resume",
  "Resume Event",
  "Resume matched events. Trust the returned receipt/event summary; do not call another tool just to verify resume.",
  Type.Object({ requesterUserId: Type.Optional(Type.String()), match: eventMatch }),
  "event_resume",
);

const feishuListRecipients = tool(
  "feishu_list_recipients",
  "List Feishu Recipients",
  "List known Feishu recipients, optionally filtered by name, alias, or group title. If one result, use its recipientId; if multiple, ask the user to choose; if empty, say no recipient was found or add an alias after clarification.",
  Type.Object({ query: Type.Optional(Type.String({ description: "Optional name, alias, or group title filter." })), kind: recipientKind }),
  "feishu_list_recipients",
);

const feishuSendMessage = tool(
  "feishu_send_message",
  "Send Feishu Message",
  "Send content to a resolved Feishu recipientId. Returns a delivery receipt; do not call another tool just to verify delivery. Never use this to duplicate the current-turn reply back to the current chat.",
  Type.Object({ requesterUserId: Type.String(), recipientKind: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("chat")])), recipientId: Type.String(), recipientLabel: Type.Optional(Type.String()), content: Type.String() }),
  "feishu_send_message",
);

const feishuSendFile = tool(
  "feishu_send_file",
  "Send Feishu File",
  "Send a local repo file to a resolved Feishu recipientId.",
  Type.Object({ requesterUserId: Type.String(), recipientKind: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("chat")])), recipientId: Type.String(), recipientLabel: Type.Optional(Type.String()), filePath: Type.String(), caption: Type.Optional(Type.String()) }),
  "feishu_send_file",
);

const userAddAlias = tool(
  "user_add_alias",
  "Add User Alias",
  "Persist a learned human-readable name, nickname, or handle for a Feishu user. Never pass a machine identifier (user/open/union/chat ID or another opaque value) as an alias.",
  Type.Object({ requesterUserId: Type.String(), userId: Type.String(), alias: Type.String() }),
  "user_add_alias",
);

const userRecordPerson = tool(
  "user_record_person",
  "Record User Person Memory",
  "Create or update a memory/people README for a Feishu user, record durable facts there, and link system/users.json personPath. Names and aliases must be human-readable names, nicknames, or handles, never machine identifiers. Use this when a user explicitly asks to remember facts, including account/login details. Trust the returned receipt; do not read the file just to verify.",
  Type.Object({ requesterUserId: Type.String(), userId: Type.String(), name: Type.Optional(Type.String()), aliases: Type.Optional(Type.Array(Type.String())), facts: Type.Optional(Type.Array(Type.String())), personPath: Type.Optional(Type.String()) }),
  "user_record_person",
);

const userSetTimezone = tool(
  "user_set_timezone",
  "Set User Timezone",
  "Set a user's timezone.",
  Type.Object({ requesterUserId: Type.String(), userId: Type.String(), timezone: Type.String() }),
  "user_set_timezone",
);

const userSetPersonPath = tool(
  "user_set_person_path",
  "Set User Person Path",
  "Link a Feishu user to a memory/people README path.",
  Type.Object({ requesterUserId: Type.String(), userId: Type.String(), personPath: Type.String() }),
  "user_set_person_path",
);

export default function defectBotTools(pi: any) {
  for (const item of [
    eventList,
    eventGet,
    eventCreate,
    eventUpdate,
    eventDelete,
    eventPause,
    eventResume,
    feishuListRecipients,
    feishuSendMessage,
    feishuSendFile,
    userAddAlias,
    userRecordPerson,
    userSetTimezone,
    userSetPersonPath,
  ]) {
    pi.registerTool(item);
  }
}
