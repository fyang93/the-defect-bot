import { describe, expect, test } from "vitest";
import { bufferedFeishuText, feishuContextMessageId, feishuModelPickerCard, isActiveFeishuMessageRecall, isFeishuMessageAddressed, isFeishuMessageGoneError, parseFeishuCommand, parseFeishuMenuEventKey, parseFeishuModelAction, selectBufferedInputs } from "../src/bot/feishu/message";

describe("Feishu message helpers", () => {
  test("requires a mention only in group chats", () => {
    expect(isFeishuMessageAddressed({ chatType: "p2p", mentionedBot: false })).toBe(true);
    expect(isFeishuMessageAddressed({ chatType: "group", mentionedBot: false })).toBe(false);
    expect(isFeishuMessageAddressed({ chatType: "group", mentionedBot: true })).toBe(true);
  });

  test("parses commands and menu labels", () => {
    expect(parseFeishuCommand("/MODEL openai/gpt-5")).toEqual({ name: "model", arg: "openai/gpt-5" });
    expect(parseFeishuCommand("新建会话")).toEqual({ name: "new", arg: "" });
    expect(parseFeishuCommand("剩余额度")).toEqual({ name: "quota", arg: "" });
    expect(parseFeishuCommand("当前提醒")).toEqual({ name: "reminders", arg: "" });
    expect(parseFeishuCommand("切换模型")).toEqual({ name: "model", arg: "" });
    expect(parseFeishuMenuEventKey("new_session")).toBe("new");
    expect(parseFeishuMenuEventKey("remaining_quota")).toBe("quota");
    expect(parseFeishuMenuEventKey("current_reminders")).toBe("reminders");
    expect(parseFeishuMenuEventKey("switch_model")).toBe("model");
    expect(parseFeishuCommand("普通聊天")).toBeNull();
  });

  test("selects group context from an exact reply or recent messages by the same sender", () => {
    const inputs = [
      { messageId: "a", chatId: "chat", senderId: "alice", content: "A" },
      { messageId: "b", chatId: "chat", senderId: "bob", content: "B" },
      { messageId: "c", chatId: "chat", senderId: "alice", content: "C" },
    ];
    expect(selectBufferedInputs(inputs, { chatId: "chat", senderId: "bob", replyToMessageId: "a" })).toEqual([inputs[0]]);
    expect(selectBufferedInputs(inputs, { chatId: "chat", senderId: "alice" }, 1)).toEqual([inputs[2]]);
    expect(bufferedFeishuText([{ messageId: "a", content: "" }])).toContain("用户上传了一个附件");
    expect(feishuContextMessageId({ messageId: "current", rootId: "root", replyToMessageId: "parent" })).toBe("root");
    expect(isActiveFeishuMessageRecall("current", "current")).toBe(true);
  });

  test("recognizes recalled-message errors", () => {
    expect(isFeishuMessageGoneError({ response: { data: { code: 231003 } } })).toBe(true);
    expect(isFeishuMessageGoneError({ cause: { response: { data: { code: 230011 } } } })).toBe(true);
    expect(isFeishuMessageGoneError({ response: { data: { code: 400 } } })).toBe(false);
  });

  test("builds and parses model cards", () => {
    const card = feishuModelPickerCard(["openai/a", "openai/b", "anthropic/c"], "openai/a");
    expect(JSON.stringify(card)).toContain("openai");
    expect(parseFeishuModelAction({ action: "models", provider: "openai", page: 0 })).toEqual({ action: "models", provider: "openai", page: 0 });
    expect(parseFeishuModelAction({ action: "set_model", key: "openai/a" })).toEqual({ action: "set_model", key: "openai/a" });
  });
});
