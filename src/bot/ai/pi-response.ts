export type PiPromptRole = "assistant" | "maintainer" | "writer";

export type ExecutionSummary = { tool: string; status: string; inputChars: number; outputChars: number };
export type MessageDebugSummary = { role: string; content: string; partTypes: string[]; textChars: number };

export function extractText(message: unknown): string {
  const record = message && typeof message === "object" ? message as { content?: unknown } : {};
  if (typeof record.content === "string") return record.content.trim();
  const typedRecord = record as { content?: Array<{ type?: string; text?: string }> };
  const content = Array.isArray(typedRecord.content) ? typedRecord.content : [];
  const texts = content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text?.trim())
    .filter(Boolean);
  return texts.length > 0 ? texts.join("\n\n") : "";
}

export function extractAssistantText(message: unknown): string {
  const record = message && typeof message === "object" ? message as { role?: string } : {};
  if (record.role !== "assistant") return "";
  return extractText(message);
}

export function summarizeExecutionParts(parts: unknown): ExecutionSummary[] {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const record = part as Record<string, unknown>;
    if (record.type !== "tool" && record.type !== "toolCall") return [];
    const tool = typeof record.tool === "string" ? record.tool.trim() : typeof record.name === "string" ? record.name.trim() : "";
    const stateRecord = record.state && typeof record.state === "object" ? record.state as Record<string, unknown> : null;
    const status = stateRecord && typeof stateRecord.status === "string" ? stateRecord.status.trim() : "unknown";
    const input = stateRecord?.input;
    const output = stateRecord?.output;
    return [{
      tool,
      status,
      inputChars: typeof input === "string" ? input.length : JSON.stringify(input || "").length,
      outputChars: typeof output === "string" ? output.length : JSON.stringify(output || "").length,
    }];
  });
}

export function summarizeToolResults(messages: unknown): ExecutionSummary[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const record = message as Record<string, unknown>;
    if (record.role !== "toolResult") return [];
    const content = Array.isArray(record.content) ? record.content : [];
    const output = content.map((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text" ? String((part as Record<string, unknown>).text || "") : "").join("\n");
    return [{
      tool: typeof record.toolName === "string" ? record.toolName : "unknown",
      status: record.isError ? "error" : "completed",
      inputChars: 0,
      outputChars: output.length,
    }];
  });
}

export function summarizeMessagesForDebug(messages: unknown[]): MessageDebugSummary[] {
  return messages.map((message) => {
    const record = message && typeof message === "object" ? message as Record<string, unknown> : {};
    const content = record.content;
    const partTypes = Array.isArray(content)
      ? content.map((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).type === "string" ? String((part as Record<string, unknown>).type) : typeof part).slice(0, 12)
      : [];
    return {
      role: typeof record.role === "string" ? record.role : "unknown",
      content: Array.isArray(content) ? "array" : typeof content,
      partTypes,
      textChars: extractText(message).length,
    };
  });
}

export function ensureNoToolExecution(role: PiPromptRole | undefined, parts: unknown): void {
  if (!role || role === "assistant") return;
  const executionParts = summarizeExecutionParts(parts);
  if (executionParts.length === 0) return;
  throw new Error(`${role} text generation must not execute tools`);
}
