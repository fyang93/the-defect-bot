import { handleEventMutation, handleEventsCreate, handleEventsGet, handleEventsList } from "bot/operations/tools/events";
import { addPendingAuthorization, appendToolLogLine, ToolOutput, emitToolTerminalLine, initializeToolContext, logToolInvocation, summarizeArgsForLog, type ToolArgs } from "bot/operations/tools/runtime";
import { handleTelegramListRecipients, handleTelegramSendFile, handleTelegramSendMessage } from "bot/operations/tools/telegram";
import { handleUsersAddAlias, handleUsersGet, handleUsersList, handleUsersRecordPerson, handleUsersSetAccess, handleUsersSetPersonPath, handleUsersSetTimezone, handleUsersUpdateRules } from "bot/operations/tools/users";

function summarizeToolResult(command: string, value: unknown): { level: "INFO" | "WARN"; message: string } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const summary = typeof record?.summary === "string" && record.summary.trim() ? record.summary.trim() : "";
  const error = typeof record?.error === "string" && record.error.trim() ? record.error.trim() : "";
  const reason = typeof record?.reason === "string" && record.reason.trim() ? record.reason.trim() : "";
  const status = typeof record?.status === "string" && record.status.trim() ? record.status.trim() : "";
  const changed = typeof record?.changed === "boolean" ? record.changed : undefined;
  const delivered = record?.delivered === true;
  const eventCount = Array.isArray(record?.events) ? record.events.length : undefined;

  if (summary) return { level: record?.ok === false ? "WARN" : "INFO", message: `${command}: ${summary}` };
  if (record?.ok === false) return { level: "WARN", message: `${command}: ${error || reason || status || "failed"}` };
  if (delivered) {
    const target = typeof record?.recipientLabel === "string" && record.recipientLabel.trim() ? record.recipientLabel.trim() : String(record?.recipientId ?? "recipient");
    return { level: "INFO", message: `${command}: delivered to ${target}` };
  }
  if (typeof changed === "boolean") return { level: "INFO", message: `${command}: ${changed ? "changed" : "no change"}` };
  if (typeof eventCount === "number") return { level: "INFO", message: `${command}: ${eventCount} event(s)` };
  if (status) return { level: "INFO", message: `${command}: ${status}` };
  return { level: "INFO", message: `${command}: done` };
}

async function dispatchToolCommand(command: string, context: Awaited<ReturnType<typeof initializeToolContext>>): Promise<void> {
  switch (command) {
    case "user:list": await handleUsersList(context); break;
    case "user:get": await handleUsersGet(context); break;
    case "user:set-access": await handleUsersSetAccess(context); break;
    case "user_set_timezone": await handleUsersSetTimezone(context); break;
    case "user_set_person_path": await handleUsersSetPersonPath(context); break;
    case "user_add_alias": await handleUsersAddAlias(context); break;
    case "user_record_person": await handleUsersRecordPerson(context); break;
    case "user_update_rules": await handleUsersUpdateRules(context); break;
    case "event_list": await handleEventsList(context); break;
    case "event_get": await handleEventsGet(context); break;
    case "event_create": await handleEventsCreate(context); break;
    case "event_update": await handleEventMutation(context, "update"); break;
    case "event_delete": await handleEventMutation(context, "delete"); break;
    case "event_pause": await handleEventMutation(context, "pause"); break;
    case "event_resume": await handleEventMutation(context, "resume"); break;
    case "auth_add_pending": await addPendingAuthorization(context); break;
    case "telegram_list_recipients": await handleTelegramListRecipients(context); break;
    case "telegram_send_message": await handleTelegramSendMessage(context); break;
    case "telegram_send_file": await handleTelegramSendFile(context); break;
    default: context.output({ ok: false, error: `unsupported-command:${command}` });
  }
}

export async function runToolCommand(command: string, args: ToolArgs = {}, options: { configPath?: string } = {}): Promise<unknown> {
  const context = await initializeToolContext(args, options.configPath);
  const startedAt = Date.now();
  emitToolTerminalLine(context.config, "INFO", `${command || "unknown-command"}: start`);
  await logToolInvocation(context.config, command, command, args);
  try {
    await dispatchToolCommand(command.trim(), context);
    return { ok: true };
  } catch (error) {
    if (error instanceof ToolOutput) {
      appendToolLogLine(context.config, "INFO", `tool operation complete command=${command} ms=${Date.now() - startedAt} output=${summarizeArgsForLog(error.value)}`);
      const summary = summarizeToolResult(command, error.value);
      emitToolTerminalLine(context.config, summary.level, summary.message);
      return error.value;
    }
    appendToolLogLine(context.config, "ERROR", `tool operation failed command=${command} ms=${Date.now() - startedAt} message=${error instanceof Error ? error.message : String(error)}`);
    emitToolTerminalLine(context.config, "ERROR", `${command}: exception ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
