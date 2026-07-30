import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalize, type LarkChannel, type NormalizedMessage, type RawMessageEvent, type ResourceDescriptor } from "@larksuiteoapi/node-sdk";
import type { AiAttachment, AppConfig, UploadedFile } from "bot/app/types";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

function safeFilename(value: string): string {
  const clean = path.basename(value.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean && clean !== "." && clean !== ".." ? clean : "file";
}

function mimeType(resource: ResourceDescriptor): string {
  const ext = path.extname(resource.fileName || "").slice(1).toLowerCase();
  if (resource.type === "image" || IMAGE_EXTENSIONS.has(ext)) return `image/${ext === "jpg" ? "jpeg" : ext || "jpeg"}`;
  if (resource.type === "audio") return ext ? `audio/${ext}` : "audio/ogg";
  if (resource.type === "video") return ext ? `video/${ext}` : "video/mp4";
  return "application/octet-stream";
}

export async function fetchFeishuReplyContext(channel: LarkChannel, message: NormalizedMessage): Promise<string> {
  const contextMessageId = message.rootId && message.rootId !== message.messageId
    ? message.rootId
    : message.replyToMessageId && message.replyToMessageId !== message.messageId ? message.replyToMessageId : undefined;
  if (!contextMessageId || !channel.botIdentity) return "";
  const response = await channel.rawClient.im.v1.message.get({ path: { message_id: contextMessageId } });
  const item = response.data?.items?.find((candidate) => candidate.message_id === contextMessageId);
  if (!item?.message_id || !item.msg_type || !item.body?.content) return "";
  const raw: RawMessageEvent = {
    sender: { sender_id: { open_id: item.sender?.id } },
    message: {
      message_id: item.message_id,
      root_id: item.root_id,
      parent_id: item.parent_id,
      thread_id: item.thread_id,
      create_time: String(item.create_time || ""),
      chat_id: item.chat_id || message.chatId,
      chat_type: message.chatType,
      message_type: item.msg_type,
      content: item.body.content,
      mentions: item.mentions?.map((mention) => ({ key: mention.key, id: mention.id_type === "user_id" ? { user_id: mention.id } : mention.id_type === "union_id" ? { union_id: mention.id } : { open_id: mention.id }, name: mention.name, tenant_key: mention.tenant_key })),
    },
  };
  const normalized = await normalize(raw, { botIdentity: channel.botIdentity, stripBotMentions: true });
  return normalized.content.trim() ? `Feishu topic/reply context (messageId=${contextMessageId}):\n${normalized.content.trim()}` : "";
}

export async function saveFeishuResources(channel: LarkChannel, config: AppConfig, message: NormalizedMessage): Promise<{ files: UploadedFile[]; attachments: AiAttachment[] }> {
  const files: UploadedFile[] = [];
  const attachments: AiAttachment[] = [];
  const relativeDir = path.join(config.paths.uploadSubdir, new Date().toISOString().slice(0, 10));
  const absoluteDir = path.join(config.paths.tmpDir, relativeDir);
  await mkdir(absoluteDir, { recursive: true });
  for (const [index, resource] of message.resources.entries()) {
    if (resource.type === "sticker") continue;
    const bytes = await channel.downloadResource(resource.fileKey, resource.type === "image" ? "image" : "file");
    const originalName = safeFilename(resource.fileName || `${resource.type}.bin`);
    const filename = `${message.messageId}-${index}-${originalName}`;
    const absolutePath = path.join(absoluteDir, filename);
    await writeFile(absolutePath, bytes);
    const type = mimeType(resource);
    const uploaded: UploadedFile = {
      savedPath: path.relative(config.paths.repoRoot, absolutePath),
      absolutePath,
      originalName,
      filename,
      mimeType: type,
      sizeBytes: bytes.byteLength,
      source: resource.type === "image" || resource.type === "audio" || resource.type === "video" ? resource.type : "file",
      durationSeconds: typeof resource.durationMs === "number" ? Math.ceil(resource.durationMs / 1000) : undefined,
    };
    files.push(uploaded);
    if (type.startsWith("image/")) attachments.push({ mimeType: type, filename, url: `data:${type};base64,${bytes.toString("base64")}` });
  }
  return { files, attachments };
}

function allowedOutputPath(config: AppConfig, candidate: string): string | null {
  const absolutePath = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(config.paths.repoRoot, candidate.replace(/^\.\//, ""));
  const relative = path.relative(config.paths.repoRoot, absolutePath);
  return relative.startsWith("..") || path.isAbsolute(relative) ? null : absolutePath;
}

export async function sendFeishuOutputFiles(channel: LarkChannel, chatId: string, config: AppConfig, files: string[]): Promise<string[]> {
  const sent: string[] = [];
  for (const candidate of Array.from(new Set(files.map((item) => item.trim()).filter(Boolean)))) {
    const absolutePath = allowedOutputPath(config, candidate);
    if (!absolutePath) continue;
    const ext = path.extname(absolutePath).slice(1).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) await channel.send(chatId, { image: { source: absolutePath } });
    else await channel.send(chatId, { file: { source: absolutePath, fileName: path.basename(absolutePath) } });
    sent.push(path.relative(config.paths.repoRoot, absolutePath));
  }
  return sent;
}
