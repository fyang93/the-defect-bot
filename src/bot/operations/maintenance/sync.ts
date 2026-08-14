import { logger } from "bot/app/logger";
import { state } from "bot/app/state";
import { resolveChat, resolveUser } from "bot/operations/context/store";

export type SyncTask = {
  repoRoot: string;
  subject: "user" | "chat";
  operation: "refresh";
  selector: { userId?: string; chatId?: string };
};

export function enqueueSync(task: SyncTask): void {
  try {
    if (task.subject === "user" && task.selector.userId) {
      const id = task.selector.userId;
      const user = resolveUser(task.repoRoot, id);
      if (!user) return;
      const current = state.feishuUserCache[id];
      state.feishuUserCache[id] = {
        displayName: user.displayName || current?.displayName || id,
        lastSeenAt: user.lastSeenAt || current?.lastSeenAt || new Date().toISOString(),
      };
      if (user.timezone) state.userTimezoneCache[id] = { timezone: user.timezone, updatedAt: user.updatedAt || new Date().toISOString() };
      return;
    }
    if (task.subject === "chat" && task.selector.chatId) {
      const id = task.selector.chatId;
      const chat = resolveChat(task.repoRoot, id);
      if (!chat) return;
      const current = state.feishuChatCache[id];
      state.feishuChatCache[id] = {
        type: chat.type || current?.type || "group",
        title: chat.title ?? current?.title,
        lastSeenAt: chat.lastSeenAt || current?.lastSeenAt || new Date().toISOString(),
      };
    }
  } catch (error) {
    void logger.warn(`sync failed subject=${task.subject}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
