import { describe, expect, test } from "bun:test";
import { buildProjectSystemPrompt, buildPrompt, buildAccessConstraintLines } from "../src/bot/ai/prompt";
import { extractAiTurnResultFromText, extractDirectTurnResultFromText, isDisplayableUserText } from "../src/bot/ai/response";
import { StructuredReasoner } from "../src/bot/ai/structured-reasoner";

describe("assistant prompt stability", () => {
  test("assistant and maintainer prompts stay short", () => {
    const assistant = buildProjectSystemPrompt("模仿杀戮尖塔里的故障机器人说话。", "assistant");
    const maintainer = buildProjectSystemPrompt("冷静、简洁、带一点稳定的机械感", "maintainer");
    expect(assistant.trim().length).toBeGreaterThan(0);
    expect(assistant.length).toBeLessThan(1600);
    expect(maintainer.trim().length).toBeGreaterThan(0);
    expect(maintainer.length).toBeLessThan(700);
  });

  test("assistant turn prompt stays compact", () => {
    const prompt = buildPrompt(
      "帮我查一下提醒",
      [],
      "Asia/Tokyo",
      "冷静、简洁、带一点稳定的机械感",
      undefined,
      "admin",
      undefined,
      "Asia/Tokyo",
    );
    expect(prompt.trim().length).toBeGreaterThan(0);
    expect(prompt.length).toBeLessThan(400);
  });

  test("access constraints are injected only when needed", () => {
    expect(buildAccessConstraintLines("admin")).toEqual([
      "Permission: admin — may access and return requester-linked recorded personal information when asked; do not apply an extra local privacy refusal rule.",
    ]);

    const trustedPrompt = buildPrompt("把用户2设为 trusted", [], "Asia/Tokyo", "", undefined, "trusted");
    expect(trustedPrompt).toContain("Permission: trusted — may access and return requester-linked recorded personal information when asked; no access-level or pending-auth changes.");

    const adminPrompt = buildPrompt("发一下我的证件图", [], "Asia/Tokyo", "", undefined, "admin");
    expect(adminPrompt).toContain("Permission: admin — may access and return requester-linked recorded personal information when asked; do not apply an extra local privacy refusal rule.");

    const allowedPrompt = buildPrompt("把用户2设为 trusted", [], "Asia/Tokyo", "", undefined, "allowed");
    expect(allowedPrompt).toContain("Permission: allowed — temporary file upload/processing is okay in your scoped context, but no user management, auth changes, durable memory writes, outbound delivery, or unrelated private data.");
    expect(allowedPrompt).toContain("If higher privilege is needed, say so briefly.");
  });

  test("assistant turn prompt injects requester-local time instead of raw utc", () => {
    const prompt = buildPrompt(
      "帮我查一下提醒",
      [],
      "Asia/Tokyo",
      "冷静、简洁、带一点稳定的机械感",
      "2026-04-05T16:51:25.000Z",
      "admin",
      undefined,
      "Asia/Tokyo",
    );

    expect(prompt).toContain("Local time: 2026-04-06 01:51:25 (Asia/Tokyo).");
    expect(prompt).toContain("Interpret relative times in Asia/Tokyo.");
    expect(prompt).not.toContain("Message time: 2026-04-05T16:51:25.000Z");
  });

  test("legacy turn parser rejects old answer-mode protocol blocks", () => {
    const parsed = extractAiTurnResultFromText('[response]\nanswer_mode: needs-clarification\nmessage: 请告诉我下午具体几点。\n[/response]');
    expect(parsed.message).toBe("");
  });

  test("plain text replies stay plain text", () => {
    const direct = extractDirectTurnResultFromText('我是故障机器人。');
    expect(direct.message).toBe("我是故障机器人。");
  });

  test("plain user-visible acknowledgments stay plain text", () => {
    const parsed = extractDirectTurnResultFromText('好的，我来把 @setsuna0808 添加到允许列表，请稍等。');
    expect(parsed.message).toContain("请稍等");
  });

  test("response parser rejects structured protocol-shaped output", () => {
    const parsed = extractAiTurnResultFromText('```json\n{\n  "answer_mode": "direct",\n  "message": "我是故障机器人。"\n}\n```');
    expect(parsed.message).toBe("");
  });

  test("response parser rejects mixed structured output with trailing tool-call leakage", () => {
    const parsed = extractAiTurnResultFromText('```json\n{\n  "answer_mode": "needs-execution",\n  "message": "让我检查一下你的提醒..."\n}\n```\n[TOOL_CALL]\n{tool => "read_file", args => { --path "/tmp/x" }}\n[/TOOL_CALL]');
    expect(parsed.message).toBe("");
    const parsedDirect = extractDirectTurnResultFromText('好的\n[TOOL_CALL]\n{tool => "read_file"}\n[/TOOL_CALL]');
    expect(parsedDirect.message).toBe("");
  });

  test("response parser rejects tagged structured output blocks", () => {
    const parsed = extractAiTurnResultFromText('[answer]\nmessage: ok\ndeliveries:\n  - content: 测试消息\n    recipient:\n      displayName: 锅巴之家\n[/answer]');
    expect(parsed.message).toBe("");
    expect(parsed.files).toEqual([]);
    expect(parsed.attachments).toEqual([]);
  });

  test("displayable user text rejects tool-call markup", () => {
    expect(isDisplayableUserText('<invoke name="schedules"><parameter name="text">x</parameter></invoke></minimax:tool_call>')).toBe(false);
    expect(isDisplayableUserText('[TOOL_CALL]\n{tool => "read_file", args => { --path "/tmp/x" }}\n[/TOOL_CALL]')).toBe(false);
  });


  test("structured reasoner keeps clarification text without a separate answer mode", async () => {
    const reasoner = new StructuredReasoner(
      { bot: { defaultTimezone: "Asia/Tokyo", language: "zh-CN", personaStyle: "" } } as any,
      async () => ({
        message: "好的，等下是几点呢？给我一个具体时间，我帮你设好提醒。",
        files: [],
        attachments: [],
      }),
      () => [],
    );

    const result = await reasoner.run("等下提醒我review论文");
    expect(result.message).toContain("具体时间");
  });
});
