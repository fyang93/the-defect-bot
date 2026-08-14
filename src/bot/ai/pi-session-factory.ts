import { existsSync } from "node:fs";
import { Module } from "node:module";
import path from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  type AgentSession,
  type AgentSessionServices,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "bot/app/types";
import { logger } from "bot/app/logger";
import type { PiPromptRole } from "./pi-response";

export type PiSessionEntry = {
  sessionId: string;
  session: AgentSession;
};

export class PiSessionFactory {
  private readonly services = new Map<string, Promise<AgentSessionServices>>();

  constructor(private readonly deps: {
    config: AppConfig;
    cwd: () => string;
    agentDir: () => string;
    modelRuntime: () => Promise<ModelRuntime>;
    ensureReady: () => Promise<void>;
    selectedModel: () => any | undefined;
    appendSystemPromptForRole: (role: PiPromptRole) => string[];
  }) {}

  updateConfig(config: AppConfig): void {
    this.deps.config = config;
    this.services.clear();
  }

  async createSession(scopeKey: string | undefined, scopeLabel: string | undefined, role: PiPromptRole): Promise<PiSessionEntry> {
    const startedAt = Date.now();
    await this.deps.ensureReady();
    const services = await this.getServices(role);
    const { session } = await createAgentSessionFromServices({
      services,
      model: this.deps.selectedModel(),
      sessionManager: SessionManager.inMemory(this.deps.cwd()),
    });
    if (scopeLabel?.trim()) session.setSessionName(scopeLabel.trim());
    const activeToolSummary = this.summarizeActiveTools(session.getActiveToolNames());
    await logger.info(`pi sdk session created ms=${Date.now() - startedAt} scope=${JSON.stringify(scopeKey || "global")} title=${JSON.stringify(scopeLabel?.trim() || "")} role=${role} tools=default activeTools=${JSON.stringify(activeToolSummary)}`);
    return { sessionId: session.sessionId, session };
  }

  private getServices(role: PiPromptRole): Promise<AgentSessionServices> {
    const cached = this.services.get(role);
    if (cached) return cached;

    const promise = (async () => {
      const startedAt = Date.now();
      this.ensureBotSourceResolution();
      const settingsManager = SettingsManager.create(this.deps.cwd(), this.deps.agentDir());
      settingsManager.applyOverrides({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 2 },
      });
      const services = await createAgentSessionServices({
        cwd: this.deps.cwd(),
        agentDir: this.deps.agentDir(),
        modelRuntime: await this.deps.modelRuntime(),
        settingsManager,
        resourceLoaderOptions: {
          appendSystemPromptOverride: (base) => [...base, ...this.deps.appendSystemPromptForRole(role)],
        },
      });
      const extensionResult = services.resourceLoader.getExtensions();
      const extensions = extensionResult.extensions.length;
      const skills = services.resourceLoader.getSkills().skills.length;
      for (const error of extensionResult.errors) {
        await logger.warn(`pi sdk extension load failed path=${JSON.stringify(error.path)} error=${JSON.stringify(error.error)}`);
      }
      for (const diagnostic of services.diagnostics) {
        await logger.warn(`pi sdk resource diagnostic type=${diagnostic.type} message=${JSON.stringify(diagnostic.message)}`);
      }
      await logger.info(`pi sdk resources loaded ms=${Date.now() - startedAt} role=${role} mode=default extensions=${extensions} extensionErrors=${extensionResult.errors.length} skills=${skills}`);
      return services;
    })().catch((error) => {
      this.services.delete(role);
      throw error;
    });

    this.services.set(role, promise);
    return promise;
  }

  private summarizeActiveTools(names: string[]): string {
    const builtin = names.filter((name) => ["read", "bash", "edit", "write"].includes(name));
    const web = names.filter((name) => ["web_search", "fetch_content", "get_search_content"].includes(name));
    const bot = names.filter((name) => /^(event|feishu|user)_/.test(name));
    const other = names.length - builtin.length - web.length - bot.length;
    return `total=${names.length} builtin=${builtin.join(",") || "none"} web=${web.length} bot=${bot.length} other=${other}`;
  }

  private ensureBotSourceResolution(): void {
    const srcDir = path.join(this.deps.config.paths.repoRoot, "src");
    if (!existsSync(srcDir)) return;
    const paths = (process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean);
    if (paths.includes(srcDir)) return;
    process.env.NODE_PATH = [srcDir, ...paths].join(path.delimiter);
    (Module as unknown as { _initPaths: () => void })._initPaths();
  }
}
