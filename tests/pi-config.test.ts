import { describe, expect, test } from "bun:test";
import { buildProjectSystemPrompt } from "../src/bot/ai/prompt";

describe("role prompts stay aligned with current routing design", () => {
  test("assistant prompt stays narrow", () => {
    const assistant = buildProjectSystemPrompt("简洁", "assistant");

    expect(assistant).toContain("Follow the Defect Bot assistant instructions loaded from AGENTS.md.");
    expect(assistant).toContain("Do the work, then return one user-visible reply.");
    expect(assistant.length).toBeLessThan(400);
  });
});
