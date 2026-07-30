import type { AiTurnResult } from "./types";

export function looksLikeStructuredOutputIntent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /^\s*\[(?:response|answer)\][\s\S]*\[\/(?:response|answer)\]\s*$/i.test(trimmed)
    || /^```(?:json)?/i.test(trimmed)
    || /(^|\n)(?:answer_mode|message|deliveries|schedules|tasks|file_writes)\s*:/i.test(trimmed)
    || /"(?:answer_mode|message|deliveries|schedules|tasks|file_writes)"\s*:/.test(trimmed);
}

function looksLikeMalformedAssistantOutput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /^```(?:json)?/i.test(trimmed)
    || /\[TOOL_CALL\][\s\S]*\[\/TOOL_CALL\]/i.test(trimmed)
    || /"answer_mode"\s*:/.test(trimmed)
    || /(^|\n)\s*answer_mode\s*:/i.test(trimmed)
    || /^\s*\[(?:response|answer)\][\s\S]*\[\/(?:response|answer)\]\s*$/i.test(trimmed);
}

export function isDisplayableUserText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (looksLikeStructuredOutputIntent(trimmed) && !/^\s*\[(?:response|answer)\][\s\S]*\[\/(?:response|answer)\]\s*$/i.test(trimmed)) return false;
  if (/(<invoke\b|<\/minimax:tool_call>|<tool_call\b|<function_calls?\b)/i.test(trimmed)) return false;
  if (/\[TOOL_CALL\][\s\S]*\[\/TOOL_CALL\]/i.test(trimmed)) return false;
  if (/\{tool\s*=>/i.test(trimmed)) return false;
  if (/<\/?[a-z][a-z0-9:_-]*\b[^>]*>/i.test(trimmed)) return false;
  if (/^<[^>]+>[\s\S]*<\/[^>]+>$/.test(trimmed)) return false;
  return true;
}

export function extractDisplayableText(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) return "";
  if (looksLikeMalformedAssistantOutput(trimmed) || looksLikeStructuredOutputIntent(trimmed)) return "";

  const normalizedQuotes = trimmed
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, '"')
    .replace(/[，]/g, ',')
    .replace(/[：]/g, ':');

  try {
    const parsed = JSON.parse(normalizedQuotes) as Record<string, unknown> | string;
    if (typeof parsed === "string" && isDisplayableUserText(parsed)) {
      return parsed.trim();
    }
    if (parsed && typeof parsed === "object" && typeof parsed.message === "string" && isDisplayableUserText(parsed.message)) {
      return parsed.message.trim();
    }
  } catch {
    // fall through to plain-text extraction
  }

  const plain = trimmed.replace(/^"([\s\S]*)"$/, "$1").trim();
  return isDisplayableUserText(plain) ? plain : "";
}

export function emptyTurnResult(): AiTurnResult {
  return { message: "", files: [], attachments: [] };
}

export function extractDirectTurnResultFromText(rawText: string): AiTurnResult {
  const message = extractDisplayableText(rawText);
  return message ? { ...emptyTurnResult(), message } : emptyTurnResult();
}

export function extractAiTurnResultFromText(rawText: string): AiTurnResult {
  return extractDirectTurnResultFromText(rawText);
}
