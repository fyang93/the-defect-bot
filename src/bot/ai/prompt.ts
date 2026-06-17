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

export function buildProjectSystemPrompt(personaStyle?: string, role: "assistant" | "maintainer" | "writer" = "assistant"): string {
  if (role === "assistant") {
    return [
      "Follow the Defect Bot assistant instructions loaded from AGENTS.md.",
      "Do the work, then return one user-visible reply.",
      ...buildPersonaStyleLines(personaStyle),
    ].filter(Boolean).join("\n");
  }

  if (role === "writer") {
    return [
      "You are a text-only reply writer for a local-first Telegram bot.",
      "Return plain text only.",
      "Do not use tools or change state.",
      ...buildPersonaStyleLines(personaStyle),
    ].filter(Boolean).join("\n");
  }

  if (role === "maintainer") {
    return [
      "You maintain a local-first repository.",
      "Prefer native repo tools and deterministic interfaces.",
      "Write short user-facing summaries in the bot's default language.",
      "Keep memory concise and do not replace canonical operational state with it.",
      "Never write under system/ except approved deterministic interfaces.",
      ...buildPersonaStyleLines(personaStyle, { label: "Summary style" }),
    ].filter(Boolean).join("\n");
  }

  throw new Error(`Unsupported prompt role: ${String(role)}`);
}

export function buildAccessConstraintLines(accessRole: RequestAccessRole): string[] {
  if (accessRole === "admin") {
    return [
      "Permission: admin — may access and return requester-linked recorded personal information when asked; do not apply an extra local privacy refusal rule.",
    ];
  }

  if (accessRole === "allowed") {
    return [
      "Permission: allowed — temporary file upload/processing is okay in your scoped context, but no user management, auth changes, durable memory writes, outbound delivery, or unrelated private data.",
      "If higher privilege is needed, say so briefly.",
    ];
  }

  if (accessRole === "trusted") {
    return [
      "Permission: trusted — may access and return requester-linked recorded personal information when asked; no access-level or pending-auth changes.",
    ];
  }

  return [];
}

export function buildPrompt(text: string, uploadedFiles: UploadedFile[], defaultTimezone: string, personaStyle: string, messageTime?: string, accessRole: RequestAccessRole = "allowed", sharedConversationContextText?: string, requesterTimezone?: string | null): string {
  const userRequest = text.trim() || "Handle the user input.";
  const effectiveTimezone = requesterTimezone?.trim() || defaultTimezone;
  const localMessageTime = formatIsoInTimezoneParts(messageTime, effectiveTimezone);

  const lines = [
    uploadedFiles.length > 0 ? "Files:" : "",
    ...uploadedFiles.map((file) => `- ${file.savedPath} (${file.mimeType}, ${Math.ceil(file.sizeBytes / 1024)} KB)`),
    sharedConversationContextText || "",
    localMessageTime ? `Local time: ${localMessageTime.localDateTime} (${localMessageTime.timezone}).` : "",
    localMessageTime ? `Interpret relative times in ${localMessageTime.timezone}.` : "",
    ...buildAccessConstraintLines(accessRole),
    ...buildPersonaStyleLines(personaStyle),
    `Request: ${userRequest}`,
  ].filter(Boolean);

  return lines.join("\n");
}
