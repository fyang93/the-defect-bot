/**
 * Live assistant integration test.
 *
 * Runs against a live Pi SDK setup. Each scenario calls runAssistantTurn()
 * directly and logs the result. After all scenarios complete, read the log to
 * verify correctness.
 *
 * Usage:
 *   npm run test:live
 */

import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/bot/app/types";
import { loadPersistentState, state } from "../src/bot/app/state";
import { AiService } from "../src/bot/ai";
import { buildAssistantContextBlock, lookupRequesterTimezone } from "../src/bot/operations/context/assistant";
import { buildEventRecord, createEventRecord, readEventRecords } from "../src/bot/operations/events/store";
import { rememberTelegramUser } from "../src/bot/telegram/registry";

const hostRepoRoot = process.cwd();
const logFile = path.join(hostRepoRoot, "logs", "test-runs", "live-assistant.log");

// --- Helpers ---

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
      language: "zh",
      defaultTimezone: "Asia/Tokyo",
    },
    paths: {
      repoRoot,
      tmpDir: path.join(repoRoot, "tmp"),
      uploadSubdir: "uploads",
      logFile: path.join(repoRoot, "logs", "bot.log"),
      stateFile: path.join(repoRoot, "system", "runtime-state.json"),
    },
    maintenance: {
      enabled: false,
      idleAfterMs: 0,
      tmpRetentionDays: 1,
    },
  };
}

async function createTempEnv(): Promise<{ config: AppConfig; repoRoot: string }> {
  // Use the real project root so Pi SDK tools can find repository state and extension tools.
  // System files are backed up and restored after the test.
  const repoRoot = hostRepoRoot;
  await mkdir(path.join(repoRoot, "system"), { recursive: true });
  await mkdir(path.join(repoRoot, "logs"), { recursive: true });
  await mkdir(path.join(repoRoot, "memory", "people"), { recursive: true });

  // Backup existing system files
  const backups = new Map<string, string | null>();
  for (const file of ["system/users.json", "system/chats.json", "system/runtime-state.json"]) {
    const filePath = path.join(repoRoot, file);
    try { backups.set(file, await readFile(filePath, "utf8")); } catch { backups.set(file, null); }
  }

  // Write test system files
  await writeFile(path.join(repoRoot, "system", "users.json"), JSON.stringify({
    users: {
      "1": { username: "admin_test", displayName: "Admin Test", timezone: "Asia/Tokyo", accessLevel: "admin" },
    },
  }, null, 2) + "\n", "utf8");
  await writeFile(path.join(repoRoot, "system", "chats.json"), '{"chats":{}}\n', "utf8");
  await writeFile(path.join(repoRoot, "system", "runtime-state.json"), '{}\n', "utf8");

  const config = createTestConfig(repoRoot);
  await loadPersistentState(config.paths.stateFile);
  rememberTelegramUser({ id: 1, username: "admin_test", first_name: "Admin", last_name: "Test" });

  // Store backup restore function for cleanup
  (globalThis as any).__liveTestBackups = backups;
  (globalThis as any).__liveTestRepoRoot = repoRoot;

  return { config, repoRoot };
}

async function log(entry: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  await appendFile(logFile, line + "\n", "utf8");
  // Also print condensed version to stdout
  const scenario = entry.scenario || "";
  const status = entry.status || "";
  const msg = entry.message || (entry.result as any)?.message?.slice(0, 80) || "";
  console.log(`  ${status === "ok" ? "✅" : status === "error" ? "❌" : "📋"} ${scenario}${msg ? ` → ${msg}` : ""}`);
}

async function buildContext(config: AppConfig, promptText: string): Promise<{ assistantContextText: string; requesterTimezone: string | null }> {
  const assistantContextText = await buildAssistantContextBlock(config, {
    requesterUserId: 1,
    chatId: 1,
    messageTime: new Date().toISOString(),
  });
  return { assistantContextText, requesterTimezone: lookupRequesterTimezone(config, 1) };
}

type ScenarioResult = {
  scenario: string;
  input: string;
  result: any;
  error?: string;
};

