import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/bot/app/types";
import { buildEventRecord, createEventRecord, pruneInactiveEventRecords, readEventRecords } from "../src/bot/operations/events/store";
import { getCurrentOccurrence, normalizeRecurrence, scheduleEventScheduleSummary } from "../src/bot/operations/events";
import { buildEventScheduleFromExternal } from "../src/bot/operations/events/schedule_parser";
import { runEventTask, type TaskRecord } from "../src/bot/operations/events/task-actions";
import { prepareScheduleDeliveryText, clearPreparedScheduleDeliveryText, isPreparedScheduleDeliveryTextUsable, nextPendingScheduleInstance } from "../src/bot/operations/events/preparation";

const tempDirs: string[] = [];

function createTestConfig(repoRoot: string): AppConfig {
  return {
    telegram: {
      botToken: "test",
      adminUserId: 1,
      waitingMessages: [],
      waitingMessageRotationSeconds: 5,
      inputMergeWindowSeconds: 3,
      menuPageSize: 10,
    },
    bot: {
      personaStyle: "",
      language: "zh-CN",
      defaultTimezone: "Asia/Tokyo",
    },
    paths: {
      repoRoot,
      tmpDir: path.join(repoRoot, "tmp"),
      uploadSubdir: "uploads",
      logFile: path.join(repoRoot, "logs", "bot.log"),
      stateFile: path.join(repoRoot, "system", "state.json"),
    },
    maintenance: {
      enabled: false,
      idleAfterMs: 0,
      tmpRetentionDays: 1,
    },
  };
}

async function createTempConfig(): Promise<AppConfig> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-test-"));
  tempDirs.push(repoRoot);
  await mkdir(path.join(repoRoot, "system"), { recursive: true });
  await mkdir(path.join(repoRoot, "logs"), { recursive: true });
  return createTestConfig(repoRoot);
}

