import { addPendingAuthorization, appendToolLogLine, ToolOutput, emitToolLogLine, initializeRepoTool, logToolInvocation, summarizeArgsForLog, type ToolArgs } from "bot/tools/runtime";
import { handleEventMutation, handleEventsCreate, handleEventsGet, handleEventsList } from "bot/tools/commands/events";
import { handleTelegramResolveRecipient, handleTelegramScheduleMessage, handleTelegramSendFile, handleTelegramSendMessage } from "bot/tools/commands/telegram";
import { handleUsersAddRule, handleUsersGet, handleUsersList, handleUsersSetAccess, handleUsersSetPersonPath, handleUsersSetRules, handleUsersSetTimezone } from "bot/tools/commands/users";

function summarizeToolResult(command: string, value: unknown): { level: "INFO" | "WARN"; message: string } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const summary = typeof record?.summary === "string" && record.summary.trim() ? record.summary.trim() : "";
  const error = typeof record?.error === "string" && record.error.trim() ? record.error.trim() : "";
  const reason = typeof record?.reason === "string" && record.reason.trim() ? record.reason.trim() : "";
  const status = typeof record?.status === "string" && record.status.trim() ? record.status.trim() : "";
  const changed = typeof record?.changed === "boolean" ? record.changed : undefined;
  const delivered = record?.delivered === true;
  const scheduled = record?.scheduled === true;
  const eventCount = Array.isArray(record?.events) ? record.events.length : undefined;

  if (summary) return { level: record?.ok === false ? "WARN" : "INFO", message: `${command}: ${summary}` };
  if (record?.ok === false) return { level: "WARN", message: `${command}: ${error || reason || status || "failed"}` };
  if (delivered) {
    const target = typeof record?.recipientLabel === "string" && record.recipientLabel.trim() ? record.recipientLabel.trim() : String(record?.recipientId ?? "recipient");
    return { level: "INFO", message: `${command}: delivered to ${target}` };
  }
  if (scheduled) {
    const target = typeof record?.recipientLabel === "string" && record.recipientLabel.trim() ? record.recipientLabel.trim() : String(record?.recipientId ?? "recipient");
    const sendAt = typeof record?.sendAt === "string" && record.sendAt.trim() ? ` at ${record.sendAt.trim()}` : "";
    return { level: "INFO", message: `${command}: scheduled for ${target}${sendAt}` };
  }
  if (typeof changed === "boolean") return { level: "INFO", message: `${command}: ${changed ? "changed" : "no change"}` };
  if (typeof eventCount === "number") return { level: "INFO", message: `${command}: ${eventCount} event(s)` };
  if (status) return { level: "INFO", message: `${command}: ${status}` };
  return { level: "INFO", message: `${command}: done` };
}

export async function runRepoTool(command: string, args: ToolArgs = {}, options: { configPath?: string } = {}): Promise<unknown> {
  const context = await initializeRepoTool(args, options.configPath);
  const commandStartedAt = Date.now();

  emitToolLogLine(context.config, "INFO", `${command || "unknown-tool"}: start`);
  await logToolInvocation(context.config, command, command, args);

  try {
    switch (command) {
      case "users:list": await handleUsersList(context); break;
      case "users:get": await handleUsersGet(context); break;
      case "users:set-access": await handleUsersSetAccess(context); break;
      case "users:set-timezone": await handleUsersSetTimezone(context); break;
      case "users:set-person-path": await handleUsersSetPersonPath(context); break;
      case "users:add-rule": await handleUsersAddRule(context); break;
      case "users:set-rules": await handleUsersSetRules(context); break;
      case "events:list": await handleEventsList(context); break;
      case "events:get": await handleEventsGet(context); break;
      case "events:create": await handleEventsCreate(context); break;
      case "events:update": await handleEventMutation(context, "update"); break;
      case "events:delete": await handleEventMutation(context, "delete"); break;
      case "events:pause": await handleEventMutation(context, "pause"); break;
      case "events:resume": await handleEventMutation(context, "resume"); break;
      case "auth:add-pending": await addPendingAuthorization(context); break;
      case "telegram:resolve-recipient": await handleTelegramResolveRecipient(context); break;
      case "telegram:send-message": await handleTelegramSendMessage(context); break;
      case "telegram:send-file": await handleTelegramSendFile(context); break;
      case "telegram:schedule-message": await handleTelegramScheduleMessage(context); break;
      default: context.output({ ok: false, error: `unsupported-tool:${command}` });
    }
  } catch (error) {
    if (error instanceof ToolOutput) {
      appendToolLogLine(context.config, "INFO", `repo tool complete command=${command} ms=${Date.now() - commandStartedAt} output=${summarizeArgsForLog(error.value)}`);
      const summary = summarizeToolResult(command, error.value);
      emitToolLogLine(context.config, summary.level, summary.message);
      return error.value;
    }
    appendToolLogLine(context.config, "ERROR", `repo tool failed command=${command} ms=${Date.now() - commandStartedAt} message=${error instanceof Error ? error.message : String(error)}`);
    emitToolLogLine(context.config, "ERROR", `${command}: exception ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }

  return { ok: true };
}
