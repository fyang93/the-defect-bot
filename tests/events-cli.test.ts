import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDirs: string[] = [];

async function createTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-schedules-cli-"));
  tempDirs.push(repoRoot);
  await mkdir(path.join(repoRoot, "system"), { recursive: true });
  await writeFile(path.join(repoRoot, "system", "users.json"), JSON.stringify({
    users: {
      "1": { username: "admin_test", displayName: "Admin", accessLevel: "admin", timezone: "Asia/Tokyo" },
      "2": { username: "allowed_test", displayName: "Allowed", accessLevel: "allowed", timezone: "Asia/Tokyo" },
      "3": { username: "trusted_test", displayName: "Trusted", accessLevel: "trusted", timezone: "Asia/Tokyo" }
    },
  }, null, 2) + "\n", "utf8");
  await writeFile(path.join(repoRoot, "system", "chats.json"), '{"chats":{}}\n', "utf8");
  await writeFile(path.join(repoRoot, "system", "state.json"), '{}\n', "utf8");
  await writeFile(path.join(repoRoot, "config.toml"), [
    '[telegram]',
    'bot_token = "test"',
    'admin_user_id = 1',
    '[bot]',
    'language = "zh-CN"',
    'default_timezone = "Asia/Tokyo"',
  ].join("\n") + "\n", "utf8");
  return repoRoot;
}

