export function isFeishuMessageAddressed(message: { chatType: "p2p" | "group"; mentionedBot: boolean }): boolean {
  return message.chatType === "p2p" || message.mentionedBot;
}

export function isActiveFeishuMessageRecall(activeMessageId: string | undefined, recalledMessageId: string | undefined): boolean {
  return Boolean(activeMessageId && activeMessageId === recalledMessageId);
}

export function feishuContextMessageId(message: { messageId: string; rootId?: string; replyToMessageId?: string }): string | undefined {
  return message.rootId && message.rootId !== message.messageId
    ? message.rootId
    : message.replyToMessageId && message.replyToMessageId !== message.messageId ? message.replyToMessageId : undefined;
}

export function selectBufferedInputs<T extends { messageId: string; chatId: string; senderId: string }>(
  inputs: readonly T[],
  message: { chatId: string; senderId: string; replyToMessageId?: string },
  limit = 3,
): T[] {
  const exact = message.replyToMessageId
    ? inputs.filter((item) => item.chatId === message.chatId && item.messageId === message.replyToMessageId)
    : [];
  return exact.length
    ? exact
    : inputs.filter((item) => item.chatId === message.chatId && item.senderId === message.senderId).slice(-limit);
}

export function bufferedFeishuText(inputs: readonly { messageId: string; content: string }[]): string {
  const lines = inputs.map((item) => `- messageId=${item.messageId}: ${item.content.trim() || "用户上传了一个附件。"}`);
  return lines.length ? ["Recent unaddressed Feishu messages from this user:", ...lines].join("\n") : "";
}

export function assistantTextDelta(event: Record<string, unknown>): string {
  if (event.type !== "message_update" || !event.assistantMessageEvent || typeof event.assistantMessageEvent !== "object") return "";
  const update = event.assistantMessageEvent as Record<string, unknown>;
  return update.type === "text_delta" && typeof update.delta === "string" ? update.delta : "";
}

export function isFeishuMessageGoneError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth += 1) {
    const item = current as Record<string, unknown>;
    if (item.code === "target_revoked") return true;
    const response = item.response && typeof item.response === "object" ? item.response as Record<string, unknown> : undefined;
    const data = response?.data && typeof response.data === "object" ? response.data as Record<string, unknown> : undefined;
    if (data?.code === 230011 || data?.code === 231003) return true;
    current = item.cause;
  }
  return false;
}

export type FeishuCommandName = "new" | "quota" | "reminders" | "model" | "help" | "start" | "stop";

const MENU_COMMANDS: Record<string, FeishuCommandName> = {
  新建会话: "new",
  剩余额度: "quota",
  当前提醒: "reminders",
  切换模型: "model",
  帮助: "help",
};

const MENU_EVENT_COMMANDS: Record<string, FeishuCommandName> = {
  new: "new",
  new_session: "new",
  new_conversation: "new",
  quota: "quota",
  remaining_quota: "quota",
  reminders: "reminders",
  reminder: "reminders",
  current_reminders: "reminders",
  current_reminder: "reminders",
  model: "model",
  models: "model",
  switch_model: "model",
  change_model: "model",
  新建会话: "new",
  剩余额度: "quota",
  当前提醒: "reminders",
  切换模型: "model",
};

export function parseFeishuMenuEventKey(eventKey: string | undefined): FeishuCommandName | null {
  const key = eventKey?.trim();
  return key ? MENU_EVENT_COMMANDS[key] || MENU_EVENT_COMMANDS[key.toLowerCase()] || null : null;
}

export function parseFeishuCommand(content: string): { name: string; arg: string } | null {
  const text = content.trim();
  if (MENU_COMMANDS[text]) return { name: MENU_COMMANDS[text], arg: "" };
  const match = text.match(/^\/(\w+)(?:\s+([\s\S]+))?$/);
  return match ? { name: match[1].toLowerCase(), arg: (match[2] || "").trim() } : null;
}

export type FeishuModelAction = { action: "providers" } | { action: "models"; provider: string; page: number } | { action: "set_model"; key: string };
export function parseFeishuModelAction(value: unknown): FeishuModelAction | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.action === "providers") return { action: "providers" };
  if (item.action === "models" && typeof item.provider === "string" && Number.isSafeInteger(item.page) && Number(item.page) >= 0) return { action: "models", provider: item.provider, page: Number(item.page) };
  if (item.action === "set_model" && typeof item.key === "string") return { action: "set_model", key: item.key };
  return null;
}

function button(text: string, value: FeishuModelAction, primary = false): object {
  return { tag: "button", text: { tag: "plain_text", content: text }, type: primary ? "primary" : "default", behaviors: [{ type: "callback", value }] };
}

export function feishuModelPickerCard(models: readonly string[], current: string, provider?: string, page = 0, pageSize = 8): object {
  const sorted = [...models].sort((a, b) => a.localeCompare(b));
  const providers = Array.from(new Set(sorted.map((key) => key.split("/", 1)[0]))).sort();
  const elements: object[] = [{ tag: "markdown", content: `当前模型：**${current}**` }];
  if (!provider) {
    elements.push(...providers.map((name) => button(name, { action: "models", provider: name, page: 0 }, current.startsWith(`${name}/`))));
  } else {
    const choices = sorted.filter((key) => key.startsWith(`${provider}/`));
    const pages = Math.max(1, Math.ceil(choices.length / pageSize));
    const safePage = Math.min(page, pages - 1);
    elements.push({ tag: "markdown", content: `提供方：**${provider}** · 第 ${safePage + 1}/${pages} 页` });
    elements.push(...choices.slice(safePage * pageSize, (safePage + 1) * pageSize).map((key) => button(key.slice(provider.length + 1), { action: "set_model", key }, key === current)));
    if (safePage > 0) elements.push(button("上一页", { action: "models", provider, page: safePage - 1 }));
    if (safePage + 1 < pages) elements.push(button("下一页", { action: "models", provider, page: safePage + 1 }));
    elements.push(button("返回提供方", { action: "providers" }));
  }
  if (!providers.length) elements.push({ tag: "markdown", content: "暂无可用模型。" });
  return { schema: "2.0", config: { update_multi: true }, header: { title: { tag: "plain_text", content: "选择模型" }, template: "blue" }, body: { elements } };
}

export function feishuModelSelectedCard(key: string): object {
  return { schema: "2.0", header: { title: { tag: "plain_text", content: "模型已切换" }, template: "green" }, body: { elements: [{ tag: "markdown", content: `当前 Pi 模型：**${key}**` }] } };
}
