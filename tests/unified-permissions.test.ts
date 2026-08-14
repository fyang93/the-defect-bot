import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/bot/app/types";
import { readEventRecords } from "../src/bot/operations/events/store";
import { resolveEventsByMatch, runEventTask, type TaskRecord } from "../src/bot/operations/events/task-actions";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function config(): AppConfig {
  const root = mkdtempSync(path.join(os.tmpdir(), "defect-unified-")); roots.push(root);
  return {
    feishu: { appId: "cli_test", appSecret: "secret", inputMergeWindowSeconds: 0, menuPageSize: 8 },
    bot: { personaStyle: "", language: "zh-CN", defaultTimezone: "UTC" },
    paths: { repoRoot: root, tmpDir: path.join(root, "tmp"), uploadSubdir: "feishu", logFile: path.join(root, "logs/bot.log"), stateFile: path.join(root, "system/state.json") },
    maintenance: { enabled: false, idleAfterMs: 0, tmpRetentionDays: 7 },
  };
}
function task(userId: string, title: string, targetId: string): TaskRecord {
  const now = new Date().toISOString();
  return { id: `t-${userId}`, state: "queued", domain: "events", operation: "create", payload: { title, schedule: { kind: "once", scheduledAt: "2035-01-01T10:00:00Z" }, reminders: [{ id: "now", offsetMinutes: 0 }], targets: [{ targetKind: "user", targetId }] }, source: { requesterUserId: userId }, createdAt: now, updatedAt: now };
}

describe("unified user capabilities", () => {
  test("any user can create a schedule for any Feishu target", async () => {
    const app = config();
    expect((await runEventTask(app, task("ou_sender", "跨用户提醒", "ou_target"))).changed).toBe(true);
    const [event] = await readEventRecords(app);
    expect(event.createdByUserId).toBe("ou_sender");
    expect(event.targets).toEqual([{ targetKind: "user", targetId: "ou_target" }]);
  });

  test("every requester can list and manage all schedules", async () => {
    const app = config();
    await runEventTask(app, task("ou_a", "共享日程", "ou_a"));
    const resolved = await resolveEventsByMatch(app, { requesterUserId: "ou_b", match: { title: "共享日程" } });
    expect(resolved.events).toHaveLength(1);
    expect(resolved.events[0].createdByUserId).toBe("ou_a");
  });

  test("mutations accept eventId and reject unsafe matches", async () => {
    const app = config();
    await runEventTask(app, task("ou_a", "生日提醒", "ou_a"));
    await runEventTask(app, task("ou_a", "生日提醒", "ou_a"));
    const [first] = await readEventRecords(app);
    const update = (match: Record<string, unknown>, title: string): TaskRecord => ({
      id: `update-${title}`,
      state: "queued",
      domain: "events",
      operation: "update",
      payload: { match, changes: { title } },
      source: { requesterUserId: "ou_a" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect((await runEventTask(app, update({ typoId: first.id }, "不应写入"))).reason).toBe("invalid-schedule-match");
    expect((await runEventTask(app, update({ title: "生日提醒" }, "也不应写入"))).reason).toBe("schedule-ambiguous");
    expect((await runEventTask(app, update({ eventId: first.id }, "正确姓名"))).changed).toBe(true);
    expect((await readEventRecords(app)).map((event) => event.title)).toEqual(["正确姓名", "生日提醒"]);
  });
});