async function runCli(repoRoot: string, domain: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cliPath = path.join(process.cwd(), "src", "cli.ts");
  const proc = Bun.spawn(["bun", "run", cliPath, domain, JSON.stringify(args)], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  const trimmed = stdout.trim();
  const jsonStart = trimmed.lastIndexOf("\n{");
  const jsonText = (jsonStart >= 0 ? trimmed.slice(jsonStart + 1) : trimmed).trim();
  try {
    return JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    throw new Error(`unparseable output: ${stdout.trim()} stderr=${stderr.trim()}`);
  }
}

async function readEvents(repoRoot: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path.join(repoRoot, "system", "events.json"), "utf8");
  return JSON.parse(raw) as Array<Record<string, unknown>>;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("repo events CLI", () => {
  test("CRUD works when match/changes are JSON strings", { timeout: 15000 }, async () => {
    const repoRoot = await createTempRepo();

    const created = await runCli(repoRoot, "events:create", {
      requesterUserId: 1,
      title: "开会",
      targetUserId: 1,
      timezone: "Asia/Tokyo",
      schedule: JSON.stringify({ kind: "once", scheduledAt: "2026-04-11T06:00:00.000Z" }),
    });
    expect(created.ok).toBe(true);
    expect((created.event as any)?.scheduleSummary).toBe("2026/04/11 15:00");
    expect((created.event as any)?.scheduledAtDisplayLocal).toBe("2026-04-11T15:00:00");

    const localCreated = await runCli(repoRoot, "events:create", {
      requesterUserId: 1,
      title: "本地午饭",
      targetUserId: 1,
      timezone: "Asia/Tokyo",
      schedule: JSON.stringify({ kind: "once", scheduledAt: "2026-04-11T12:00:00" }),
    });
    expect(localCreated.ok).toBe(true);
    expect((localCreated.event as any)?.schedule?.scheduledAt).toBe("2026-04-11T03:00:00.000Z");
    expect((localCreated.event as any)?.scheduleSummary).toBe("2026/04/11 12:00");
    expect((localCreated.event as any)?.scheduledAtDisplayLocal).toBe("2026-04-11T12:00:00");

    const listed = await runCli(repoRoot, "events:list", { requesterUserId: 1 });
    expect(listed.ok).toBe(true);
    expect(Array.isArray(listed.events)).toBe(true);
    expect((listed.events as Array<any>).some((item) => item.title === "开会" && item.status === "active" && item.scheduleSummary === "2026/04/11 15:00")).toBe(true);
    expect((listed.events as Array<any>).some((item) => item.title === "本地午饭" && item.scheduledAtDisplayLocal === "2026-04-11T12:00:00")).toBe(true);

    const paused = await runCli(repoRoot, "events:pause", {
      requesterUserId: 1,
      match: JSON.stringify({ title: "开会" }),
    });
    expect(paused.ok).toBe(true);
    expect(paused.changed).toBe(true);

    const resumed = await runCli(repoRoot, "events:resume", {
      requesterUserId: 1,
      match: JSON.stringify({ title: "开会" }),
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.changed).toBe(true);

    const updated = await runCli(repoRoot, "events:update", {
      requesterUserId: 1,
      match: JSON.stringify({ title: "开会" }),
      changes: JSON.stringify({ title: "项目开会" }),
    });
    expect(updated.ok).toBe(true);
    expect(updated.changed).toBe(true);

    const retargeted = await runCli(repoRoot, "events:update", {
      requesterUserId: 1,
      match: JSON.stringify({ title: "项目开会" }),
      targetChatId: -1001234567890,
    });
    expect(retargeted.ok).toBe(true);
    expect(retargeted.changed).toBe(true);

    const afterRetarget = await readEvents(repoRoot);
    expect(afterRetarget.find((item) => item.title === "项目开会")?.targets).toEqual([{ targetKind: "chat", targetId: -1001234567890 }]);

    const scheduledTask = await runCli(repoRoot, "events:create", {
      requesterUserId: 1,
      title: "每日新闻摘要",
      note: "生成最近一天的重要新闻摘要",
      category: "automation",
      targetUserId: 1,
      timezone: "Asia/Tokyo",
      schedule: JSON.stringify({ kind: "interval", unit: "day", every: 1, anchorAt: "2026-04-10T23:00:00.000Z" }),
      reminders: JSON.stringify([
        { id: "before-1h", offsetMinutes: -60, enabled: true, label: "提前1小时" },
        { id: "default-now", offsetMinutes: 0, enabled: true, label: "准时" },
      ]),
    });
    expect(scheduledTask.ok).toBe(true);
    expect((scheduledTask.event as any)?.category).toBe("automation");
    expect((scheduledTask.event as any)?.reminders).toEqual([]);

    const daily = await runCli(repoRoot, "events:create", {
      requesterUserId: 1,
      title: "每日站会",
      targetUserId: 1,
      timezone: "Asia/Tokyo",
      schedule: JSON.stringify({ kind: "daily", time: { hour: 9, minute: 30 } }),
    });
    expect(daily.ok).toBe(true);
    expect((daily.event as any)?.schedule?.kind).toBe("interval");
    expect((daily.event as any)?.schedule?.unit).toBe("day");

    const weekdays = await runCli(repoRoot, "events:create", {
      requesterUserId: 1,
      title: "工作日提醒",
      targetUserId: 1,
      timezone: "Asia/Tokyo",
      schedule: JSON.stringify({ kind: "weekdays", time: { hour: 8, minute: 0 } }),
    });
    expect(weekdays.ok).toBe(true);
    expect((weekdays.event as any)?.schedule?.kind).toBe("weekly");
    expect((weekdays.event as any)?.schedule?.daysOfWeek).toEqual([1, 2, 3, 4, 5]);

    const weekends = await runCli(repoRoot, "events:create", {
      requesterUserId: 1,
      title: "周末提醒",
      targetUserId: 1,
      timezone: "Asia/Tokyo",
      schedule: JSON.stringify({ kind: "weekends", time: { hour: 10, minute: 0 } }),
    });
    expect(weekends.ok).toBe(true);
    expect((weekends.event as any)?.schedule?.kind).toBe("weekly");
    expect((weekends.event as any)?.schedule?.daysOfWeek).toEqual([0, 6]);

    const events = await readEvents(repoRoot);
    expect(events.find((item) => item.title === "项目开会")?.status).toBe("active");
    expect(events.find((item) => item.title === "每日新闻摘要")?.category).toBe("automation");

    const missing = await runCli(repoRoot, "events:update", {
      requesterUserId: 1,
      match: JSON.stringify({ title: "不存在的提醒" }),
      targetUserId: 1,
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe("schedule-not-resolved");
    expect(missing.skipped).toBe(true);
  });

  test("events:* CLI aliases map to the event handlers", async () => {
    const repoRoot = await createTempRepo();

    const created = await runCli(repoRoot, "events:create", {
      requesterUserId: 1,
      title: "alias事件",
      targetUserId: 1,
      timezone: "Asia/Tokyo",
      schedule: JSON.stringify({ kind: "once", scheduledAt: "2026-04-11T06:00:00.000Z" }),
    });
    expect(created.ok).toBe(true);

    const listed = await runCli(repoRoot, "events:list", { requesterUserId: 1 });
    expect(listed.ok).toBe(true);
    expect((listed.events as Array<any>).some((item) => item.title === "alias事件")).toBe(true);
  });

  test("allowed requester can create own schedules through CLI", async () => {
    const repoRoot = await createTempRepo();

    const created = await runCli(repoRoot, "events:create", {
      requesterUserId: 2,
      title: "allowed自建提醒",
      targetUserId: 2,
      timezone: "Asia/Tokyo",
      schedule: JSON.stringify({ kind: "once", scheduledAt: "2026-04-11T06:00:00.000Z" }),
    });
    expect(created.ok).toBe(true);
    expect((created.event as any)?.targets).toEqual([{ targetKind: "user", targetId: 2 }]);
  });

  test("allowed requester still cannot create schedules for another user through CLI", async () => {
    const repoRoot = await createTempRepo();

    const created = await runCli(repoRoot, "events:create", {
      requesterUserId: 2,
      title: "帮 admin 建提醒",
      targetUserId: 1,
      timezone: "Asia/Tokyo",
      schedule: JSON.stringify({ kind: "once", scheduledAt: "2026-04-11T06:00:00.000Z" }),
    });
    expect(created).toEqual({ ok: false, error: "schedule-create-not-allowed" });
  });

  test("trusted requester can create schedules for another user through CLI", async () => {
    const repoRoot = await createTempRepo();

    const created = await runCli(repoRoot, "events:create", {
      requesterUserId: 3,
      title: "帮 admin 建提醒",
      targetUserId: 1,
      timezone: "Asia/Tokyo",
      schedule: JSON.stringify({ kind: "once", scheduledAt: "2026-04-11T06:00:00.000Z" }),
    });
    expect(created.ok).toBe(true);
    expect((created.event as any)?.targets).toEqual([{ targetKind: "user", targetId: 1 }]);
  });

  test("explicit batch ids can retarget only the listed events", async () => {
    const repoRoot = await createTempRepo();

    const news1 = await runCli(repoRoot, "events:create", {
      requesterUserId: 1,
      title: "每日新闻简报",
      targetUserId: 1,
      timezone: "Asia/Tokyo",
      category: "automation",
      schedule: JSON.stringify({ kind: "once", scheduledAt: "2026-04-12T01:00:00.000Z" }),
    });
    const news2 = await runCli(repoRoot, "events:create", {
      requesterUserId: 1,
      title: "晚间新闻简报",
      targetUserId: 1,
      timezone: "Asia/Tokyo",
      category: "automation",
      schedule: JSON.stringify({ kind: "once", scheduledAt: "2026-04-12T13:00:00.000Z" }),
    });
    const meeting = await runCli(repoRoot, "events:create", {
      requesterUserId: 1,
      title: "组会",
      targetUserId: 1,
      timezone: "Asia/Tokyo",
      schedule: JSON.stringify({ kind: "once", scheduledAt: "2026-04-11T06:00:00.000Z" }),
    });

    const batch = await runCli(repoRoot, "events:update", {
      requesterUserId: 1,
      match: JSON.stringify({ ids: [(news1.event as any).id, (news2.event as any).id] }),
      targetChatId: -1003674455331,
    });
    expect(batch.ok).toBe(true);
    expect(batch.eventIds).toEqual([(news1.event as any).id, (news2.event as any).id]);

    const events = await readEvents(repoRoot);
    expect(events.find((item) => item.id === (news1.event as any).id)?.targets).toEqual([{ targetKind: "chat", targetId: -1003674455331 }]);
    expect(events.find((item) => item.id === (news2.event as any).id)?.targets).toEqual([{ targetKind: "chat", targetId: -1003674455331 }]);
    expect(events.find((item) => item.id === (meeting.event as any).id)?.targets).toEqual([{ targetKind: "user", targetId: 1 }]);
  });

  test("events:update can promote a routine yearly reminder into a birthday special and returns updated schedule", async () => {
    const repoRoot = await createTempRepo();

    const created = await runCli(repoRoot, "events:create", {
      requesterUserId: 1,
      title: "小雨生日",
      targetUserId: 1,
      timezone: "Asia/Tokyo",
      category: "routine",
      schedule: JSON.stringify({ kind: "yearly", every: 1, month: 1, day: 22, time: { hour: 9, minute: 0 } }),
    });
    expect(created.ok).toBe(true);

    const updated = await runCli(repoRoot, "events:update", {
      requesterUserId: 1,
      match: JSON.stringify({ id: (created.event as any).id }),
      changes: JSON.stringify({
        category: "special",
        specialKind: "birthday",
        reminders: [
          { id: "default-2w", offsetMinutes: -14 * 24 * 60, enabled: true, label: "提前2周" },
          { id: "default-1w", offsetMinutes: -7 * 24 * 60, enabled: true, label: "提前1周" },
          { id: "default-1d", offsetMinutes: -24 * 60, enabled: true, label: "提前1天" },
          { id: "default-now", offsetMinutes: 0, enabled: true, label: "当天" },
        ],
      }),
    });
    expect(updated.ok).toBe(true);
    expect((updated.event as any)?.category).toBe("special");
    expect((updated.event as any)?.specialKind).toBe("birthday");
    expect(Array.isArray((updated.event as any)?.reminders)).toBe(true);
    expect(((updated.event as any)?.reminders || []).map((item: any) => item.id)).toEqual(["default-2w", "default-1w", "default-1d", "default-now"]);

    const events = await readEvents(repoRoot);
    const stored = events.find((item) => item.id === (created.event as any).id);
    expect(stored?.category).toBe("special");
    expect(stored?.specialKind).toBe("birthday");
    expect((stored?.reminders as Array<any>)?.map((item) => item.id)).toEqual(["default-2w", "default-1w", "default-1d", "default-now"]);
  });


  test("telegram:list-recipients filters memory person aliases", async () => {
    const repoRoot = await createTempRepo();
    await writeFile(path.join(repoRoot, "system", "users.json"), JSON.stringify({
      users: {
        "1": { username: "admin_test", displayName: "Admin", accessLevel: "admin", timezone: "Asia/Tokyo" },
        "1360179004": { username: "sellputetherum", displayName: "@sellputetherum", accessLevel: "allowed", timezone: "Asia/Tokyo" },
      },
    }, null, 2) + "\n", "utf8");
    await mkdir(path.join(repoRoot, "memory", "people", "li-bowen-wen"), { recursive: true });
    await writeFile(path.join(repoRoot, "memory", "people", "li-bowen-wen", "README.md"), [
      "---",
      "title: 李博闻",
      "aliases: [\"李博\", \"@sellputetherum\"]",
      "---",
      "- Telegram：@sellputetherum",
    ].join("\n") + "\n", "utf8");

    const listed = await runCli(repoRoot, "telegram:list-recipients", { requesterUserId: 1, query: "李博" });

    expect(listed.ok).toBe(true);
    expect(listed.recipients).toEqual([{ recipientKind: "user", recipientId: 1360179004, recipientLabel: "@sellputetherum (@sellputetherum)" }]);
  });


  test("telegram:list-recipients filters by canonical alias", async () => {
    const repoRoot = await createTempRepo();
    await writeFile(path.join(repoRoot, "system", "users.json"), JSON.stringify({
      users: {
        "1": { username: "admin_test", aliases: ["管理员"], accessLevel: "admin", timezone: "Asia/Tokyo" },
        "1360179004": { username: "sellputetherum", aliases: ["李博", "李博闻"], accessLevel: "allowed", timezone: "Asia/Tokyo" },
      },
    }, null, 2) + "\n", "utf8");

    const listed = await runCli(repoRoot, "telegram:list-recipients", { requesterUserId: 1, query: "李博" });

    expect(listed.ok).toBe(true);
    expect(listed.recipients).toEqual([{ recipientKind: "user", recipientId: 1360179004, recipientLabel: "sellputetherum (@sellputetherum)" }]);
  });

  test("users:add-alias persists canonical aliases", async () => {
    const repoRoot = await createTempRepo();

    const updated = await runCli(repoRoot, "users:add-alias", { requesterUserId: 1, userId: 2, alias: "李博" });

    expect(updated.ok).toBe(true);
    expect(updated.user.aliases).toContain("李博");
  });
});
