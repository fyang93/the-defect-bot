import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalize, type LarkChannel, type NormalizedMessage, type RawMessageEvent, type ResourceDescriptor } from "@larksuiteoapi/node-sdk";
import type { AiAttachment, AppConfig, UploadedFile } from "bot/app/types";
import { feishuContextMessageId } from "./message";

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
  const contextMessageId = feishuContextMessageId(message);
  const botIdentity = channel.botIdentity;
  if (!contextMessageId || !botIdentity) return "";
  const fetchItems = async (messageId: string) => {
    const response = await channel.rawClient.im.v1.message.get({ path: { message_id: messageId } });
    return response.data?.items || [];
  };
  const item = (await fetchItems(contextMessageId)).find((candidate) => candidate.message_id === contextMessageId);
  if (!item?.message_id || !item.msg_type || !item.body?.content) return "";
  const mentions = item.mentions?.map((mention) => ({
    key: mention.key,
    id: mention.id_type === "user_id" ? { user_id: mention.id } : mention.id_type === "union_id" ? { union_id: mention.id } : { open_id: mention.id },
    name: mention.name,
    tenant_key: mention.tenant_key,
  }));
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
      mentions,
    },
  };
  const fetchSubMessages = async (messageId: string) => (await fetchItems(messageId)).map((sub) => ({
    message_id: sub.message_id,
    upper_message_id: sub.upper_message_id,
    msg_type: sub.msg_type,
    body: sub.body,
    mentions: sub.mentions?.map((mention) => ({
      key: mention.key,
      id: mention.id_type === "user_id" ? { user_id: mention.id } : mention.id_type === "union_id" ? { union_id: mention.id } : { open_id: mention.id },
      name: mention.name,
      tenant_key: mention.tenant_key,
    })),
    sender: sub.sender,
    create_time: sub.create_time,
  }));
  const normalized = await normalize(raw, { botIdentity, stripBotMentions: true, fetchSubMessages });
  return normalized.content.trim() ? `Feishu topic/reply context (messageId=${contextMessageId}):\n${normalized.content.trim()}` : "";
}

async function downloadMessageResource(channel: LarkChannel, messageId: string, resource: ResourceDescriptor): Promise<Buffer> {
  const response = await channel.rawClient.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: resource.fileKey },
    params: { type: resource.type === "image" ? "image" : "file" },
  });
  const chunks: Buffer[] = [];
  for await (const chunk of response.getReadableStream()) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function saveFeishuResources(channel: LarkChannel, config: AppConfig, message: NormalizedMessage): Promise<{ files: UploadedFile[]; attachments: AiAttachment[] }> {
  const files: UploadedFile[] = [];
  const attachments: AiAttachment[] = [];
  const relativeDir = path.join(config.paths.uploadSubdir, new Date().toISOString().slice(0, 10));
  const absoluteDir = path.join(config.paths.tmpDir, relativeDir);
  await mkdir(absoluteDir, { recursive: true });
  for (const [index, resource] of message.resources.entries()) {
    if (resource.type === "sticker") continue;
    const bytes = await downloadMessageResource(channel, message.messageId, resource);
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

export function feishuOutputFilesFromText(text: string): string[] {
  const files: string[] = [];
  for (const match of text.matchAll(/(?:^|[\s`"'(])(\.?\/?tmp\/[^\s`"')]+)/gm)) {
    files.push(match[1].replace(/[.,;:!?，。；：！？]+$/, ""));
  }
  return Array.from(new Set(files));
}

export async function sendFeishuOutputFiles(channel: LarkChannel, chatId: string, config: AppConfig, files: string[]): Promise<string[]> {
  const sent: string[] = [];
  const seen = new Set<string>();
  for (const candidate of Array.from(new Set(files.map((item) => item.trim()).filter(Boolean)))) {
    const absolutePath = allowedOutputPath(config, candidate);
    if (!absolutePath || seen.has(absolutePath)) continue;
    seen.add(absolutePath);
    try {
      if (!(await stat(absolutePath)).isFile()) continue;
    } catch {
      continue;
    }
    const ext = path.extname(absolutePath).slice(1).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) await channel.send(chatId, { image: { source: absolutePath } });
    else await channel.send(chatId, { file: { source: absolutePath, fileName: path.basename(absolutePath) } });
    sent.push(path.relative(config.paths.repoRoot, absolutePath));
  }
  return sent;
}
