import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "grammy";
import type { AppConfig, AiAttachment, UploadedFile } from "bot/app/types";
import { sendTelegramLocalFile } from "bot/telegram/delivery";

type AnyRecord = Record<string, unknown>;

const INVALID_FILENAME_RE = /[\u0000-\u001F\u007F]/g;
const MARKDOWN_LOCAL_LINK_RE = /\]\(((?:\.\.\/|\.\/)*(?:memory|tmp)\/[^)\s]+|\/[^)\s]+)\)/gm;
const TEXT_LOCAL_PATH_RE = /(?:^|[\s`"'(<\[])(((?:\.\.\/|\.\/)*(?:memory|tmp)\/[^\s`"')>\]]+)|\/[^\s`"')>\]]+)(?=$|[\s`"')>\]])/gm;
const PROTECTED_SYSTEM_FILES = new Set([
  path.join("system", "events.json"),
  path.join("system", "state.json"),
  path.join("system", "runtime-state.json"),
  path.join("system", "users.json"),
  path.join("system", "chats.json"),
]);

function sanitizeFilename(name: string): string {
  const source = String(name || "file").replace(/\\/g, "/");
  const base = path.basename(source).normalize("NFC");
  const normalized = base
    .replace(INVALID_FILENAME_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized === "." || normalized === "..") return "file";
  return normalized;
}

function inferExtensionFromMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/png") return ".png";
  if (mimeType === "audio/ogg" || mimeType === "audio/opus") return ".ogg";
  if (mimeType === "audio/mpeg") return ".mp3";
  if (mimeType === "audio/mp4") return ".m4a";
  if (mimeType === "audio/wav") return ".wav";
  if (mimeType === "video/mp4") return ".mp4";
  return "";
}

function targetPath(targetDir: string, filename: string): { filename: string; filePath: string } {
  return {
    filename,
    filePath: path.join(targetDir, filename),
  };
}

const TELEGRAM_FETCH_ATTEMPTS = 3;
const TELEGRAM_FETCH_RETRY_BASE_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function fetchWithRetry(url: string, label: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TELEGRAM_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok || !isRetryableHttpStatus(response.status) || attempt === TELEGRAM_FETCH_ATTEMPTS) {
        return response;
      }
      lastError = new Error(`${label} failed: ${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
      if (attempt === TELEGRAM_FETCH_ATTEMPTS) break;
    }
    await sleep(TELEGRAM_FETCH_RETRY_BASE_MS * attempt);
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed: ${String(lastError)}`);
}

async function downloadTelegramFile(botToken: string, filePath: string): Promise<Uint8Array> {
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const response = await fetchWithRetry(url, "Telegram file download");
  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function toDataUri(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function parseDataUri(dataUri: string): { mimeType: string; bytes: Uint8Array } | null {
  const match = dataUri.match(/^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.*)$/s);
  if (!match) return null;
  return {
    mimeType: match[1],
    bytes: new Uint8Array(Buffer.from(match[2], "base64")),
  };
}

async function fetchAttachmentBytes(url: string): Promise<{ bytes: Uint8Array; mimeType?: string }> {
  const response = await fetchWithRetry(url, "Attachment download");
  if (!response.ok) {
    throw new Error(`Attachment download failed: ${response.status} ${response.statusText}`);
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type") || undefined,
  };
}

function asRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === "object" ? value as AnyRecord : undefined;
}

