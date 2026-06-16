import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  type AuthStorage,
  type ModelRegistry,
  type ResourceLoader,
  type SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "bot/app/types";
import { logger } from "bot/app/logger";
import type { PiPromptRole } from "./pi-response";

export type CreateSessionOptions = {
  noContextFiles?: boolean;
  noSkills?: boolean;
  toolAllowlist?: string[];
};

export type PiSessionEntry = {
  sessionId: string;
  session: AgentSession;
};

type ResourceBundle = {
  loader: ResourceLoader;
  settingsManager: SettingsManager;
};

export class PiSessionFactory {
  private readonly resourceLoaders = new Map<string, Promise<ResourceBundle>>();

  constructor(private readonly deps: {
    config: AppConfig;
    agentDir: () => string;
    authStorage: AuthStorage;
    modelRegistry: ModelRegistry;
    sessionManager: SessionManager;
    ensureReady: () => Promise<void>;
    selectedModel: () => any | undefined;
    systemPromptForRole: (role: PiPromptRole) => string;
  }) {}

  updateConfig(config: AppConfig): void {
    this.deps.config = config;
    this.clearResourceLoaders();
  }

  clearResourceLoaders(): void {
    this.resourceLoaders.clear();
  }

  async createSession(scopeKey: string | undefined, scopeLabel: string | undefined, role: PiPromptRole, useTools = role === "assistant", options: CreateSessionOptions = {}): Promise<PiSessionEntry> {
    const startedAt = Date.now();
    await this.deps.ensureReady();
    const selected = this.deps.selectedModel();
    const { loader, settingsManager } = await this.getResourceLoader(role, useTools, options);
    const { session } = await createAgentSession({
      cwd: this.deps.config.paths.repoRoot,
      agentDir: this.deps.agentDir(),
      authStorage: this.deps.authStorage,
      modelRegistry: this.deps.modelRegistry,
      model: selected,
      resourceLoader: loader,
      sessionManager: this.deps.sessionManager,
      settingsManager,
      noTools: useTools ? undefined : "all",
      tools: options.toolAllowlist,
    });
    if (scopeLabel?.trim()) session.setSessionName(scopeLabel.trim());
    await logger.info(`pi sdk session created ms=${Date.now() - startedAt} scope=${JSON.stringify(scopeKey || "global")} title=${JSON.stringify(scopeLabel?.trim() || "")} role=${role} tools=${useTools}`);
    return { sessionId: session.sessionId, session };
  }

  private getResourceLoader(role: PiPromptRole, useTools: boolean, options: CreateSessionOptions = {}): Promise<ResourceBundle> {
    const noContextFiles = options.noContextFiles ?? !useTools;
    const noSkills = options.noSkills ?? !useTools;
    const key = `${role}:${useTools ? "tools" : "no-tools"}:context=${!noContextFiles}:skills=${!noSkills}`;
    const cached = this.resourceLoaders.get(key);
    if (cached) return cached;

    const promise = (async () => {
      const startedAt = Date.now();
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 2 },
      });
      const loader = new DefaultResourceLoader({
        cwd: this.deps.config.paths.repoRoot,
        agentDir: this.deps.agentDir(),
        settingsManager,
        systemPromptOverride: () => this.deps.systemPromptForRole(role),
        appendSystemPromptOverride: () => [],
        noExtensions: !useTools,
        noSkills,
        noPromptTemplates: true,
        noContextFiles,
      });
      await loader.reload();
      const extensions = loader.getExtensions().extensions.length;
      const skills = loader.getSkills().skills.length;
      await logger.info(`pi sdk resources loaded ms=${Date.now() - startedAt} role=${role} tools=${useTools} extensions=${extensions} skills=${skills}`);
      return { loader, settingsManager };
    })().catch((error) => {
      this.resourceLoaders.delete(key);
      throw error;
    });

    this.resourceLoaders.set(key, promise);
    return promise;
  }
}
