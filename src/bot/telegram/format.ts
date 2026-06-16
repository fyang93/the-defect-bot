import type { Bot, Context, InlineKeyboard } from "grammy";
import MarkdownIt from "markdown-it";
import { sendTelegramWithRetry } from "./send-retry";

export { isTransientTelegramNetworkError, sendTelegramWithRetry } from "./send-retry";

type TelegramFormatOptions = {
  reply_markup?: InlineKeyboard;
  parse_mode?: "HTML";
};

type MarkdownToken = {
  type: string;
  tag: string;
  nesting: number;
  content: string;
  attrs?: Array<[string, string]> | null;
  children?: MarkdownToken[] | null;
  info?: string;
  level?: number;
};

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
});

function isTelegramFormattingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /can't parse entities|entity .* parsing|unsupported start tag|Bad Request: .*parse|message text is empty/i.test(message);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replaceAll("'", "&#39;");
}

function repeat(text: string, count: number): string {
  return Array.from({ length: Math.max(0, count) }, () => text).join("");
}

function padRight(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - text.length));
}

function tokenAttr(token: MarkdownToken, name: string): string | null {
  return token.attrs?.find(([key]) => key === name)?.[1] || null;
}

function renderInlineTokens(tokens: MarkdownToken[] | null | undefined): string {
  if (!tokens || tokens.length === 0) return "";
  let output = "";

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    switch (token.type) {
      case "text":
        output += escapeHtml(token.content);
        break;
      case "code_inline":
        output += `<code>${escapeHtml(token.content)}</code>`;
        break;
      case "softbreak":
      case "hardbreak":
        output += "\n";
        break;
      case "strong_open":
        output += "<b>";
        break;
      case "strong_close":
        output += "</b>";
        break;
      case "em_open":
        output += "<i>";
        break;
      case "em_close":
        output += "</i>";
        break;
      case "s_open":
        output += "<s>";
        break;
      case "s_close":
        output += "</s>";
        break;
      case "link_open": {
        const href = tokenAttr(token, "href");
        output += href ? `<a href="${escapeHtmlAttribute(href)}">` : "";
        break;
      }
      case "link_close":
        output += "</a>";
        break;
      case "image": {
        const src = tokenAttr(token, "src");
        const alt = renderInlineTokens(token.children);
        if (src) {
          output += `<a href="${escapeHtmlAttribute(src)}">${alt || escapeHtml(src)}</a>`;
        } else {
          output += alt;
        }
        break;
      }
      default:
        if (token.children?.length) {
          output += renderInlineTokens(token.children);
        } else if (token.content) {
          output += escapeHtml(token.content);
        }
        break;
    }
  }

  return output;
}

function inlineText(tokens: MarkdownToken[] | null | undefined): string {
  if (!tokens || tokens.length === 0) return "";
  return tokens.map((token) => {
    if (token.type === "softbreak" || token.type === "hardbreak") return " ";
    if (token.type === "code_inline" || token.type === "text") return token.content;
    if (token.children?.length) return inlineText(token.children);
    return token.content || "";
  }).join("").replace(/\s+/g, " ").trim();
}

function renderTable(tokens: MarkdownToken[], startIndex: number): { html: string; nextIndex: number } {
  const rows: string[][] = [];
  let currentRow: string[] | null = null;
  let inCell = false;
  let cellBuffer = "";
  let index = startIndex + 1;

  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "table_close") break;
    if (token.type === "tr_open") {
      currentRow = [];
      continue;
    }
    if (token.type === "tr_close") {
      if (currentRow) rows.push(currentRow);
      currentRow = null;
      continue;
    }
    if (token.type === "th_open" || token.type === "td_open") {
      inCell = true;
      cellBuffer = "";
      continue;
    }
    if (token.type === "th_close" || token.type === "td_close") {
      if (currentRow) currentRow.push(cellBuffer.trim());
      inCell = false;
      cellBuffer = "";
      continue;
    }
    if (inCell && token.type === "inline") {
      cellBuffer += inlineText(token.children);
      continue;
    }
    if (inCell && token.type === "code_inline") {
      cellBuffer += token.content;
      continue;
    }
    if (inCell && token.type === "softbreak") {
      cellBuffer += " ";
    }
  }

  if (rows.length === 0) {
    return { html: "", nextIndex: index };
  }

  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, columnIndex) => {
    return Math.max(...rows.map((row) => (row[columnIndex] || "").length));
  });
  const rendered = rows.map((row, rowIndex) => {
    const line = widths.map((width, columnIndex) => padRight(row[columnIndex] || "", width)).join(" | ");
    if (rowIndex === 0) {
      return `${line}\n${widths.map((width) => repeat("-", Math.max(3, width))).join("-+-")}`;
    }
    return line;
  }).join("\n");

  return { html: `<pre>${escapeHtml(rendered)}</pre>`, nextIndex: index };
}

