import path from "node:path";
import { InputFile } from "grammy";
import { markdownToTelegramHtml } from "bot/telegram/format";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const VOICE_EXTENSIONS = new Set([".ogg", ".oga", ".opus"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac", ".mp4"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);

type TelegramSendApi = {
  sendPhoto: (chatId: number, photo: InputFile, other?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  sendVoice: (chatId: number, voice: InputFile, other?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  sendVideo: (chatId: number, video: InputFile, other?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  sendAudio: (chatId: number, audio: InputFile, other?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  sendDocument: (chatId: number, document: InputFile, other?: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

function buildCaptionOptions(caption?: string, plain = false): Record<string, unknown> {
  if (!caption) return {};
  if (plain) return { caption };
  return { caption: markdownToTelegramHtml(caption), parse_mode: "HTML" };
}

function quoteMultipartFilename(filename: string): string {
  const trimmed = filename.trim() || "file";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed;
  return `"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function sendByExtension(
  api: TelegramSendApi,
  recipientId: number,
  input: InputFile,
  ext: string,
  options: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (IMAGE_EXTENSIONS.has(ext)) return await api.sendPhoto(recipientId, input, options);
  if (VOICE_EXTENSIONS.has(ext)) return await api.sendVoice(recipientId, input, options);
  if (VIDEO_EXTENSIONS.has(ext)) return await api.sendVideo(recipientId, input, options);
  if (AUDIO_EXTENSIONS.has(ext)) return await api.sendAudio(recipientId, input, options);
  return await api.sendDocument(recipientId, input, options);
}

export async function sendTelegramLocalFile(api: TelegramSendApi, recipientId: number, absPath: string, options?: { filename?: string; caption?: string }): Promise<{ messageId?: number }> {
  const ext = path.extname(absPath).toLowerCase();
  // grammY currently emits multipart Content-Disposition as `filename=${filename}`.
  // Quoting the filename keeps characters such as parentheses in the Telegram-side
  // filename parser instead of letting them be interpreted as header separators.
  const input = new InputFile(absPath, quoteMultipartFilename(options?.filename || path.basename(absPath)));
  let result: Record<string, unknown> | undefined;
  try {
    result = await sendByExtension(api, recipientId, input, ext, buildCaptionOptions(options?.caption, false));
  } catch {
    result = await sendByExtension(api, recipientId, input, ext, buildCaptionOptions(options?.caption, true));
  }
  const messageId = result && "message_id" in result ? Number(result.message_id) : undefined;
  return { messageId };
}