function makeTask(payload: Record<string, unknown>, requesterUserId = 1): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: "tsk_test",
    state: "queued",
    domain: "events",
    operation: "delete",
    payload,
    source: { requesterUserId },
    createdAt: now,
    updatedAt: now,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("schedule task matching", () => {
  test("带具体年份的事件即使误传 yearly 也会落成一次性提醒", () => {
    const schedule = buildEventScheduleFromExternal({
      kind: "yearly",
      year: 2026,
      month: 4,
      day: 28,
      time: "10:00",
    }, "Asia/Tokyo");

    expect(schedule.kind).toBe("once");
    if (schedule.kind === "once") {
      expect(schedule.scheduledAt).toBe("2026-04-28T01:00:00.000Z");
    }
  });

  test("测试语句：删除 4/7 那个提醒 -> can delete by title + scheduledDate", async () => {
    const config = await createTempConfig();
    const event = buildEventRecord(config, {
      title: "组会提醒",
      timeSemantics: "absolute",
      timezone: "Asia/Tokyo",
      schedule: { kind: "once", scheduledAt: "2026-04-07T06:00:00.000Z" },
      reminders: [{ id: "n1", offsetMinutes: -1440, enabled: true }],
      targets: [{ targetKind: "user", targetId: 872940661 }],
    }, "Asia/Tokyo");
    await createEventRecord(event, config);

    const result = await runEventTask(config, makeTask({
      match: {
        title: "组会提醒",
        scheduledDate: "2026-04-07",
      },
    }));

    expect(result.changed).toBe(true);
    const events = await readEventRecords(config);
    expect(events.find((item) => item.id === event.id)?.status).toBe("deleted");
  });

  test("测试语句：删除 4/7 15:00 的组会提醒 -> local scheduledAt matches stored UTC schedule", async () => {
    const config = await createTempConfig();
    const event = buildEventRecord(config, {
      title: "组会提醒",
      timeSemantics: "absolute",
      timezone: "Asia/Tokyo",
      schedule: { kind: "once", scheduledAt: "2026-04-07T06:00:00.000Z" },
      reminders: [{ id: "n1", offsetMinutes: -1440, enabled: true }],
      targets: [{ targetKind: "user", targetId: 872940661 }],
    }, "Asia/Tokyo");
    await createEventRecord(event, config);

    const result = await runEventTask(config, makeTask({
      match: {
        title: "组会提醒",
        scheduledAt: "2026-04-07T15:00:00",
      },
    }));

    expect(result.changed).toBe(true);
    const events = await readEventRecords(config);
    expect(events.find((item) => item.id === event.id)?.status).toBe("deleted");
  });

  test("测试语句：删除 4/7 那个提醒，不应误删别的提醒", async () => {
    const config = await createTempConfig();
    const april7 = buildEventRecord(config, {
      title: "组会提醒",
      timeSemantics: "absolute",
      timezone: "Asia/Tokyo",
      schedule: { kind: "once", scheduledAt: "2026-04-07T06:00:00.000Z" },
      reminders: [{ id: "n1", offsetMinutes: -1440, enabled: true }],
      targets: [{ targetKind: "user", targetId: 872940661 }],
    }, "Asia/Tokyo");
    const april8 = buildEventRecord(config, {
      title: "组会",
      timeSemantics: "absolute",
      timezone: "Asia/Tokyo",
      schedule: { kind: "once", scheduledAt: "2026-04-08T06:00:00.000Z" },
      reminders: [{ id: "n1", offsetMinutes: -60, enabled: true }],
      targets: [{ targetKind: "user", targetId: 872940661 }],
    }, "Asia/Tokyo");
    await createEventRecord(april7, config);
    await createEventRecord(april8, config);

    const result = await runEventTask(config, makeTask({
      match: {
        title: "组会提醒",
        scheduledDate: "2026-04-07",
      },
    }));

    expect(result.changed).toBe(true);
    const events = await readEventRecords(config);
    expect(events.find((item) => item.id === april7.id)?.status).toBe("deleted");
    expect(events.find((item) => item.id === april8.id)?.status).toBe("active");
  });

  test("删除提醒支持按 id 精确匹配", async () => {
    const config = await createTempConfig();
    const event = buildEventRecord(config, {
      title: "4月28日组会",
      timeSemantics: "absolute",
      timezone: "Asia/Tokyo",
      schedule: { kind: "once", scheduledAt: "2026-04-28T01:00:00.000Z" },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 872940661 }],
    }, "Asia/Tokyo");
    await createEventRecord(event, config);

    const byId = await runEventTask(config, makeTask({ match: { id: event.id } }));
    expect(byId.changed).toBe(true);

    const recreated = buildEventRecord(config, {
      title: "4月28日组会",
      timeSemantics: "absolute",
      timezone: "Asia/Tokyo",
      schedule: { kind: "once", scheduledAt: "2026-04-28T01:00:00.000Z" },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 872940661 }],
    }, "Asia/Tokyo");
    await createEventRecord(recreated, config);

    const byRecreatedId = await runEventTask(config, makeTask({ match: { id: recreated.id } }));
    expect(byRecreatedId.changed).toBe(true);
  });

  test("已过时但仍 active 的一次性提醒不会被启动/maintainer 清理提前删掉", { timeout: 15000 }, async () => {
    const config = await createTempConfig();
    const event = buildEventRecord(config, {
      title: "错过时段后仍需补发的提醒",
      timeSemantics: "absolute",
      timezone: "Asia/Tokyo",
      schedule: { kind: "once", scheduledAt: "2020-01-01T00:00:00.000Z" },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 872940661 }],
      status: "active",
    }, "Asia/Tokyo");
    await createEventRecord(event, config);

    const result = await pruneInactiveEventRecords(config);

    expect(result.removed).toBe(0);
    const events = await readEventRecords(config);
    expect(events.find((item) => item.id === event.id)?.status).toBe("active");
  });

  test("paused 的周期提醒不会被 maintainer 清理掉", async () => {
    const config = await createTempConfig();
    const event = buildEventRecord(config, {
      title: "每周买菜",
      timeSemantics: "local",
      timezone: "Asia/Tokyo",
      schedule: { kind: "weekly", every: 1, daysOfWeek: [5], time: { hour: 18, minute: 0 } },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 872940661 }],
      status: "paused",
    }, "Asia/Tokyo");
    await createEventRecord(event, config);

    const result = await pruneInactiveEventRecords(config);

    expect(result.removed).toBe(0);
    const events = await readEventRecords(config);
    expect(events.find((item) => item.id === event.id)?.status).toBe("paused");
  });

  test("已完成而 paused 的过期一次性提醒可以被清理", async () => {
    const config = await createTempConfig();
    const event = buildEventRecord(config, {
      title: "已完成提醒",
      timeSemantics: "absolute",
      timezone: "Asia/Tokyo",
      schedule: { kind: "once", scheduledAt: "2020-01-01T00:00:00.000Z" },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 872940661 }],
      status: "paused",
    }, "Asia/Tokyo");
    await createEventRecord(event, config);

    const result = await pruneInactiveEventRecords(config);

    expect(result.removed).toBe(1);
    expect(result.removedIds).toContain(event.id);
    const events = await readEventRecords(config);
    expect(events.find((item) => item.id === event.id)).toBeUndefined();
  });

  test("显式闰月提醒默认只在闰月触发", async () => {
    const recurrence = normalizeRecurrence({ kind: "lunarYearly", month: 8, day: 15, isLeapMonth: true });
    expect(recurrence.kind).toBe("lunarYearly");
    if (recurrence.kind === "lunarYearly") {
      expect(recurrence.isLeapMonth).toBe(true);
      expect(recurrence.leapMonthPolicy).toBe("same-leap-only");
    }
  });

  test("allowed requester can create a self schedule at task layer", async () => {
    const config = await createTempConfig();
    await writeFile(path.join(config.paths.repoRoot, "system", "users.json"), JSON.stringify({
      users: {
        "2": { username: "allowed_test", displayName: "Allowed", accessLevel: "allowed", timezone: "Asia/Tokyo" }
      },
    }, null, 2) + "\n", "utf8");

    const now = new Date().toISOString();
    const result = await runEventTask(config, {
      id: "tsk_allowed_create",
      state: "queued",
      domain: "events",
      operation: "create",
      payload: {
        title: "allowed提醒",
        schedule: { kind: "once", scheduledAt: "2026-04-05T21:00:00" },
      },
      source: { requesterUserId: 2 },
      createdAt: now,
      updatedAt: now,
    });

    expect(result.changed).toBe(true);
    const events = await readEventRecords(config);
    const created = events.find((item) => item.title === "allowed提醒");
    expect(Boolean(created)).toBe(true);
    expect(created?.targets).toEqual([{ targetKind: "user", targetId: 2 }]);
  });

  test("trusted requester can still create a self schedule in requester timezone via upsert", async () => {
    const config = await createTempConfig();
    await writeFile(path.join(config.paths.repoRoot, "system", "users.json"), JSON.stringify({
      users: {
        "872940661": { username: "trusted_test", displayName: "Trusted", accessLevel: "trusted", timezone: "Asia/Tokyo" }
      },
    }, null, 2) + "\n", "utf8");
    const now = new Date().toISOString();
    const result = await runEventTask(config, {
      id: "tsk_upsert_create",
      state: "queued",
      domain: "events",
      operation: "upsert",
      payload: {
        title: "review论文",
        schedule: { kind: "once", scheduledAt: "2026-04-05T21:00:00" },
      },
      source: { requesterUserId: 872940661 },
      createdAt: now,
      updatedAt: now,
    });

    expect(result.changed).toBe(true);
    const events = await readEventRecords(config);
    const created = events.find((item) => item.title.includes("review"));
    expect(Boolean(created)).toBe(true);
    expect(created?.targets).toEqual([{ targetKind: "user", targetId: 872940661 }]);
    expect(created?.schedule.kind).toBe("once");
    if (created?.schedule.kind === "once") {
      expect(created.schedule.scheduledAt).toBe("2026-04-05T12:00:00.000Z");
    }
  });

  test("特殊提醒的语义由 category + specialKind 表达，不再和顶层 kind 重复", async () => {
    const config = await createTempConfig();
    const event = buildEventRecord(config, {
      title: "妈妈生日",
      specialKind: "birthday",
      timeSemantics: "local",
      timezone: "Asia/Tokyo",
      schedule: { kind: "yearly", every: 1, month: 6, day: 1, time: { hour: 8, minute: 0 } },
      targets: [{ targetKind: "user", targetId: 872940661 }],
    }, "Asia/Tokyo");
    expect(event.specialKind).toBe("birthday");
    expect(event.category).toBe("special");
  });

  test("农历年度提醒可以正常计算下一次 occurrence", async () => {
    const config = await createTempConfig();
    const event = buildEventRecord(config, {
      title: "中秋赏月",
      timeSemantics: "local",
      timezone: "Asia/Tokyo",
      schedule: { kind: "lunarYearly", month: 8, day: 15, time: { hour: 20, minute: 0 } },
      reminders: [{ id: "n1", offsetMinutes: -60, enabled: true }],
      targets: [{ targetKind: "user", targetId: 872940661 }],
    }, "Asia/Tokyo");
    await createEventRecord(event, config);

    const occurrence = getCurrentOccurrence(event, new Date("2026-01-01T00:00:00.000Z"));
    expect(occurrence).not.toBeNull();
    expect(new Date(String(occurrence?.scheduledAt)).getTime()).toBeGreaterThan(new Date("2026-01-01T00:00:00.000Z").getTime());

  });
});