function extractTelegramFileMetadata(message: unknown): Omit<UploadedFile, "savedPath" | "absolutePath" | "sizeBytes" | "filename"> & { fileId: string } | null {
  const record = asRecord(message);
  const document = asRecord(record?.document);
  const voice = asRecord(record?.voice);
  const audio = asRecord(record?.audio);
  const video = asRecord(record?.video);
  const photos = Array.isArray(record?.photo) ? record.photo : [];

  if (typeof document?.file_id === "string") {
    return {
      fileId: document.file_id,
      originalName: sanitizeFilename(typeof document.file_name === "string" ? document.file_name : "document"),
      mimeType: typeof document.mime_type === "string" && document.mime_type.trim() ? document.mime_type : "application/octet-stream",
      source: "document",
    };
  }
  if (photos.length > 0) {
    const photo = asRecord(photos[photos.length - 1]);
    if (typeof photo?.file_id === "string") {
      return {
        fileId: photo.file_id,
        originalName: `photo-${Date.now()}.jpg`,
        mimeType: "image/jpeg",
        source: "photo",
      };
    }
  }
  if (typeof voice?.file_id === "string") {
    const mimeType = typeof voice.mime_type === "string" && voice.mime_type.trim() ? voice.mime_type : "audio/ogg";
    return {
      fileId: voice.file_id,
      originalName: `voice-${Date.now()}${inferExtensionFromMime(mimeType) || ".ogg"}`,
      mimeType,
      source: "voice",
      durationSeconds: typeof voice.duration === "number" ? voice.duration : undefined,
    };
  }
  if (typeof audio?.file_id === "string") {
    const mimeType = typeof audio.mime_type === "string" && audio.mime_type.trim() ? audio.mime_type : "audio/mpeg";
    return {
      fileId: audio.file_id,
      originalName: sanitizeFilename(typeof audio.file_name === "string" && audio.file_name.trim() ? audio.file_name : `audio-${Date.now()}${inferExtensionFromMime(mimeType) || ".audio"}`),
      mimeType,
      source: "audio",
      audioTitle: typeof audio.title === "string" && audio.title.trim() ? audio.title.trim() : undefined,
      audioPerformer: typeof audio.performer === "string" && audio.performer.trim() ? audio.performer.trim() : undefined,
      durationSeconds: typeof audio.duration === "number" ? audio.duration : undefined,
    };
  }
  if (typeof video?.file_id === "string") {
    const mimeType = typeof video.mime_type === "string" && video.mime_type.trim() ? video.mime_type : "video/mp4";
    return {
      fileId: video.file_id,
      originalName: sanitizeFilename(typeof video.file_name === "string" && video.file_name.trim() ? video.file_name : `video-${Date.now()}${inferExtensionFromMime(mimeType) || ".mp4"}`),
      mimeType,
      source: "video",
      durationSeconds: typeof video.duration === "number" ? video.duration : undefined,
    };
  }

  return null;
}

