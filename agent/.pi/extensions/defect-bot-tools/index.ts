import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { runToolCommand } from "../../../../src/bot/operations/tools/execute.ts";

const configPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../config.toml");

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
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
const accessLevel = Type.Union([Type.Literal("allowed"), Type.Literal("trusted")]);
const eventMatch = Type.Optional(Type.Record(Type.String(), Type.Any()));
const eventChanges = Type.Optional(Type.Record(Type.String(), Type.Any()));

const eventList = tool(
  "event_list",
  "List Events",
  "List visible reminders, events, routines, and automations.",
  Type.Object({ requesterUserId: Type.Optional(Type.Number()), match: eventMatch }),
  "event_list",
);

const eventGet = tool(
  "event_get",
  "Get Event",
  "Get one event by eventId or match filters. If ambiguous, inspect returned candidates and ask the user.",
  Type.Object({ requesterUserId: Type.Optional(Type.Number()), eventId: Type.Optional(Type.String()), match: eventMatch }),
  "event_get",
);

const eventCreate = tool(
  "event_create",
  "Create Event",
  "Create a reminder, event, routine, scheduled Telegram message, or automation.",
  Type.Object({
    requesterUserId: Type.Optional(Type.Number()),
    title: Type.String(),
    note: Type.Optional(Type.String()),
    targetUserId: Type.Optional(Type.Number()),
    targetChatId: Type.Optional(Type.Number()),
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
  "Update matched events. Prefer exact eventId or explicit ids when available.",
  Type.Object({ requesterUserId: Type.Optional(Type.Number()), match: eventMatch, changes: eventChanges }),
  "event_update",
);

const eventDelete = tool(
  "event_delete",
  "Delete Event",
  "Delete matched events. Prefer exact eventId or explicit ids when available.",
  Type.Object({ requesterUserId: Type.Optional(Type.Number()), match: eventMatch }),
  "event_delete",
);

const eventPause = tool(
  "event_pause",
  "Pause Event",
  "Pause matched events.",
  Type.Object({ requesterUserId: Type.Optional(Type.Number()), match: eventMatch }),
  "event_pause",
);

const eventResume = tool(
  "event_resume",
  "Resume Event",
  "Resume matched events.",
  Type.Object({ requesterUserId: Type.Optional(Type.Number()), match: eventMatch }),
  "event_resume",
);

const telegramListRecipients = tool(
  "telegram_list_recipients",
  "List Telegram Recipients",
  "List known Telegram recipients, optionally filtered by name/alias/username/title. If one result, use its recipientId; if multiple, ask the user to choose; if empty, say no recipient was found or add an alias after clarification.",
  Type.Object({ query: Type.Optional(Type.String({ description: "Optional name, alias, username, or group title filter." })), kind: recipientKind }),
  "telegram_list_recipients",
);

const telegramSendMessage = tool(
  "telegram_send_message",
  "Send Telegram Message",
  "Send content to a resolved Telegram recipientId. Requires trusted/admin requesterUserId. Never use this to duplicate the current-turn reply back to the current chat.",
  Type.Object({ requesterUserId: Type.Number(), recipientId: Type.Number(), recipientLabel: Type.Optional(Type.String()), content: Type.String() }),
  "telegram_send_message",
);

const telegramSendFile = tool(
  "telegram_send_file",
  "Send Telegram File",
  "Send a local repo file to a resolved Telegram recipientId. Requires trusted/admin requesterUserId.",
  Type.Object({ requesterUserId: Type.Number(), recipientId: Type.Number(), recipientLabel: Type.Optional(Type.String()), filePath: Type.String(), caption: Type.Optional(Type.String()) }),
  "telegram_send_file",
);

const userAddAlias = tool(
  "user_add_alias",
  "Add User Alias",
  "Persist a learned canonical alias for a Telegram user id. Use after resolving or after user clarification.",
  Type.Object({ requesterUserId: Type.Number(), userId: Type.Number(), alias: Type.String() }),
  "user_add_alias",
);

const userRecordPerson = tool(
  "user_record_person",
  "Record User Person Memory",
  "Create or update a memory/people README for a Telegram user, record durable facts there, and link system/users.json personPath. Use this when the user asks to remember who a Telegram user is or gives biographical facts.",
  Type.Object({ requesterUserId: Type.Number(), userId: Type.Number(), name: Type.Optional(Type.String()), aliases: Type.Optional(Type.Array(Type.String())), facts: Type.Optional(Type.Array(Type.String())), personPath: Type.Optional(Type.String()) }),
  "user_record_person",
);

const userSetTimezone = tool(
  "user_set_timezone",
  "Set User Timezone",
  "Set a user's timezone.",
  Type.Object({ requesterUserId: Type.Number(), userId: Type.Number(), timezone: Type.String() }),
  "user_set_timezone",
);

const userSetPersonPath = tool(
  "user_set_person_path",
  "Set User Person Path",
  "Link a Telegram user to a memory/people README path.",
  Type.Object({ requesterUserId: Type.Number(), userId: Type.Number(), personPath: Type.String() }),
  "user_set_person_path",
);

const userUpdateRules = tool(
  "user_update_rules",
  "Update User Rules",
  "Add and/or remove durable future-facing assistant rules for a user. To edit a rule, remove the old text and add the new text in one call.",
  Type.Object({ requesterUserId: Type.Number(), userId: Type.Optional(Type.Number()), add: Type.Optional(Type.Array(Type.String())), remove: Type.Optional(Type.Array(Type.String())) }),
  "user_update_rules",
);

const authAddPending = tool(
  "auth_add_pending",
  "Add Pending Authorization",
  "Create a pending authorization claim. Admin only.",
  Type.Object({ requesterUserId: Type.Number(), username: Type.String(), createdBy: Type.Number(), accessLevel: Type.Optional(accessLevel), expiresAt: Type.Optional(Type.String()), durationMinutes: Type.Optional(Type.Number()) }),
  "auth_add_pending",
);

const builtInFileTools = new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]);

function textFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text || "") : "").join("\n");
}

function currentAccessRole(ctx: any): "admin" | "trusted" | "allowed" | null {
  const branch = typeof ctx?.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
  for (const entry of [...branch].reverse()) {
    const message = entry?.message;
    if (message?.role !== "user") continue;
    const match = textFromMessageContent(message.content).match(/accessRole=(admin|trusted|allowed)/);
    if (match) return match[1] as "admin" | "trusted" | "allowed";
  }
  return null;
}

function allowedTmpOnlyInput(input: unknown): boolean {
  const text = JSON.stringify(input || {}).toLowerCase();
  if (/memory[\\/]|system[\\/](?:users|chats|state|events)\.json|config\.toml|agent[\\/]\.pi[\\/](?:auth|models)\.json/.test(text)) return false;
  return /(?:^|[\\/])tmp[\\/]/.test(text);
}

function installAllowedUserFileGuard(pi: any) {
  pi.on("tool_call", (event: any, ctx: any) => {
    if (!builtInFileTools.has(event?.toolName)) return;
    if (currentAccessRole(ctx) !== "allowed") return;
    if (allowedTmpOnlyInput(event.input)) return;
    return { block: true, reason: "Allowed users may only use built-in file tools on tmp/ files; memory and repository private state require trusted access." };
  });
}

export default function defectBotTools(pi: any) {
  installAllowedUserFileGuard(pi);
  for (const item of [
    eventList,
    eventGet,
    eventCreate,
    eventUpdate,
    eventDelete,
    eventPause,
    eventResume,
    telegramListRecipients,
    telegramSendMessage,
    telegramSendFile,
    userAddAlias,
    userRecordPerson,
    userSetTimezone,
    userSetPersonPath,
    userUpdateRules,
    authAddPending,
  ]) {
    pi.registerTool(item);
  }
}