// ===========================================================================
// Delivery text generation pipeline tests
// ===========================================================================

describe("schedule delivery text pipeline", () => {
  // Helper: mock AiService that records what scheduledAt was passed
  function makeAgentService(reply = "记得喝水！时间：今天21:00") {
    const calls: Array<{ scheduleText: string; scheduledAt: string; recurrenceDescription: string }> = [];
    const agentService = {
      generateReminderText: async (scheduleText: string, scheduledAt: string, recurrenceDescription: string) => {
        calls.push({ scheduleText, scheduledAt, recurrenceDescription });
        return reply;
      },
      generateScheduledTaskContent: async () => reply,
    } as any;
    return { agentService, calls };
  }

  test("text is generated with the exact notifyAt timestamp of the target reminder instance", async () => {
    const config = await createTempConfig();
    // Schedule fires at 2026-05-01T12:00:00Z, one-time
    const event = buildEventRecord(config, {
      title: "喝水",
      timeSemantics: "absolute",
      timezone: "Asia/Tokyo",
      schedule: { kind: "once", scheduledAt: "2026-05-01T12:00:00.000Z" },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 1 }],
    }, "Asia/Tokyo");
    await createEventRecord(event, config);

    const { agentService, calls } = makeAgentService("记得喝水！");
    const now = new Date("2026-04-30T00:00:00.000Z"); // before fire time — once schedule always prepares
    const changed = await prepareScheduleDeliveryText(config, agentService, event, now);

    expect(changed).toBe(true);
    expect(event.deliveryText).toBe("记得喝水！");
    expect(event.deliveryPreparedNotifyAt).toBe("2026-05-01T12:00:00.000Z");
    expect(event.deliveryPreparedReminderId).toBe("n1");
    // The AI was called with the exact notifyAt timestamp
    expect(calls).toHaveLength(1);
    expect(calls[0]!.scheduledAt).toBe("2026-05-01T12:00:00.000Z");
  });

  test("cached text is only usable for the matching reminder instance", async () => {
    const config = await createTempConfig();
    const event = buildEventRecord(config, {
      title: "开会",
      timeSemantics: "absolute",
      timezone: "Asia/Tokyo",
      schedule: { kind: "once", scheduledAt: "2026-05-02T09:00:00.000Z" },
      reminders: [
        { id: "n-1d", offsetMinutes: -1440, enabled: true, label: "提前1天" },
        { id: "n-now", offsetMinutes: 0, enabled: true, label: "准时" },
      ],
      targets: [{ targetKind: "user", targetId: 1 }],
    }, "Asia/Tokyo");

    // Simulate text prepared for the pre-reminder (24h before)
    event.deliveryText = "明天9点有会议，提前提醒";
    event.deliveryTextGeneratedAt = new Date().toISOString();
    event.deliveryPreparedReminderId = "n-1d";
    event.deliveryPreparedNotifyAt = "2026-05-01T09:00:00.000Z"; // 24h before

    const preInstance = { reminderId: "n-1d", offsetMinutes: -1440, notifyAt: "2026-05-01T09:00:00.000Z" };
    const nowInstance = { reminderId: "n-now", offsetMinutes: 0, notifyAt: "2026-05-02T09:00:00.000Z" };

    // Pre-reminder text IS usable for its own instance
    expect(isPreparedScheduleDeliveryTextUsable(event, preInstance)).toBe(true);
    // Pre-reminder text is NOT usable for the on-time reminder
    expect(isPreparedScheduleDeliveryTextUsable(event, nowInstance)).toBe(false);
  });

  test("text is regenerated when schedule changes (cache is cleared)", async () => {
    const config = await createTempConfig();
    const event = buildEventRecord(config, {
      title: "跑步",
      timeSemantics: "absolute",
      timezone: "Asia/Tokyo",
      schedule: { kind: "once", scheduledAt: "2026-05-03T07:00:00.000Z" },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 1 }],
    }, "Asia/Tokyo");

    // Pre-populate with stale text
    event.deliveryText = "旧文本";
    event.deliveryPreparedReminderId = "n1";
    event.deliveryPreparedNotifyAt = "2026-05-03T07:00:00.000Z";
    event.deliveryTextGeneratedAt = new Date().toISOString();

    // Clearing should remove all fields
    const cleared = clearPreparedScheduleDeliveryText(event);
    expect(cleared).toBe(true);
    expect(event.deliveryText).toBeUndefined();
    expect(event.deliveryPreparedReminderId).toBeUndefined();
    expect(event.deliveryPreparedNotifyAt).toBeUndefined();

    // Now generate fresh text for the updated schedule
    const { agentService, calls } = makeAgentService("快去跑步！");
    const changed = await prepareScheduleDeliveryText(config, agentService, event, new Date("2026-04-30T00:00:00.000Z"));
    expect(changed).toBe(true);
    expect(event.deliveryText).toBe("快去跑步！");
    expect(calls).toHaveLength(1);
  });

  test("delivery: prepared text is usable and replaces fallback when notifyAt matches", async () => {
    // Tests the delivery.ts logic: isPreparedScheduleDeliveryTextUsable check used in deliverDueSchedules
    const config = await createTempConfig();
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    const event = buildEventRecord(config, {
      title: "测试提醒",
      timeSemantics: "absolute",
      timezone: "Asia/Tokyo",
      schedule: { kind: "once", scheduledAt: pastTime },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 1 }],
    }, "Asia/Tokyo");

    // Pre-populate delivery text matching the notifyAt
    event.deliveryText = "提前生成的文本";
    event.deliveryPreparedReminderId = "n1";
    event.deliveryPreparedNotifyAt = pastTime;
    event.deliveryTextGeneratedAt = new Date().toISOString();

    // The delivery logic checks isPreparedScheduleDeliveryTextUsable before choosing text
    const instance = { reminderId: "n1", offsetMinutes: 0, notifyAt: pastTime };
    expect(isPreparedScheduleDeliveryTextUsable(event, instance)).toBe(true);
    // A different notifyAt (wrong instance) must not use the cached text
    const otherInstance = { reminderId: "n1", offsetMinutes: 0, notifyAt: new Date(Date.now() + 3600_000).toISOString() };
    expect(isPreparedScheduleDeliveryTextUsable(event, otherInstance)).toBe(false);
  });

  test("delivery: when no pre-generated text, isPreparedScheduleDeliveryTextUsable returns false (fallback triggered)", () => {
    // Tests that delivery.ts falls back to renderMessage when no text is cached
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    const event = {
      id: "test-id",
      title: "无预生成文本的提醒",
      timeSemantics: "absolute" as const,
      timezone: "Asia/Tokyo",
      schedule: { kind: "once" as const, scheduledAt: pastTime },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user" as const, targetId: 1 }],
      status: "active" as const,
      createdAt: new Date().toISOString(),
      // No deliveryText
    };

    const instance = { reminderId: "n1", offsetMinutes: 0, notifyAt: pastTime };
    // Without pre-generated text, the check returns false → delivery code falls back to renderMessage
    expect(isPreparedScheduleDeliveryTextUsable(event as any, instance)).toBe(false);
  });

  test("periodic schedule text is only prepared within the 24h prewarm window", async () => {
    const config = await createTempConfig();
    // Weekly schedule firing next Monday at 9am Tokyo (far in future)
    const event = buildEventRecord(config, {
      title: "每周例会",
      timeSemantics: "local",
      timezone: "Asia/Tokyo",
      schedule: { kind: "weekly", every: 1, daysOfWeek: [1], time: { hour: 9, minute: 0 } },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 1 }],
    }, "Asia/Tokyo");

    const { agentService, calls } = makeAgentService("周会时间到！");

    // Far in the future (> 24h): should NOT generate
    const farFuture = new Date("2026-01-01T00:00:00.000Z"); // well before next occurrence
    const nextInstance = nextPendingScheduleInstance(event, farFuture);
    if (nextInstance) {
      const notifyAt = Date.parse(nextInstance.notifyAt);
      const notWithinWindow = notifyAt - farFuture.getTime() > 24 * 60 * 60 * 1000;
      if (notWithinWindow) {
        const changed = await prepareScheduleDeliveryText(config, agentService, event, farFuture);
        expect(changed).toBe(false);
        expect(calls).toHaveLength(0); // AI not called when outside prewarm window
      }
    }
  });

  test("schedule-change via update task causes stale cache — text not usable for new schedule", async () => {
    const config = await createTempConfig();
    const event = buildEventRecord(config, {
      title: "修改时间测试",
      timeSemantics: "absolute",
      timezone: "Asia/Tokyo",
      schedule: { kind: "once", scheduledAt: "2026-06-01T09:00:00.000Z" },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 1 }],
    }, "Asia/Tokyo");

    // Pre-populate cache and occurrence state for original schedule
    event.deliveryText = "原时间的提醒文本";
    event.deliveryPreparedReminderId = "n1";
    event.deliveryPreparedNotifyAt = "2026-06-01T09:00:00.000Z";
    event.deliveryTextGeneratedAt = new Date().toISOString();
    event.deliveryState = { currentOccurrence: { scheduledAt: "2026-06-01T09:00:00.000Z", sentReminderIds: [] } };
    await createEventRecord(event, config);

    // Update the schedule via runEventTask
    const now = new Date().toISOString();
    const updateTask: TaskRecord = {
      id: "tsk_update",
      state: "queued",
      domain: "events",
      operation: "update",
      payload: {
        match: { title: "修改时间测试" },
        changes: { schedule: { kind: "once", scheduledAt: "2026-06-15T09:00:00.000Z" } },
      },
      source: { requesterUserId: 1 },
      createdAt: now,
      updatedAt: now,
    };
    await runEventTask(config, updateTask);

    const events = await readEventRecords(config);
    const updated = events.find((e) => e.title === "修改时间测试");
    expect(updated).toBeDefined();
    // Schedule has changed to June 15
    expect(updated?.schedule.kind).toBe("once");
    if (updated?.schedule.kind === "once") {
      expect(updated.schedule.scheduledAt).toContain("2026-06-15");
    }
    expect(updated?.deliveryText).toBeUndefined();
    expect(updated?.deliveryPreparedReminderId).toBeUndefined();
    expect(updated?.deliveryPreparedNotifyAt).toBeUndefined();
    expect(updated?.deliveryTextGeneratedAt).toBeUndefined();
    expect(updated?.deliveryState?.currentOccurrence?.scheduledAt).toContain("2026-06-15");
  });
});
