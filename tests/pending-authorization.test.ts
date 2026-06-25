import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/bot/app/types";
import { state, rememberPendingAuthorization, consumePendingAllowedAuthorization, pruneExpiredPendingAuthorizations, loadPersistentState, persistState } from "../src/bot/app/state";
import { storePendingAuthorizations, grantPendingAllowedAccessIfMatched } from "../src/bot/operations/access/authorizations";
import { accessLevelForUser } from "../src/bot/operations/access/roles";

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
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "defect-bot-pending-auth-"));
  tempDirs.push(repoRoot);
  await mkdir(path.join(repoRoot, "system"), { recursive: true });
  await mkdir(path.join(repoRoot, "logs"), { recursive: true });
  await writeFile(path.join(repoRoot, "system", "users.json"), JSON.stringify({
    users: {
      "1": { username: "admin_test", displayName: "Admin", accessLevel: "admin", timezone: "Asia/Tokyo" },
    },
  }, null, 2) + "\n", "utf8");
  await writeFile(path.join(repoRoot, "system", "chats.json"), '{"chats":{}}\n', "utf8");
  await writeFile(path.join(repoRoot, "system", "state.json"), '{"pendingAuthorizations":[]}\n', "utf8");
  return createTestConfig(repoRoot);
}

afterEach(async () => {
  state.pendingAuthorizations = [];
  state.telegramUserCache = {};
  state.userTimezoneCache = {};
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("pending authorization: admin adds unknown user by username only", () => {
  test("admin can create pending authorization with username only (no userId needed)", async () => {
    const config = await createTempConfig();
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const result = await storePendingAuthorizations(
      config,
      [{ username: "new_friend", expiresAt: futureExpiry }],
      1, // admin userId
      "admin",
    );

    expect(result.created.length).toBe(1);
    expect(result.clarifications.length).toBe(0);
    expect(state.pendingAuthorizations.length).toBe(1);
    expect(state.pendingAuthorizations[0].username).toBe("new_friend");
    expect(state.pendingAuthorizations[0].kind).toBe("allowed");
  });

  test("username is normalized: @ prefix removed, lowercased", async () => {
    const config = await createTempConfig();
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await storePendingAuthorizations(
      config,
      [{ username: "@MyFriend", expiresAt: futureExpiry }],
      1,
      "admin",
    );

    expect(state.pendingAuthorizations[0].username).toBe("myfriend");
  });

  test("non-admin cannot create pending authorization", async () => {
    const config = await createTempConfig();
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const result = await storePendingAuthorizations(
      config,
      [{ username: "hacker", expiresAt: futureExpiry }],
      999, // non-admin
      "allowed",
    );

    expect(result.created.length).toBe(0);
    expect(result.clarifications.length).toBe(1);
    expect(state.pendingAuthorizations.length).toBe(0);
  });

  test("expired expiresAt is rejected", async () => {
    const config = await createTempConfig();
    const pastExpiry = new Date(Date.now() - 1000).toISOString();

    const result = await storePendingAuthorizations(
      config,
      [{ username: "late_user", expiresAt: pastExpiry }],
      1,
      "admin",
    );

    expect(result.created.length).toBe(0);
    expect(state.pendingAuthorizations.length).toBe(0);
  });
});

describe("pending authorization: user messages bot → access granted → persisted", () => {
  test("matching username grants allowed access and persists to users.json", async () => {
    const config = await createTempConfig();
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Step 1: Admin creates pending authorization
    await storePendingAuthorizations(
      config,
      [{ username: "new_friend", expiresAt: futureExpiry }],
      1,
      "admin",
    );
    expect(state.pendingAuthorizations.length).toBe(1);

    // Step 2: Unknown user with matching username messages the bot
    // Before granting, user should have no access
    const accessBefore = accessLevelForUser(config, 500);
    expect(accessBefore).toBe("none");

    const usersFile = path.join(config.paths.repoRoot, "system", "users.json");
    const beforeStat = await stat(usersFile);

    // Step 3: Grant access (simulates unauthorizedGuard flow)
    const granted = await grantPendingAllowedAccessIfMatched(config, { id: 500, username: "new_friend" });
    expect(granted.granted).toBe(true);
    expect(granted.username).toBe("new_friend");

    // Force the file mtime back to the cached value to verify cache invalidation,
    // because unauthorizedGuard reads before grant and the rest of the turn reads again immediately after.
    await utimes(usersFile, beforeStat.atime, beforeStat.mtime);

    // Step 4: Pending authorization is consumed (removed from list)
    expect(state.pendingAuthorizations.length).toBe(0);

    // Step 5: User is now persisted in users.json with allowed access
    const usersRaw = await readFile(usersFile, "utf8");
    const usersDoc = JSON.parse(usersRaw);
    expect(usersDoc.users["500"]).toBeDefined();
    expect(usersDoc.users["500"].accessLevel).toBe("allowed");
    expect(usersDoc.users["500"].username).toBe("new_friend");

    // Step 6: Subsequent access check returns allowed even if file mtime did not advance
    const accessAfter = accessLevelForUser(config, 500);
    expect(accessAfter).toBe("allowed");
  });

  test("non-matching username does not grant access", async () => {
    const config = await createTempConfig();
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await storePendingAuthorizations(
      config,
      [{ username: "expected_user", expiresAt: futureExpiry }],
      1,
      "admin",
    );

    const granted = await grantPendingAllowedAccessIfMatched(config, { id: 600, username: "wrong_user" });
    expect(granted.granted).toBe(false);
    expect(state.pendingAuthorizations.length).toBe(1); // Not consumed
  });

  test("expired pending authorization is pruned and not granted", async () => {
    const config = await createTempConfig();
    const pastExpiry = new Date(Date.now() - 1000).toISOString();

    // Manually insert an expired authorization
    rememberPendingAuthorization({
      kind: "allowed",
      username: "expired_user",
      createdBy: 1,
      createdAt: new Date().toISOString(),
      expiresAt: pastExpiry,
    });
    expect(state.pendingAuthorizations.length).toBe(1);

    // Consume attempt should fail because it prunes expired first
    const granted = await grantPendingAllowedAccessIfMatched(config, { id: 700, username: "expired_user" });
    expect(granted.granted).toBe(false);
    expect(state.pendingAuthorizations.length).toBe(0); // Pruned
  });

  test("authorization is one-time use: second user with same username gets nothing", async () => {
    const config = await createTempConfig();
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await storePendingAuthorizations(
      config,
      [{ username: "shared_name", expiresAt: futureExpiry }],
      1,
      "admin",
    );

    // First user consumes the authorization
    const first = await grantPendingAllowedAccessIfMatched(config, { id: 800, username: "shared_name" });
    expect(first.granted).toBe(true);

    // Second user with same username gets nothing
    const second = await grantPendingAllowedAccessIfMatched(config, { id: 801, username: "shared_name" });
    expect(second.granted).toBe(false);
  });
});

describe("pending authorization: tool add_pending_authorization via runtime_state", () => {
  test("add_pending_authorization stores authorization in state", async () => {
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    rememberPendingAuthorization({
      kind: "allowed",
      username: "tool_user",
      createdBy: 1,
      createdAt: new Date().toISOString(),
      expiresAt: futureExpiry,
    });

    expect(state.pendingAuthorizations.length).toBe(1);
    expect(state.pendingAuthorizations[0].username).toBe("tool_user");
  });

  test("prune removes only expired authorizations", async () => {
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const pastExpiry = new Date(Date.now() - 1000).toISOString();

    rememberPendingAuthorization({
      kind: "allowed",
      username: "valid_user",
      createdBy: 1,
      createdAt: new Date().toISOString(),
      expiresAt: futureExpiry,
    });
    rememberPendingAuthorization({
      kind: "allowed",
      username: "expired_user",
      createdBy: 1,
      createdAt: new Date().toISOString(),
      expiresAt: pastExpiry,
    });

    expect(state.pendingAuthorizations.length).toBe(2);
    const removed = pruneExpiredPendingAuthorizations();
    expect(removed).toBe(1);
    expect(state.pendingAuthorizations.length).toBe(1);
    expect(state.pendingAuthorizations[0].username).toBe("valid_user");
  });

  test("pending authorizations survive state persistence round-trip", async () => {
    const config = await createTempConfig();
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    rememberPendingAuthorization({
      kind: "allowed",
      username: "persistent_user",
      createdBy: 1,
      createdAt: new Date().toISOString(),
      expiresAt: futureExpiry,
    });

    await persistState(config.paths.stateFile);

    // Clear in-memory state
    state.pendingAuthorizations = [];
    expect(state.pendingAuthorizations.length).toBe(0);

    // Reload from disk
    await loadPersistentState(config.paths.stateFile);
    expect(state.pendingAuthorizations.length).toBe(1);
    expect(state.pendingAuthorizations[0].username).toBe("persistent_user");
  });
});