function renderBlockquote(tokens: MarkdownToken[], startIndex: number): { html: string; nextIndex: number } {
  const nested: MarkdownToken[] = [];
  let depth = 1;
  let index = startIndex + 1;

  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "blockquote_open") {
      depth += 1;
    } else if (token.type === "blockquote_close") {
      depth -= 1;
      if (depth === 0) break;
    }
    nested.push(token);
  }

  const rendered = renderBlocks(nested)
    .replace(/<pre><code>/g, "<pre>")
    .replace(/<\/code><\/pre>/g, "</pre>");

  return { html: `<blockquote>${rendered || escapeHtml("")}</blockquote>`, nextIndex: index };
}

function renderBlocks(tokens: MarkdownToken[]): string {
  const blocks: string[] = [];
  const listStack: Array<{ ordered: boolean; next: number }> = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    switch (token.type) {
      case "heading_open": {
        const inline = tokens[index + 1];
        blocks.push(`<b>${renderInlineTokens(inline?.children || [])}</b>`);
        index += 2;
        break;
      }
      case "paragraph_open": {
        const inline = tokens[index + 1];
        blocks.push(renderInlineTokens(inline?.children || []));
        index += 2;
        break;
      }
      case "bullet_list_open":
        listStack.push({ ordered: false, next: 0 });
        break;
      case "ordered_list_open": {
        const start = Number(tokenAttr(token, "start") || "1");
        listStack.push({ ordered: true, next: Number.isFinite(start) ? start : 1 });
        break;
      }
      case "bullet_list_close":
      case "ordered_list_close":
        listStack.pop();
        break;
      case "list_item_open": {
        const depth = Math.max(0, listStack.length - 1);
        const currentList = listStack[listStack.length - 1];
        const marker = currentList?.ordered ? `${currentList.next++}.` : "•";
        const parts: MarkdownToken[] = [];
        let cursor = index + 1;
        let itemDepth = 1;
        for (; cursor < tokens.length; cursor += 1) {
          const next = tokens[cursor];
          if (next.type === "list_item_open") itemDepth += 1;
          if (next.type === "list_item_close") {
            itemDepth -= 1;
            if (itemDepth === 0) break;
          }
          parts.push(next);
        }
        const body = renderBlocks(parts).split("\n").filter(Boolean);
        if (body.length > 0) {
          const indent = "  ".repeat(depth);
          blocks.push(body.map((line, lineIndex) => `${indent}${lineIndex === 0 ? `${marker} ` : "  "}${line}`).join("\n"));
        }
        index = cursor;
        break;
      }
      case "fence":
      case "code_block":
        blocks.push(`<pre><code>${escapeHtml(token.content.replace(/\n$/, ""))}</code></pre>`);
        break;
      case "blockquote_open": {
        const rendered = renderBlockquote(tokens, index);
        blocks.push(rendered.html);
        index = rendered.nextIndex;
        break;
      }
      case "hr":
        blocks.push(escapeHtml("────────────────────────"));
        break;
      case "table_open": {
        const rendered = renderTable(tokens, index);
        if (rendered.html) blocks.push(rendered.html);
        index = rendered.nextIndex;
        break;
      }
      case "html_block":
      case "html_inline":
        if (token.content.trim()) blocks.push(escapeHtml(token.content));
        break;
      case "inline":
        if (token.level === 0) blocks.push(renderInlineTokens(token.children));
        break;
      default:
        break;
    }
  }

  return blocks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function markdownToTelegramHtml(text: string): string {
  const normalized = text.replaceAll("\r\n", "\n");
  const tokens = markdown.parse(normalized, {}) as MarkdownToken[];
  return renderBlocks(tokens) || escapeHtml(normalized);
}

async function withTelegramFormattingFallback<T>(
  send: (text: string, options?: TelegramFormatOptions) => Promise<T>,
  text: string,
  options?: Omit<TelegramFormatOptions, "parse_mode">,
): Promise<T> {
  try {
    return await sendTelegramWithRetry(() => send(markdownToTelegramHtml(text), { ...(options || {}), parse_mode: "HTML" }), "send formatted message");
  } catch (error) {
    if (!isTelegramFormattingError(error)) throw error;
    return sendTelegramWithRetry(() => send(text, options), "send plain message after formatting fallback");
  }
}

export async function replyFormatted(
  ctx: Context,
  text: string,
  options?: { reply_markup?: InlineKeyboard },
): Promise<unknown> {
  return withTelegramFormattingFallback((nextText, nextOptions) => ctx.reply(nextText, nextOptions), text, options);
}

export async function editMessageTextFormatted(
  ctx: Context,
  chatId: number,
  messageId: number,
  text: string,
  options?: { reply_markup?: InlineKeyboard },
): Promise<unknown> {
  return withTelegramFormattingFallback(
    (nextText, nextOptions) => ctx.api.editMessageText(chatId, messageId, nextText, nextOptions),
    text,
    options,
  );
}

export async function sendMessageFormatted(
  bot: Bot<Context>,
  chatId: number,
  text: string,
  options?: { reply_markup?: InlineKeyboard },
): Promise<unknown> {
  return withTelegramFormattingFallback(
    (nextText, nextOptions) => bot.api.sendMessage(chatId, nextText, nextOptions),
    text,
    options,
  );
}
