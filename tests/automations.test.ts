import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/bot/app/types";
import { buildEventRecord, createEventRecord, getEventRecord, readEventRecords, updateEventRecord } from "../src/bot/operations/events/store";
import { deliverDueSchedules } from "../src/bot/operations/events/delivery";
import { buildScheduledTaskPrompt, prepareScheduleDeliveryText, prepareScheduleDeliveryTextAndPersistIfUnchanged, shouldGenerateScheduledTaskOnDelivery, shouldPrepareScheduleDeliveryText } from "../src/bot/operations/events/preparation";
import { runEventTask, type TaskRecord } from "../src/bot/operations/events/task-actions";
import type { EventRecord, ReminderInstance } from "../src/bot/operations/events/types";

const tempDirs: string[] = [];

function createTestConfig(repoRoot: string): AppConfig {
  return {
    telegram: {
      botToken: "test",
      adminUserId: 1,
      waitingMessage: "",
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
    operation: "upsert",
    payload,
    source: { requesterUserId },
    createdAt: now,
    updatedAt: now,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("automation category", () => {
  test("buildEventRecord preserves category='automation'", async () => {
    const config = await createTempConfig();
    const event = buildEventRecord(config, {
      title: "每日新闻",
      note: "获取今日科技新闻摘要",
      category: "automation",
      timeSemantics: "local",
      timezone: "Asia/Tokyo",
      schedule: { kind: "weekly", every: 1, daysOfWeek: [1, 2, 3, 4, 5], time: { hour: 9, minute: 0 } },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 1 }],
    }, "Asia/Tokyo");

    expect(event.category).toBe("automation");
    expect(event.note).toBe("获取今日科技新闻摘要");
    expect(event.title).toBe("每日新闻");
  });

  test("buildEventRecord synthesizes a automation prompt when note is missing", async () => {
    const config = await createTempConfig();
    const event = buildEventRecord(config, {
      title: "每日新闻简报",
      category: "automation",
      timeSemantics: "local",
      timezone: "Asia/Tokyo",
      schedule: { kind: "weekly", every: 1, daysOfWeek: [1, 2, 3, 4, 5], time: { hour: 9, minute: 0 } },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 1 }],
    }, "Asia/Tokyo");

    expect(event.note).toBe(buildScheduledTaskPrompt("每日新闻简报"));
    expect(shouldGenerateScheduledTaskOnDelivery(event)).toBe(true);
  });

  test("buildEventRecord still assigns 'special' for specialKind events", async () => {
    const config = await createTempConfig();
    const event = buildEventRecord(config, {
      title: "妈妈生日",
      specialKind: "birthday",
      timeSemantics: "local",
      timezone: "Asia/Tokyo",
      schedule: { kind: "yearly", every: 1, month: 6, day: 1, time: { hour: 8, minute: 0 } },
      targets: [{ targetKind: "user", targetId: 1 }],
    }, "Asia/Tokyo");

    expect(event.category).toBe("special");
  });

  test("buildEventRecord assigns 'routine' for routine category", async () => {
    const config = await createTempConfig();
    const event = buildEventRecord(config, {
      title: "开会",
      category: "routine",
      timeSemantics: "local",
      timezone: "Asia/Tokyo",
      schedule: { kind: "weekly", every: 1, daysOfWeek: [1], time: { hour: 10, minute: 0 } },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 1 }],
    }, "Asia/Tokyo");

    expect(event.category).toBe("routine");
  });

  test("automation is not prewarmed and is generated on delivery instead", async () => {
    const config = await createTempConfig();
    const now = new Date("2026-04-08T00:00:00.000Z");
    const event = buildEventRecord(config, {
      title: "每日新闻",
      note: "获取今日科技新闻摘要",
      category: "automation",
      timeSemantics: "local",
      timezone: "Asia/Tokyo",
      schedule: { kind: "once", scheduledAt: "2026-04-08T00:00:00.000Z" },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 1 }],
    }, "Asia/Tokyo");
    await createEventRecord(event, config);

    let scheduledTaskPromptReceived = "";
    let scheduleMessageCalled = false;
    const mockAiService = {
      generateScheduledTaskContent: async (prompt: string) => {
        scheduledTaskPromptReceived = prompt;
        return "今日科技新闻：AI 芯片取得突破...";
      },
      generateReminderText: async (_title: string, _scheduledAt: string, _recurrence: string) => {
        scheduleMessageCalled = true;
        return "提醒消息";
      },
    } as any;

    expect(shouldPrepareScheduleDeliveryText(event, now)).toBe(false);
    const changed = await prepareScheduleDeliveryText(config, mockAiService, event, now);
    expect(changed).toBe(false);
    expect(scheduledTaskPromptReceived).toBe("");
    expect(scheduleMessageCalled).toBe(false);
    expect(event.deliveryText).toBeUndefined();

    const bot = {
      api: {
        sendMessage: mock(async () => ({ message_id: 1 })),
      },
    } as any;
    const delivered = await deliverDueSchedules(
      config,
      bot,
      async (currentEvent, _instance, fallback) => {
        if (currentEvent.category !== "automation") return fallback;
        const prompt = currentEvent.note?.trim();
        if (!prompt) return fallback;
        const text = await mockAiService.generateScheduledTaskContent(prompt);
        return text.trim() || fallback;
      },
    );

    expect(delivered).toBe(1);
    expect(scheduledTaskPromptReceived).toBe("获取今日科技新闻摘要");
    expect(scheduleMessageCalled).toBe(false);
  });

  test("automation delivery ignores stale prepared delivery text and renders fresh content", async () => {
    const config = await createTempConfig();
    const event = buildEventRecord(config, {
      title: "每日新闻简报",
      note: "获取今日科技新闻摘要",
      category: "automation",
      timeSemantics: "local",
      timezone: "Asia/Tokyo",
      schedule: { kind: "once", scheduledAt: "2026-04-08T00:00:00.000Z" },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 1 }],
      deliveryText: "旧的静态提醒",
      deliveryPreparedReminderId: "n1",
      deliveryPreparedNotifyAt: "2026-04-08T00:00:00.000Z",
    }, "Asia/Tokyo");
    await createEventRecord(event, config);

    const bot = {
      api: {
        sendMessage: mock(async (_chatId: number, text: string) => {
          expect(text).toBe("今日科技新闻：AI 芯片取得突破...");
          return { message_id: 1 };
        }),
      },
    } as any;

    const delivered = await deliverDueSchedules(
      config,
      bot,
      async (currentEvent, _instance, fallback) => {
        if (currentEvent.category !== "automation") return fallback;
        return "今日科技新闻：AI 芯片取得突破...";
      },
    );

    expect(delivered).toBe(1);
  });

  test("prepare handler does not overwrite schedule edits made while generation is running", async () => {
    const config = await createTempConfig();
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const event = buildEventRecord(config, {
      title: "每日站会",
      category: "routine",
      timeSemantics: "absolute",
      timezone: "Asia/Tokyo",
      schedule: { kind: "once", scheduledAt },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 1 }],
    }, "Asia/Tokyo");
    await createEventRecord(event, config);

    let updated = false;
    const result = await prepareScheduleDeliveryTextAndPersistIfUnchanged(config, {
      generateReminderText: async () => {
        if (!updated) {
          updated = true;
          const latest = await getEventRecord(config, event.id);
          if (!latest) throw new Error("missing event during test");
          latest.schedule = { kind: "once", scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() } as any;
          await updateEventRecord(config, latest);
        }
        return "记得开站会";
      },
    } as any, event);

    expect(result.reason).toBe("event-changed-during-prepare");
    const latest = await getEventRecord(config, event.id);
    expect((latest?.schedule as any)?.scheduledAt).not.toBe(scheduledAt);
    expect(latest?.deliveryText).toBeUndefined();
  });

  test("prepareScheduleDeliveryText uses title+schedule for regular schedules", async () => {
    const config = await createTempConfig();
    const now = new Date("2026-04-08T00:00:00.000Z");
    const event = buildEventRecord(config, {
      title: "组会提醒",
      category: "routine",
      timeSemantics: "local",
      timezone: "Asia/Tokyo",
      schedule: { kind: "weekly", every: 1, daysOfWeek: [3], time: { hour: 14, minute: 0 } },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 1 }],
    }, "Asia/Tokyo");
    await createEventRecord(event, config);

    let scheduledTaskCalled = false;
    let scheduleTitleReceived = "";
    const mockAiService = {
      generateScheduledTaskContent: async (_prompt: string) => {
        scheduledTaskCalled = true;
        return "task content";
      },
      generateReminderText: async (title: string, _scheduledAt: string, _recurrence: string) => {
        scheduleTitleReceived = title;
        return "组会马上开始了";
      },
    } as any;

    const changed = await prepareScheduleDeliveryText(config, mockAiService, event, now);

    expect(changed).toBe(true);
    expect(scheduledTaskCalled).toBe(false);
    expect(scheduleTitleReceived).toBe("组会提醒");
    expect(event.deliveryText).toBe("组会马上开始了");
  });

  test("automation can be created via upsert task operation", async () => {
    const config = await createTempConfig();
    const result = await runEventTask(config, makeTask({
      title: "每日新闻推送",
      note: "获取今日科技新闻并生成摘要",
      category: "automation",
      schedule: { kind: "weekly", every: 1, daysOfWeek: [1, 2, 3, 4, 5], time: { hour: 9, minute: 0 } },
    }));

    expect(result.changed).toBe(true);
    const events = await readEventRecords(config);
    const created = events.find((item) => item.title.includes("新闻"));
    expect(Boolean(created)).toBe(true);
    expect(created?.category).toBe("automation");
    expect(created?.note).toBe("获取今日科技新闻并生成摘要");
  });

  test("automation can be deleted via task operation", async () => {
    const config = await createTempConfig();
    const event = buildEventRecord(config, {
      title: "每日新闻",
      note: "获取今日科技新闻摘要",
      category: "automation",
      timeSemantics: "local",
      timezone: "Asia/Tokyo",
      schedule: { kind: "weekly", every: 1, daysOfWeek: [1, 2, 3, 4, 5], time: { hour: 9, minute: 0 } },
      reminders: [{ id: "n1", offsetMinutes: 0, enabled: true }],
      targets: [{ targetKind: "user", targetId: 1 }],
    }, "Asia/Tokyo");
    await createEventRecord(event, config);

    const deleteNow = new Date().toISOString();
    const result = await runEventTask(config, {
      id: "tsk_delete",
      state: "queued",
      domain: "events",
      operation: "delete",
      payload: { match: { title: "每日新闻" } },
      source: { requesterUserId: 1 },
      createdAt: deleteNow,
      updatedAt: deleteNow,
    });

    expect(result.changed).toBe(true);
    const events = await readEventRecords(config);
    expect(events.find((item) => item.id === event.id)?.status).toBe("deleted");
  });

  test("allowed requester can create automation for self", async () => {
    const config = await createTempConfig();
    await writeFile(path.join(config.paths.repoRoot, "system", "users.json"), JSON.stringify({
      users: {
        "2": { username: "allowed_test", displayName: "Allowed", accessLevel: "allowed", timezone: "Asia/Tokyo" }
      },
    }, null, 2) + "\n", "utf8");
    const allowedTask = makeTask({
      title: "每日新闻摘要",
      note: "自动生成新闻摘要",
      category: "automation",
      schedule: { kind: "weekly", every: 1, daysOfWeek: [1], time: { hour: 9, minute: 0 } },
      targets: [{ targetKind: "user", targetId: 2 }],
    }, 2);

    const result = await runEventTask(config, allowedTask);
    expect(result.changed).toBe(true);

    const events = await readEventRecords(config);
    const created = events.find((item) => item.title.includes("每日新闻摘要"));
    expect(created?.category).toBe("automation");
    expect(created?.createdByUserId).toBe(2);
  });

  test("requester without access cannot create automation", async () => {
    const config = await createTempConfig();
    const nonAdminTask = makeTask({
      title: "非法定时任务",
      note: "不应该成功",
      category: "automation",
      schedule: { kind: "weekly", every: 1, daysOfWeek: [1], time: { hour: 9, minute: 0 } },
    }, 999);

    const result = await runEventTask(config, nonAdminTask);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("schedule-create-not-allowed");

    const events = await readEventRecords(config);
    expect(events.find((item) => item.title.includes("非法"))).toBeUndefined();
  });
});
