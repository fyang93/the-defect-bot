import { logger } from "bot/app/logger";
import { state } from "bot/app/state";
import { resolveChat, resolveUser } from "bot/operations/context/store";

export type SyncTask = {
  repoRoot: string;
  subject: "user" | "chat";
  operation: "refresh";
  selector: {
    userId?: string;
    chatId?: string;
  };
};

const queue: SyncTask[] = [];
const queuedKeys = new Set<string>();
let scheduled = false;
let running = false;

function syncTaskLabel(task: SyncTask): string {
  return `subject=${task.subject} operation=${task.operation} selector=${JSON.stringify(task.selector)}`;
}

function taskKey(task: SyncTask): string {
  if (task.subject === "user" && task.operation === "refresh" && task.selector.userId) {
    return `${task.subject}:${task.operation}:${task.selector.userId}`;
  }
  if (task.subject === "chat" && task.operation === "refresh" && task.selector.chatId) {
    return `${task.subject}:${task.operation}:${task.selector.chatId}`;
  }
  return `${task.subject}:${task.operation}:${JSON.stringify(task.selector)}`;
}

function scheduleDrain(): void {
  if (scheduled || running) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    void drainQueue();
  }, 0);
}

async function processUserRefresh(task: SyncTask): Promise<void> {
  const userId = task.selector.userId;
  if (!userId) return;
  const canonical = resolveUser(task.repoRoot, userId);
  if (!canonical) return;
  const current = state.feishuUserCache[userId];
  state.feishuUserCache[userId] = {
    displayName: canonical.displayName || current?.displayName || userId,
    lastSeenAt: canonical.lastSeenAt || current?.lastSeenAt || new Date().toISOString(),
  };
  if (canonical.timezone) {
    state.userTimezoneCache[userId] = {
      timezone: canonical.timezone,
      updatedAt: canonical.updatedAt || new Date().toISOString(),
    };
  }
}

async function processChatRefresh(task: SyncTask): Promise<void> {
  const chatId = task.selector.chatId;
  if (!chatId) return;
  const canonical = resolveChat(task.repoRoot, chatId);
  if (!canonical) return;
  const current = state.feishuChatCache[chatId];
  state.feishuChatCache[chatId] = {
    type: canonical.type || current?.type || "group",
    title: canonical.title ?? current?.title,
    lastSeenAt: canonical.lastSeenAt || current?.lastSeenAt || new Date().toISOString(),
  };
}

async function processTask(task: SyncTask): Promise<void> {
  if (task.subject === "user" && task.operation === "refresh") return processUserRefresh(task);
  if (task.subject === "chat" && task.operation === "refresh") return processChatRefresh(task);
}

async function drainQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) continue;
      queuedKeys.delete(taskKey(task));
      try {
        await processTask(task);
      } catch (error) {
        await logger.warn(`sync task failed ${syncTaskLabel(task)} error=${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    running = false;
    if (queue.length > 0) scheduleDrain();
  }
}

export function enqueueSync(task: SyncTask): void {
  const key = taskKey(task);
  if (queuedKeys.has(key)) return;
  queuedKeys.add(key);
  queue.push(task);
  scheduleDrain();
}
