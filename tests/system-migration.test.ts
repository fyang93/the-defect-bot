import { afterEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/bot/app/types";
import { migrateSystemStateForFeishu } from "../src/bot/app/migrate";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

test("migrates canonical JSON to string Feishu IDs and removes role metadata", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "defect-migrate-")); roots.push(root); mkdirSync(path.join(root, "system"));
  writeFileSync(path.join(root, "system/users.json"), JSON.stringify({ users: { "123": { username: "old", displayName: "User", accessLevel: "trusted", personPath: "memory/people/u/README.md" } } }));
  writeFileSync(path.join(root, "system/state.json"), JSON.stringify({ model: null, pendingAuthorizations: [{ kind: "allowed" }] }));
  writeFileSync(path.join(root, "system/events.json"), JSON.stringify([{ id: "e1", createdByUserId: 123, targets: [{ targetKind: "user", targetId: 123 }] }]));
  const config = { paths: { repoRoot: root, stateFile: path.join(root, "system/state.json"), tmpDir: path.join(root, "tmp"), uploadSubdir: "feishu", logFile: path.join(root, "bot.log") } } as AppConfig;
  await migrateSystemStateForFeishu(config);
  const users = readFileSync(path.join(root, "system/users.json"), "utf8");
  expect(users).not.toMatch(/username|accessLevel|trusted/);
  expect(users).toContain("personPath");
  const events = JSON.parse(readFileSync(path.join(root, "system/events.json"), "utf8"));
  expect(events[0].createdByUserId).toBe("123");
  expect(events[0].targets[0].targetId).toBe("123");
  expect(readFileSync(path.join(root, "system/state.json"), "utf8")).not.toContain("pendingAuthorizations");
});
