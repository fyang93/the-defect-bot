import { describe, expect, test, vi } from "vitest";
import { SessionBroker } from "../src/bot/ai/session-broker";

describe("SessionBroker interruption", () => {
  test("aborts a running turn without disposing its conversation history", async () => {
    const abort = vi.fn(async () => undefined);
    const dispose = vi.fn(() => undefined);
    const session = { abort, dispose };
    const create = vi.fn(async () => ({ sessionId: "session-1", session }));
    const broker = new SessionBroker(create);

    const before = await broker.getOrCreate("user:one", "User one");
    expect(await broker.abort("user:one")).toBe(true);
    const after = await broker.getOrCreate("user:one", "User one");

    expect(after.session).toBe(before.session);
    expect(after.sessionId).toBe(before.sessionId);
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
  });

  test("updates existing sessions in place without resetting them", async () => {
    const sessions = [
      { abort: vi.fn(async () => undefined), dispose: vi.fn(() => undefined), model: "old" },
      { abort: vi.fn(async () => undefined), dispose: vi.fn(() => undefined), model: "old" },
    ];
    let index = 0;
    const broker = new SessionBroker(async () => ({ sessionId: `session-${index}`, session: sessions[index++] }));
    await broker.getOrCreate("user:one");
    await broker.getOrCreate("user:two");

    const updated = await broker.forEachSession((session) => { session.model = "new"; });

    expect(updated).toBe(2);
    expect(sessions.map((session) => session.model)).toEqual(["new", "new"]);
    expect(sessions.every((session) => session.dispose.mock.calls.length === 0)).toBe(true);
  });
});
