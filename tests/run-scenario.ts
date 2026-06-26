/**
 * Single-scenario live test runner.
 * Usage: npm exec tsx tests/run-scenario.ts <scenario-number>
 *
 * Runs one scenario at a time against a live Pi SDK setup,
 * writes results to logs/test-runs/live-assistant.log.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../src/bot/app/types";
import { loadPersistentState, state } from "../src/bot/app/state";
import { AiService } from "../src/bot/ai";
import { buildAssistantContextBlock, lookupRequesterTimezone } from "../src/bot/operations/context/assistant";
import { buildEventRecord, createEventRecord, readEventRecords } from "../src/bot/operations/events/store";
import { rememberTelegramUser } from "../src/bot/telegram/registry";
import { loadUsers } from "../src/bot/operations/context/store";

const hostRepoRoot = process.cwd();
const logFile = path.join(hostRepoRoot, "logs", "test-runs", "live-assistant.log");

function createTestConfig(): AppConfig {
  return {
    telegram: { botToken: "test", adminUserId: 1, waitingMessage: "", inputMergeWindowSeconds: 3, menuPageSize: 10 },
    bot: { personaStyle: "", language: "zh", defaultTimezone: "Asia/Tokyo" },
    paths: { repoRoot: hostRepoRoot, tmpDir: path.join(hostRepoRoot, "tmp"), uploadSubdir: "uploads", logFile: path.join(hostRepoRoot, "logs", "bot.log"), stateFile: path.join(hostRepoRoot, "system", "runtime-state.json") },
    maintenance: { enabled: false, idleAfterMs: 0, tmpRetentionDays: 1 },
  };
}

async function log(entry: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(hostRepoRoot, "logs", "test-runs"), { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  await appendFile(logFile, line + "\n", "utf8");
  console.log(line);
}

async function buildContext(config: AppConfig, promptText: string) {
  const assistantContextText = await buildAssistantContextBlock(config, { requesterUserId: 1, chatId: 1, messageTime: new Date().toISOString() });
  return { assistantContextText, requesterTimezone: lookupRequesterTimezone(config, 1) };
}

async function runAssistant(config: AppConfig, agentService: AiService, input: string) {
  const { assistantContextText, requesterTimezone } = await buildContext(config, input);
  return agentService.runAssistantTurn({
    userRequestText: input, requesterUserId: 1, chatId: 1, chatType: "private",
    accessRole: "admin", messageTime: new Date().toISOString(), requesterTimezone,
    sharedConversationContextText: assistantContextText,
  });
}

// --- Scenarios ---
const scenarios: Array<{ name: string; run: (config: AppConfig, agentService: AiService) => Promise<void> }> = [
  {
    name: "1. 简单问候（无工具）",
    run: async (config, agentService) => {
      const result = await runAssistant(config, agentService, "你好");
      await log({ scenario: "简单问候", result: { message: result.message, answerMode: result.answerMode, usedNativeExecution: result.usedNativeExecution, completedActions: result.completedActions } });
    },
  },
  {
    name: "2. 查看提醒列表 (event_list)",
    run: async (config, agentService) => {
      const result = await runAssistant(config, agentService, "查看当前提醒列表");
      await log({ scenario: "查看提醒列表", result: { message: result.message, answerMode: result.answerMode, usedNativeExecution: result.usedNativeExecution, completedActions: result.completedActions } });
    },
  },
  {
    name: "3. 创建提醒 (event_create)",
    run: async (config, agentService) => {
      const result = await runAssistant(config, agentService, "创建提醒：明天下午3点开会");
      const schedules = await readEventRecords(config);
      await log({ scenario: "创建提醒", result: { message: result.message, answerMode: result.answerMode, usedNativeExecution: result.usedNativeExecution, completedActions: result.completedActions }, scheduleCount: schedules.length, activeSchedules: schedules.filter(r => r.status === "active").map(r => r.title) });
    },
  },
  {
    name: "4. 暂停提醒 (event_pause)",
    run: async (config, agentService) => {
      const result = await runAssistant(config, agentService, "暂停开会提醒");
      const schedules = await readEventRecords(config);
      await log({ scenario: "暂停提醒", result: { message: result.message, answerMode: result.answerMode, usedNativeExecution: result.usedNativeExecution, completedActions: result.completedActions }, scheduleStatuses: schedules.map(r => ({ title: r.title, status: r.status })) });
    },
  },
  {
    name: "5. 恢复提醒 (event_resume)",
    run: async (config, agentService) => {
      const result = await runAssistant(config, agentService, "恢复开会提醒");
      const schedules = await readEventRecords(config);
      await log({ scenario: "恢复提醒", result: { message: result.message, answerMode: result.answerMode, usedNativeExecution: result.usedNativeExecution, completedActions: result.completedActions }, scheduleStatuses: schedules.map(r => ({ title: r.title, status: r.status })) });
    },
  },
  {
    name: "6. 删除提醒 (event_delete)",
    run: async (config, agentService) => {
      const result = await runAssistant(config, agentService, "删除开会提醒");
      const schedules = await readEventRecords(config);
      await log({ scenario: "删除提醒", result: { message: result.message, answerMode: result.answerMode, usedNativeExecution: result.usedNativeExecution, completedActions: result.completedActions }, scheduleStatuses: schedules.map(r => ({ title: r.title, status: r.status })) });
    },
  },
  {
    name: "7. 查看用户列表 (user:list)",
    run: async (config, agentService) => {
      const result = await runAssistant(config, agentService, "查看用户列表");
      await log({ scenario: "查看用户列表", result: { message: result.message, answerMode: result.answerMode, usedNativeExecution: result.usedNativeExecution, completedActions: result.completedActions } });
    },
  },
  {
    name: "8. 设置用户权限 (user:set-access)",
    run: async (config, agentService) => {
      rememberTelegramUser({ id: 8631425224, username: "test_rain", first_name: "测试", last_name: "雨" });
      const result = await runAssistant(config, agentService, "把 test_rain 设为 trusted");
      const users = loadUsers(hostRepoRoot);
      await log({ scenario: "设置用户权限", result: { message: result.message, answerMode: result.answerMode, usedNativeExecution: result.usedNativeExecution, completedActions: result.completedActions }, userTestRain: users["8631425224"] || null });
    },
  },
  {
    name: "9. 查看任务队列 ((removed-internal-tool))",
    run: async (config, agentService) => {
      const result = await runAssistant(config, agentService, "查看当前任务队列");
      await log({ scenario: "查看任务队列", result: { message: result.message, answerMode: result.answerMode, usedNativeExecution: result.usedNativeExecution, completedActions: result.completedActions } });
    },
  },
  {
    name: "10. 查看临时授权（auth_add_pending）",
    run: async (config, agentService) => {
      const result = await runAssistant(config, agentService, "查看当前运行状态");
      await log({ scenario: "查看运行状态", result: { message: result.message, answerMode: result.answerMode, usedNativeExecution: result.usedNativeExecution, completedActions: result.completedActions } });
    },
  },
  {
    name: "11. 查看文件注册表 ((removed-internal-tool))",
    run: async (config, agentService) => {
      const result = await runAssistant(config, agentService, "查看文件注册表");
      await log({ scenario: "查看文件注册表", result: { message: result.message, answerMode: result.answerMode, usedNativeExecution: result.usedNativeExecution, completedActions: result.completedActions } });
    },
  },
  {
    name: "12. Memory上下文注入",
    run: async (config, agentService) => {
      await mkdir(path.join(hostRepoRoot, "memory", "people"), { recursive: true });
      await writeFile(path.join(hostRepoRoot, "memory", "people", "test-rain.md"), "---\nkeywords:\n  - 测试雨\n  - test_rain\n---\n- name: 测试雨\n- hobby: baking\n- note: 喜欢烘焙\n", "utf8");
      const result = await runAssistant(config, agentService, "查一下测试雨的资料");
      await log({ scenario: "Memory上下文注入", result: { message: result.message, answerMode: result.answerMode, usedNativeExecution: result.usedNativeExecution, completedActions: result.completedActions } });
    },
  },
  {
    name: "13. Maintainer维护",
    run: async (config, agentService) => {
      const message = await agentService.runMaintenancePass("Idle maintenance pass. Check and report.");
      await log({ scenario: "Maintainer维护", result: { message } });
    },
  },
  {
    name: "14. 启动问候 (greeter)",
    run: async (config, agentService) => {
      const message = await agentService.generateStartupGreeting({ requesterUserId: 1 });
      await log({ scenario: "启动问候", result: { message } });
    },
  },
];

async function main() {
  const scenarioNum = parseInt(process.argv[2] || "0", 10);
  if (scenarioNum < 1 || scenarioNum > scenarios.length) {
    console.log(`Usage: npm exec tsx tests/run-scenario.ts <1-${scenarios.length}>`);
    console.log("\nAvailable scenarios:");
    for (const s of scenarios) console.log(`  ${s.name}`);
    process.exit(0);
  }

  const config = createTestConfig();
  await loadPersistentState(config.paths.stateFile);
  rememberTelegramUser({ id: 1, username: "admin_test", first_name: "Admin", last_name: "Test" });
  const agentService = new AiService(config);

  try {
    await agentService.ensureReady();
  } catch {
    console.error("❌ Pi SDK is not ready. Configure an authenticated model first.");
    process.exit(1);
  }

  const scenario = scenarios[scenarioNum - 1]!;
  console.log(`\n🧪 Running: ${scenario.name}\n`);

  try {
    await scenario.run(config, agentService);
    console.log(`\n✅ Completed: ${scenario.name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log({ scenario: scenario.name, status: "error", error: message });
    console.error(`\n❌ Failed: ${scenario.name} — ${message}`);
  }

  agentService.stop();
}

main().catch((error) => { console.error("Fatal:", error); process.exit(1); });
