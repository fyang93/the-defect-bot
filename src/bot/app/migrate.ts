import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./types";

async function rewriteJson(filePath: string, transform: (value: unknown) => unknown): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  let before: unknown;
  try { before = JSON.parse(await readFile(filePath, "utf8")) as unknown; }
  catch { return false; }
  const after = transform(before);
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  await writeFile(filePath, `${JSON.stringify(after, null, 2)}\n`, "utf8");
  return true;
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export async function migrateSystemStateForFeishu(config: AppConfig): Promise<string[]> {
  const changed: string[] = [];
  const system = path.join(config.paths.repoRoot, "system");
  if (await rewriteJson(path.join(system, "state.json"), (value) => {
    const current = record(value);
    return { model: typeof current.model === "string" ? current.model : null, lastMaintainedAt: typeof current.lastMaintainedAt === "string" ? current.lastMaintainedAt : null };
  })) changed.push("system/state.json");
  if (await rewriteJson(path.join(system, "users.json"), (value) => {
    const users = record(record(value).users);
    return { users: Object.fromEntries(Object.entries(users).map(([id, item]) => {
      const { accessLevel: _access, role: _role, roleUpdatedBy: _roleBy, username: _legacyHandle, ...kept } = record(item);
      return [id, kept];
    })) };
  })) changed.push("system/users.json");
  if (await rewriteJson(path.join(system, "chats.json"), (value) => {
    const chats = record(record(value).chats);
    return { chats: Object.fromEntries(Object.entries(chats).map(([id, item]) => {
      const chat = record(item);
      return [id, { ...chat, type: chat.type === "private" ? "p2p" : chat.type === "supergroup" ? "group" : chat.type }];
    })) };
  })) changed.push("system/chats.json");
  if (await rewriteJson(path.join(system, "events.json"), (value) => Array.isArray(value) ? value.map((item) => {
    const event = record(item);
    return {
      ...event,
      ...(event.createdByUserId == null ? {} : { createdByUserId: String(event.createdByUserId) }),
      targets: Array.isArray(event.targets) ? event.targets.map((target) => {
        const targetRecord = record(target);
        return { ...targetRecord, targetId: String(targetRecord.targetId ?? "") };
      }).filter((target) => target.targetId) : [],
    };
  }) : [])) changed.push("system/events.json");
  return changed;
}
