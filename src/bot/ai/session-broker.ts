export type SessionBrokerEntry<TSession extends { abort: () => Promise<unknown>; dispose: () => void }> = {
  sessionId: string;
  session: TSession;
};

export class SessionBroker<TSession extends { abort: () => Promise<unknown>; dispose: () => void }> {
  private readonly sessions = new Map<string, SessionBrokerEntry<TSession>>();

  constructor(
    private readonly create: (scopeKey?: string, scopeLabel?: string) => Promise<SessionBrokerEntry<TSession>>,
    private readonly abort: (sessionId: string) => Promise<void>,
  ) {}

  async getOrCreate(scopeKey?: string, scopeLabel?: string): Promise<SessionBrokerEntry<TSession>> {
    const key = this.key(scopeKey);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const created = await this.create(scopeKey, scopeLabel);
    this.sessions.set(key, created);
    return created;
  }

  async reset(scopeKey?: string, scopeLabel?: string): Promise<SessionBrokerEntry<TSession>> {
    await this.dispose(scopeKey);
    const created = await this.create(scopeKey, scopeLabel);
    this.sessions.set(this.key(scopeKey), created);
    return created;
  }

  async dispose(scopeKey?: string): Promise<boolean> {
    const key = this.key(scopeKey);
    const entry = this.sessions.get(key);
    if (!entry) return false;
    try {
      await entry.session.abort().catch(() => {});
      entry.session.dispose();
      await this.abort(entry.sessionId);
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
