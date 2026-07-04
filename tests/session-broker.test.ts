import { describe, expect, test } from "vitest";
import { SessionBroker } from "../src/bot/ai/session-broker";

function makeSession(id: string) {
  return {
    sessionId: id,
    session: {
      abort: async () => {},
      dispose: () => {},
    },
  };
}

describe("SessionBroker", () => {
  test("reuses active sessions", async () => {
    let created = 0;
    const broker = new SessionBroker(async () => makeSession(`s${++created}`), 60_000);

    expect((await broker.getOrCreate("u")).sessionId).toBe("s1");
    expect((await broker.getOrCreate("u")).sessionId).toBe("s1");
    expect(created).toBe(1);
  });

  test("replaces idle sessions", async () => {
    let created = 0;
    const broker = new SessionBroker(async () => makeSession(`s${++created}`), 0);

    expect((await broker.getOrCreate("u")).sessionId).toBe("s1");
    expect((await broker.getOrCreate("u")).sessionId).toBe("s2");
    expect(created).toBe(2);
  });
});
