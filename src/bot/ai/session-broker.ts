export type SessionBrokerEntry<TSession extends { abort: () => Promise<unknown>; dispose: () => void }> = {
  sessionId: string;
  session: TSession;
};

type StoredSession<TSession extends { abort: () => Promise<unknown>; dispose: () => void }> = SessionBrokerEntry<TSession> & {
  lastUsedAt: number;
};

export class SessionBroker<TSession extends { abort: () => Promise<unknown>; dispose: () => void }> {
  private readonly sessions = new Map<string, StoredSession<TSession>>();

  constructor(
    private readonly create: (scopeKey?: string, scopeLabel?: string) => Promise<SessionBrokerEntry<TSession>>,
    private readonly maxIdleMs = 30 * 60 * 1000,
  ) {}

  async getOrCreate(scopeKey?: string, scopeLabel?: string): Promise<SessionBrokerEntry<TSession>> {
    const key = this.key(scopeKey);
    const existing = this.sessions.get(key);
    if (existing) {
      if (Date.now() - existing.lastUsedAt < this.maxIdleMs) {
        existing.lastUsedAt = Date.now();
        return existing;
      }
      await this.dispose(scopeKey);
    }
    const created = await this.create(scopeKey, scopeLabel);
    this.sessions.set(key, { ...created, lastUsedAt: Date.now() });
    return created;
  }

  touch(scopeKey?: string): void {
    const existing = this.sessions.get(this.key(scopeKey));
    if (existing) existing.lastUsedAt = Date.now();
  }

  async reset(scopeKey?: string, scopeLabel?: string): Promise<SessionBrokerEntry<TSession>> {
    await this.dispose(scopeKey);
    const created = await this.create(scopeKey, scopeLabel);
    this.sessions.set(this.key(scopeKey), { ...created, lastUsedAt: Date.now() });
    return created;
  }

  async abort(scopeKey?: string): Promise<boolean> {
    const entry = this.sessions.get(this.key(scopeKey));
    if (!entry) return false;
    await entry.session.abort();
    entry.lastUsedAt = Date.now();
    return true;
  }

  async forEachSession(visitor: (session: TSession) => Promise<void> | void): Promise<number> {
    const entries = [...this.sessions.values()];
    await Promise.all(entries.map(async (entry) => {
      await visitor(entry.session);
      entry.lastUsedAt = Date.now();
    }));
    return entries.length;
  }

  async dispose(scopeKey?: string): Promise<boolean> {
    const key = this.key(scopeKey);
    const entry = this.sessions.get(key);
    if (!entry) return false;
    try {
      await entry.session.abort().catch(() => {});
      entry.session.dispose();
    } finally {
      this.sessions.delete(key);
    }
    return true;
  }

  async disposeAll(): Promise<void> {
    const keys = [...this.sessions.keys()];
    await Promise.all(keys.map((key) => this.dispose(key)));
  }

  private key(scopeKey?: string): string {
    return scopeKey?.trim() || "global";
  }
}