async function runScenario(
  name: string,
  config: AppConfig,
  agentService: AiService,
  input: string,
  opts?: { setup?: () => Promise<void> },
): Promise<ScenarioResult> {
  try {
    const { assistantContextText, requesterTimezone } = await buildContext(config, input);
    const result = await agentService.runAssistantTurn({
      userRequestText: input,
      requesterUserId: 1,
      chatId: 1,
      chatType: "private",
      accessRole: "admin",
      messageTime: new Date().toISOString(),
      requesterTimezone,
      sharedConversationContextText: assistantContextText,
    });

    await log({
      scenario: name,
      status: "ok",
      input,
      result: {
        message: result.message,
        answerMode: result.answerMode,
        usedNativeExecution: result.usedNativeExecution,
        completedActions: result.completedActions,
      },
    });
    return { scenario: name, input, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log({ scenario: name, status: "error", input, error: message });
    return { scenario: name, input, result: null, error: message };
  }
}

// --- Scenarios ---

async function main() {
  await mkdir(path.join(hostRepoRoot, "logs", "test-runs"), { recursive: true });
  await writeFile(logFile, "", "utf8"); // clear log

  console.log("\n🧪 Live Assistant Integration Test\n");
  console.log(`Log file: ${logFile}\n`);

  const { config, repoRoot } = await createTempEnv();
  const agentService = new AiService(config);

  try {
    await agentService.ensureReady();
  } catch (error) {
    console.error("❌ Pi SDK is not ready. Configure an authenticated model first.");
    process.exit(1);
  }

  const results: ScenarioResult[] = [];
  let passed = 0;
  let failed = 0;

  async function run(name: string, input: string, opts?: { setup?: () => Promise<void> }) {
    if (opts?.setup) await opts.setup();
    const r = await runScenario(name, config, agentService, input, opts);
    results.push(r);
    if (r.error) failed++; else passed++;
  }

  // 1. Simple greeting — no tools
  await run("简单问候", "你好");

  // 2. List schedules — events:list
  await run("查看提醒列表", "查看当前提醒列表");

  // 3. Create schedule — events:create
  await run("创建提醒", "创建提醒：明天下午3点开会");

  // 4. Pause schedule — events:pause
  await run("暂停提醒", "暂停开会提醒");

  // 5. Resume schedule — events:resume
  await run("恢复提醒", "恢复开会提醒");

  // 6. Delete schedule — events:delete
  await run("删除提醒", "删除开会提醒");

  // 7. List users — users:list
  await run("查看用户列表", "查看用户列表");

  // 8. Set access level — users:set-access
  await run("设置用户权限", "把 test_rain 设为 trusted", {
    setup: async () => {
      rememberTelegramUser({ id: 8631425224, username: "test_rain", first_name: "测试", last_name: "雨" });
    },
  });

  // 9. List tasks — (removed-internal-tool) (list)
  await run("查看任务队列", "查看当前任务队列");

  // 10. Runtime-state mutation kept model-visible only for temporary authorization — auth:add-pending
  await run("查看运行状态", "查看当前运行状态");

  // 11. File registry — (removed-internal-tool)
  await run("查看文件注册表", "查看文件注册表");

  // 12. Memory context injection
  await run("Memory上下文注入", "查一下测试雨的资料", {
    setup: async () => {
      await writeFile(
        path.join(repoRoot, "memory", "people", "test-rain.md"),
        "---\nkeywords:\n  - 测试雨\n  - test_rain\n---\n- name: 测试雨\n- hobby: baking\n- note: 喜欢烘焙\n",
        "utf8",
      );
    },
  });

  // 13. Maintainer pass
  try {
    const maintainerResult = await agentService.runMaintenancePass("Idle maintenance pass. Check and report.");
    await log({ scenario: "Maintainer维护", status: "ok", input: "maintenance pass", result: { message: maintainerResult } });
    passed++;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log({ scenario: "Maintainer维护", status: "error", input: "maintenance pass", error: message });
    failed++;
  }

  // 14. Startup greeting (greeter)
  try {
    const greeting = await agentService.generateStartupGreeting({ requesterUserId: 1 });
    await log({ scenario: "启动问候", status: "ok", input: "startup greeting", result: { message: greeting } });
    passed++;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log({ scenario: "启动问候", status: "error", input: "startup greeting", error: message });
    failed++;
  }

  // Summary
  console.log(`\n${"─".repeat(50)}`);
  console.log(`📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} scenarios`);
  console.log(`📄 Full log: ${logFile}`);

  // Cleanup: restore original system files
  agentService.stop();
  const backups = (globalThis as any).__liveTestBackups as Map<string, string | null> | undefined;
  const cleanupRoot = (globalThis as any).__liveTestRepoRoot as string | undefined;
  if (backups && cleanupRoot) {
    for (const [file, content] of backups) {
      const filePath = path.join(cleanupRoot, file);
      if (content !== null) {
        await writeFile(filePath, content, "utf8");
      }
    }
  }

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
