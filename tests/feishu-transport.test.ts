import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import type { LarkChannel, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { AppConfig } from "../src/bot/app/types";
import { feishuOutputFilesFromText, fetchFeishuReplyContext, saveFeishuResources, sendFeishuOutputFiles } from "../src/bot/feishu/transport";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function config(root: string): AppConfig {
  return {
    feishu: { appId: "cli", appSecret: "secret", inputMergeWindowSeconds: 0, menuPageSize: 8 },
    bot: { personaStyle: "", language: "zh-CN", defaultTimezone: "UTC" },
    paths: {
      repoRoot: root,
      tmpDir: path.join(root, "tmp"),
      uploadSubdir: "feishu",
      logFile: path.join(root, "bot.log"),
      stateFile: path.join(root, "system/state.json"),
    },
    maintenance: { enabled: false, idleAfterMs: 0, tmpRetentionDays: 7 },
  };
}

describe("Feishu message resources", () => {
  test("downloads inbound resources through the message-resource API and passes images to Pi", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "defect-feishu-resource-"));
    roots.push(root);
    const image = Buffer.from([1, 2, 3]);
    const document = Buffer.from("document");
    const get = vi.fn(async (payload: { path: { file_key: string } }) => ({
      getReadableStream: () => Readable.from([payload.path.file_key === "img-key" ? image : document]),
    }));
    const downloadResource = vi.fn(async () => { throw new Error("legacy resource API must not be used"); });
    const channel = {
      rawClient: { im: { v1: { messageResource: { get } } } },
      downloadResource,
    } as unknown as LarkChannel;
    const message = {
      messageId: "om_message",
      chatId: "oc_chat",
      chatType: "p2p",
      senderId: "ou_user",
      content: "",
      rawContentType: "image",
      resources: [
        { type: "image", fileKey: "img-key", fileName: "chart.png" },
        { type: "file", fileKey: "file-key", fileName: "notes.pdf" },
      ],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: Date.now(),
    } satisfies NormalizedMessage;

    const result = await saveFeishuResources(channel, config(root), message);

    expect(get).toHaveBeenNthCalledWith(1, {
      path: { message_id: "om_message", file_key: "img-key" },
      params: { type: "image" },
    });
    expect(get).toHaveBeenNthCalledWith(2, {
      path: { message_id: "om_message", file_key: "file-key" },
      params: { type: "file" },
    });
    expect(downloadResource).not.toHaveBeenCalled();
    expect(result.files).toHaveLength(2);
    expect(readFileSync(result.files[0].absolutePath)).toEqual(image);
    expect(readFileSync(result.files[1].absolutePath)).toEqual(document);
    expect(result.attachments).toEqual([{
      mimeType: "image/png",
      filename: result.files[0].filename,
      url: `data:image/png;base64,${image.toString("base64")}`,
    }]);
  });

  test("expands merged-forward messages when loading reply context", async () => {
    const items = [
      { message_id: "forward", msg_type: "merge_forward", body: { content: "{}" }, chat_id: "oc_chat", sender: { id: "ou_sender" }, create_time: "1700000000000" },
      { message_id: "child", upper_message_id: "forward", msg_type: "text", body: { content: JSON.stringify({ text: "转发内容" }) }, sender: { id: "ou_child" }, create_time: "1700000001000" },
    ];
    const get = vi.fn(async () => ({ data: { items } }));
    const channel = { botIdentity: { openId: "ou_bot", name: "bot" }, rawClient: { im: { v1: { message: { get } } } } } as unknown as LarkChannel;
    const current = {
      messageId: "current", chatId: "oc_chat", chatType: "group", senderId: "ou_user", content: "继续",
      rawContentType: "text", resources: [], mentions: [], mentionAll: false, mentionedBot: true,
      replyToMessageId: "forward", createTime: Date.now(),
    } satisfies NormalizedMessage;

    const context = await fetchFeishuReplyContext(channel, current);

    expect(context).toContain("转发内容");
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("detects existing tmp output paths and sends each file once", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "defect-feishu-output-"));
    roots.push(root);
    const app = config(root);
    const output = path.join(app.paths.tmpDir, "result.png");
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, Buffer.from([1, 2, 3]), { flag: "w" });
    const send = vi.fn(async () => ({ messageId: "sent" }));
    const channel = { send } as unknown as LarkChannel;
    const paths = feishuOutputFilesFromText("结果见 `./tmp/result.png`\n备用 tmp/result.png。");

    const sent = await sendFeishuOutputFiles(channel, "oc_chat", app, paths);

    expect(paths).toEqual(["./tmp/result.png", "tmp/result.png"]);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("oc_chat", { image: { source: output } });
    expect(sent).toEqual(["tmp/result.png"]);
  });
});