async function getTelegramFileWithRetry(ctx: Context, fileId: string): Promise<Awaited<ReturnType<Context["api"]["getFile"]>>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TELEGRAM_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await ctx.api.getFile(fileId);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (/file is too big/i.test(message) || attempt === TELEGRAM_FETCH_ATTEMPTS) break;
      await sleep(TELEGRAM_FETCH_RETRY_BASE_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Telegram getFile failed: ${String(lastError)}`);
}

async function persistTelegramFile(ctx: Context, config: AppConfig, fileMeta: Omit<UploadedFile, "savedPath" | "absolutePath" | "sizeBytes" | "filename"> & { fileId: string }): Promise<UploadedFile> {
  let file;
  try {
    file = await getTelegramFileWithRetry(ctx, fileMeta.fileId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/file is too big/i.test(message)) {
      throw new Error("Telegram Bot API refused to provide the file because it exceeds Telegram's bot download limit (about 20 MB).");
    }
    throw error;
  }
  if (!file.file_path) {
    throw new Error("Telegram file path is missing");
  }

  const bytes = await downloadTelegramFile(config.telegram.botToken, file.file_path);
  const dateDir = new Date().toISOString().slice(0, 10);
  const targetDir = path.join(config.paths.tmpDir, config.paths.uploadSubdir, dateDir);
  await mkdir(targetDir, { recursive: true });
  const target = targetPath(targetDir, fileMeta.originalName);
  await writeFile(target.filePath, bytes);

  const uploaded = {
    savedPath: path.relative(config.paths.repoRoot, target.filePath),
    absolutePath: target.filePath,
    originalName: fileMeta.originalName,
    filename: target.filename,
    mimeType: fileMeta.mimeType,
    sizeBytes: bytes.byteLength,
    source: fileMeta.source,
    audioTitle: fileMeta.audioTitle,
    audioPerformer: fileMeta.audioPerformer,
    durationSeconds: fileMeta.durationSeconds,
  } satisfies UploadedFile;
  return uploaded;
}

export async function saveTelegramFileFromMessage(
  ctx: Context,
  config: AppConfig,
  message: unknown,
): Promise<UploadedFile | null> {
  const fileMeta = extractTelegramFileMetadata(message);
  if (!fileMeta) return null;
  return persistTelegramFile(ctx, config, fileMeta);
}

export async function saveTelegramFile(
  ctx: Context,
  config: AppConfig,
): Promise<UploadedFile | null> {
  return saveTelegramFileFromMessage(ctx, config, ctx.message);
}

export async function uploadedFileToAiAttachment(file: UploadedFile): Promise<AiAttachment> {
  const bytes = new Uint8Array(await readFile(file.absolutePath));
  return {
    mimeType: file.mimeType,
    filename: file.filename,
    url: toDataUri(bytes, file.mimeType),
  };
}

function normalizeCandidateFilePath(rawPath: string): string | null {
  const trimmed = rawPath.trim().replace(/[),.;:]+$/g, "");
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) return trimmed;
  const normalized = trimmed.replace(/^(?:\.\.\/|\.\/)+/, "");
  if (normalized.startsWith("memory/") || normalized.startsWith("tmp/")) return normalized;
  return null;
}

export function extractCandidateFilePaths(text: string): string[] {
  const matches = [
    ...Array.from(text.matchAll(MARKDOWN_LOCAL_LINK_RE)).map((match) => match[1] || ""),
    ...Array.from(text.matchAll(TEXT_LOCAL_PATH_RE)).map((match) => match[1] || ""),
  ].map((item) => normalizeCandidateFilePath(item))
    .filter((item): item is string => Boolean(item));
  return Array.from(new Set(matches));
}

export async function sendLocalFiles(ctx: Context, config: AppConfig, candidates: string[]): Promise<string[]> {
  const matches = Array.from(new Set(candidates.map((item) => item.trim()).filter(Boolean)));
  const sent: string[] = [];
  for (const candidate of matches) {
    const absPath = path.isAbsolute(candidate) ? candidate : path.resolve(config.paths.repoRoot, candidate);
    const relPath = path.relative(config.paths.repoRoot, absPath);
    if (relPath.startsWith("..")) continue;
    if (PROTECTED_SYSTEM_FILES.has(relPath)) continue;
    try {
      const info = await stat(absPath);
      if (!info.isFile()) continue;
      await sendTelegramLocalFile(ctx.api as any, ctx.chat!.id, absPath, { filename: path.basename(absPath) });
      sent.push(relPath);
    } catch {
      // ignore invalid paths
    }
  }
  return sent;
}

export async function sendAiAttachments(ctx: Context, config: AppConfig, attachments: AiAttachment[]): Promise<number> {
  let sent = 0;
  const tempDir = path.join(config.paths.tmpDir, config.paths.uploadSubdir, "outgoing");
  await mkdir(tempDir, { recursive: true });

  for (const attachment of attachments) {
    try {
      const parsed = attachment.url.startsWith("data:") ? parseDataUri(attachment.url) : null;
      const fetched = parsed ? null : await fetchAttachmentBytes(attachment.url);
      const mimeType = parsed?.mimeType || fetched?.mimeType || attachment.mimeType || "application/octet-stream";
      const bytes = parsed?.bytes || fetched?.bytes;
      if (!bytes) continue;

      const ext = path.extname(attachment.filename || "") || inferExtensionFromMime(mimeType);
      const base = sanitizeFilename(path.basename(attachment.filename || `attachment-${Date.now()}${ext}`));
      const target = targetPath(tempDir, base);
      await writeFile(target.filePath, bytes);
      try {
        await sendTelegramLocalFile(ctx.api as any, ctx.chat!.id, target.filePath, { filename: attachment.filename || target.filename });
        sent += 1;
      } finally {
        await unlink(target.filePath).catch(() => {});
      }
    } catch {
      // ignore invalid attachments
    }
  }

  return sent;
}
