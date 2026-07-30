import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@larksuiteoapi/node-sdk";
import { listMatchingFeishuRecipients } from "bot/operations/recipients/resolve";
import { logger } from "bot/app/logger";
import type { ToolContext } from "bot/operations/tools/runtime";

function client(context: ToolContext): Client { return new Client({ appId: context.config.feishu.appId, appSecret: context.config.feishu.appSecret }); }
function recipient(context: ToolContext): { kind: "user" | "chat"; id: string; label: string } {
  const id = context.asId(context.args.recipientId);
  const kind = context.cleanText(context.args.recipientKind) || (id?.startsWith("oc_") ? "chat" : "user");
  if ((kind !== "user" && kind !== "chat") || !id) context.output({ ok: false, error: "invalid-recipient" });
  return { kind: kind as "user" | "chat", id: id as string, label: context.cleanText(context.args.recipientLabel) || id as string };
}

async function sendRaw(context: ToolContext, target: { kind: "user" | "chat"; id: string }, msgType: string, content: Record<string, unknown>): Promise<string | undefined> {
  const response = await client(context).im.v1.message.create({
    params: { receive_id_type: target.kind === "chat" ? "chat_id" : "open_id" },
    data: { receive_id: target.id, msg_type: msgType, content: JSON.stringify(content) },
  });
  if (response.code && response.code !== 0) throw new Error(response.msg || `Feishu API error ${response.code}`);
  return response.data?.message_id;
}

export async function handleFeishuListRecipients(context: ToolContext): Promise<never> {
  const query = context.cleanText(context.args.query);
  const kind = context.cleanText(context.args.kind) || (query ? "all" : "groups");
  if (kind !== "groups" && kind !== "users" && kind !== "all") context.output({ ok: false, error: "invalid-recipient-kind" });
  context.output({ ok: true, recipients: listMatchingFeishuRecipients(context.config, { query, kind }) });
}

export async function handleFeishuSendMessage(context: ToolContext): Promise<never> {
  const content = context.cleanText(context.args.content);
  if (!content) context.output({ ok: false, error: "missing-content" });
  const target = recipient(context);
  await logger.info(`feishu tool send_message recipient=${target.label} chars=${content!.length}`);
  const messageId = await sendRaw(context, target, "text", { text: content });
  context.output({ ok: true, delivered: true, recipientKind: target.kind, recipientId: target.id, recipientLabel: target.label, messageId });
}

export async function handleFeishuSendFile(context: ToolContext): Promise<never> {
  const target = recipient(context);
  const requestedPath = context.cleanText(context.args.filePath);
  if (!requestedPath) context.output({ ok: false, error: "missing-filePath" });
  const absolutePath = path.isAbsolute(requestedPath!) ? requestedPath! : path.resolve(context.config.paths.repoRoot, requestedPath!);
  const relativePath = path.relative(context.config.paths.repoRoot, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) context.output({ ok: false, error: "file-outside-repo" });
  readFileSync(absolutePath);
  const upload = await client(context).im.v1.file.create({ data: { file_type: "stream", file_name: path.basename(absolutePath), file: createReadStream(absolutePath) } });
  const fileKey = upload?.file_key;
  if (!fileKey) throw new Error("Feishu upload returned no file key");
  const messageId = await sendRaw(context, target, "file", { file_key: fileKey });
  const caption = context.cleanText(context.args.caption);
  if (caption) await sendRaw(context, target, "text", { text: caption });
  context.output({ ok: true, delivered: true, recipientKind: target.kind, recipientId: target.id, recipientLabel: target.label, messageId, filePath: relativePath });
}
