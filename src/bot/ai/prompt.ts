import type { UploadedFile } from "bot/app/types";
import { formatIsoInTimezoneParts } from "bot/app/time";

export type RequestAccessRole = "admin" | "trusted" | "allowed";

export function buildPersonaStyleLines(personaStyle?: string, options?: { label?: string }): string[] {
  const style = personaStyle?.trim();
  if (!style) return [];

  return [
    `${options?.label || "Style"}: ${style}`,
    "Reply in that style.",
  ];
}

export function buildProjectSystemPrompt(role: "assistant" | "maintainer" | "writer" = "assistant"): string {
  if (role === "assistant") {
    return [
      "Follow the Defect Bot assistant instructions loaded from AGENTS.md.",
      "Do the work, then return one user-visible reply.",
      "Fast path: for clear bot actions, use the deterministic bot tool directly; do not inspect source/logs first.",
      "For outbound messages use telegram_list_recipients then telegram_send_message; for explicit remember requests from admin/trusted users use user_record_person.",
    ].filter(Boolean).join("\n");
  }

  if (role === "writer") {
    return [
      "You are a text-only reply writer for a local-first Telegram bot.",
      "Return plain text only.",
      "Do not use tools or change state.",
    ].filter(Boolean).join("\n");
  }

  if (role === "maintainer") {
    return [
      "You maintain a local-first repository.",
      "Prefer native repo tools and deterministic interfaces.",
      "Write short user-facing summaries in the bot's default language.",
      "Keep memory concise and do not replace canonical operational state with it.",
      "Never write under system/ except approved deterministic interfaces.",
    ].filter(Boolean).join("\n");
  }

  throw new Error(`Unsupported prompt role: ${String(role)}`);
}

export function buildPrompt(text: string, uploadedFiles: UploadedFile[], defaultTimezone: string, messageTime?: string, accessRole: RequestAccessRole = "allowed", sharedConversationContextText?: string, requesterTimezone?: string | null): string {
  const userRequest = text.trim() || "Handle the user input.";
  const effectiveTimezone = requesterTimezone?.trim() || defaultTimezone;
  const localMessageTime = formatIsoInTimezoneParts(messageTime, effectiveTimezone);

  const lines = [
    uploadedFiles.length > 0 ? "Files:" : "",
    ...uploadedFiles.map((file) => `- ${file.savedPath} (${file.mimeType}, ${Math.ceil(file.sizeBytes / 1024)} KB)`),
    sharedConversationContextText || "",
    localMessageTime ? `requesterLocalTime=${localMessageTime.localDateTime} (${localMessageTime.timezone})` : "",
    `accessRole=${accessRole}`,
    `Request: ${userRequest}`,
  ].filter(Boolean);

  return lines.join("\n");
}
