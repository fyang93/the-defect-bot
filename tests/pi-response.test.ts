import { describe, expect, test } from "vitest";
import { assistantErrorFromMessages } from "../src/bot/ai/pi-response";
import { formatQuotaWindows } from "../src/bot/ai/quota";
import { userFacingAssistantError } from "../src/bot/runtime/assistant";

describe("Pi response diagnostics", () => {
  test("surfaces provider errors instead of treating them as empty replies", () => {
    const error = assistantErrorFromMessages([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", stopReason: "error", errorMessage: "401 Invalid bearer token", content: [] },
    ]);
    expect(error).toBe("401 Invalid bearer token");
    expect(userFacingAssistantError(new Error(`Pi model request failed: ${error}`))).toContain("鉴权失败");
  });

  test("formats remaining Codex quota", () => {
    expect(formatQuotaWindows([
      { label: "5h", usedPercent: 20 },
      { label: "week", usedPercent: 35 },
    ], "left")).toBe("5h 80% left / week 65% left");
  });
});
