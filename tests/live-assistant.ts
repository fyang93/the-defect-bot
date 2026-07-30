import { loadConfig } from "../src/bot/app/config";
import { loadPersistentState } from "../src/bot/app/state";
import { AiService } from "../src/bot/ai/gateway";

const request = process.argv.slice(2).join(" ").trim() || "你好，请简短介绍你能做什么。";
const config = loadConfig();
await loadPersistentState(config.paths.stateFile);
const service = new AiService(config);
try {
  const result = await service.runAssistantTurn({
    userRequestText: request,
    requesterUserId: "live-test-user",
    chatId: "live-test-chat",
    chatType: "p2p",
    permissionMode: "full",
    uploadedFiles: [],
    attachments: [],
    scopeKey: "user:live-test-user",
    scopeLabel: "live test",
  });
  process.stdout.write(`${result.message}\n`);
} finally {
  service.stop();
}
