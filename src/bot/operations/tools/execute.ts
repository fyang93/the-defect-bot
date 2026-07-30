import { handleEventMutation, handleEventsCreate, handleEventsGet, handleEventsList } from "bot/operations/tools/events";
import { appendToolLogLine, ToolOutput, emitToolTerminalLine, initializeToolContext, logToolInvocation, summarizeArgsForLog, type ToolArgs } from "bot/operations/tools/runtime";
import { handleFeishuListRecipients, handleFeishuSendFile, handleFeishuSendMessage } from "bot/operations/tools/feishu";
import { handleUsersAddAlias, handleUsersGet, handleUsersList, handleUsersRecordPerson, handleUsersSetPersonPath, handleUsersSetTimezone, handleUsersUpdateRules } from "bot/operations/tools/users";

function summarize(command: string, value: unknown): { level: "INFO" | "WARN"; message: string } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (record.ok === false) return { level: "WARN", message: `${command}: ${record.error || record.reason || "failed"}` };
  if (record.delivered) return { level: "INFO", message: `${command}: delivered to ${record.recipientLabel || record.recipientId}` };
  if (Array.isArray(record.events)) return { level: "INFO", message: `${command}: ${record.events.length} event(s)` };
  return { level: "INFO", message: `${command}: done` };
}

async function dispatch(command: string, context: Awaited<ReturnType<typeof initializeToolContext>>): Promise<void> {
  switch (command) {
    case "user:list": await handleUsersList(context); break;
    case "user:get": await handleUsersGet(context); break;
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
    case "feishu_list_recipients": await handleFeishuListRecipients(context); break;
    case "feishu_send_message": await handleFeishuSendMessage(context); break;
    case "feishu_send_file": await handleFeishuSendFile(context); break;
    default: context.output({ ok: false, error: `unsupported-command:${command}` });
  }
}

export async function runToolCommand(command: string, args: ToolArgs = {}, options: { configPath?: string } = {}): Promise<unknown> {
  const context = await initializeToolContext(args, options.configPath);
  const startedAt = Date.now();
  emitToolTerminalLine(context.config, "INFO", `${command}: start`);
  await logToolInvocation(context.config, command, command, args);
  try { await dispatch(command.trim(), context); return { ok: true }; }
  catch (error) {
    if (error instanceof ToolOutput) {
      appendToolLogLine(context.config, "INFO", `tool operation complete command=${command} ms=${Date.now() - startedAt} output=${summarizeArgsForLog(error.value)}`);
      const result = summarize(command, error.value); emitToolTerminalLine(context.config, result.level, result.message); return error.value;
    }
    appendToolLogLine(context.config, "ERROR", `tool operation failed command=${command} message=${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
