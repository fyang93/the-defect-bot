import type { UploadedFile } from "bot/app/types";
import { formatIsoInTimezoneParts } from "bot/app/time";

export type RequestPermissionMode = "full";
export function buildPersonaStyleLines(personaStyle?: string, options?: { label?: string }): string[] {
  return personaStyle?.trim() ? [`${options?.label || "Style"}: ${personaStyle.trim()}`, "Reply in that style."] : [];
}
export function buildProjectSystemPrompt(role: "assistant" | "maintainer" | "writer" = "assistant"): string {
  if (role === "assistant") return [
    "Follow the Defect Bot assistant instructions loaded from AGENTS.md.",
    "Do the work, then return one user-visible reply.",
    "For clear bot actions use the deterministic tool directly.",
    "For outbound messages use feishu_list_recipients then feishu_send_message; for durable memory use user_record_person.",
  ].join("\n");
  if (role === "writer") return "You are a text-only reply writer for a local-first Feishu bot. Return plain text only. Do not use tools or change state.";
  return "You maintain a local-first repository. Keep memory concise, use deterministic interfaces, and never write under system/ directly.";
}
export function buildPrompt(text: string, uploadedFiles: UploadedFile[], defaultTimezone: string, messageTime?: string, _permissionMode: RequestPermissionMode = "full", sharedConversationContextText?: string, requesterTimezone?: string | null): string {
  const local = formatIsoInTimezoneParts(messageTime, requesterTimezone?.trim() || defaultTimezone);
  return [
    uploadedFiles.length ? "Files:" : "",
    ...uploadedFiles.map((file) => `- ${file.savedPath} (${file.mimeType}, ${Math.ceil(file.sizeBytes / 1024)} KB)`),
    sharedConversationContextText || "",
    local ? `requesterLocalTime=${local.localDateTime} (${local.timezone})` : "",
    "permissions=full",
    `Request: ${text.trim() || "Handle the user input."}`,
  ].filter(Boolean).join("\n");
}
