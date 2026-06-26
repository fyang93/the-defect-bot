import { existsSync, readFileSync } from "node:fs";
import { Module } from "node:module";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  type AuthStorage,
  type ModelRegistry,
  type ResourceLoader,
  SessionManager,
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
    cwd: () => string;
    agentDir: () => string;
    authStorage: AuthStorage;
    modelRegistry: ModelRegistry;
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
      cwd: this.deps.cwd(),
      agentDir: this.deps.agentDir(),
      authStorage: this.deps.authStorage,
      modelRegistry: this.deps.modelRegistry,
      model: selected,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(this.deps.cwd()),
      settingsManager,
      noTools: useTools ? undefined : "all",
      tools: options.toolAllowlist,
    });
    if (scopeLabel?.trim()) session.setSessionName(scopeLabel.trim());
    const toolNames = options.toolAllowlist?.join(",") || (useTools ? "default" : "none");
    const activeToolSummary = useTools ? this.summarizeActiveTools(session.getActiveToolNames()) : "none";
    await logger.info(`pi sdk session created ms=${Date.now() - startedAt} scope=${JSON.stringify(scopeKey || "global")} title=${JSON.stringify(scopeLabel?.trim() || "")} role=${role} tools=${useTools} toolNames=${JSON.stringify(toolNames)} activeTools=${JSON.stringify(activeToolSummary)}`);
    return { sessionId: session.sessionId, session };
  }

  private assistantAgentsFile(): { path: string; content: string } | null {
    const filePath = path.join(this.deps.cwd(), "AGENTS.md");
    return existsSync(filePath) ? { path: filePath, content: readFileSync(filePath, "utf8") } : null;
  }

  private getResourceLoader(role: PiPromptRole, useTools: boolean, options: CreateSessionOptions = {}): Promise<ResourceBundle> {
    const noContextFiles = options.noContextFiles ?? !useTools;
    const noSkills = options.noSkills ?? !useTools;
    const key = `${role}:${useTools ? "tools" : "no-tools"}:context=${!noContextFiles}:skills=${!noSkills}`;
    const cached = this.resourceLoaders.get(key);
    if (cached) return cached;

    const promise = (async () => {
      const startedAt = Date.now();
      this.ensureBotSourceResolution();
      const settingsManager = SettingsManager.create(this.deps.cwd(), this.deps.agentDir());
      settingsManager.applyOverrides({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 2 },
      });
      const loader = new DefaultResourceLoader({
        cwd: this.deps.cwd(),
        agentDir: this.deps.agentDir(),
        settingsManager,
        systemPromptOverride: () => this.deps.systemPromptForRole(role),
        appendSystemPromptOverride: () => [],
        noSkills,
        noPromptTemplates: true,
        noContextFiles,
        agentsFilesOverride: noContextFiles
          ? undefined
          : () => {
              const assistantAgents = this.assistantAgentsFile();
              return { agentsFiles: assistantAgents ? [assistantAgents] : [] };
            },
      });
      await loader.reload();
      const extensionResult = loader.getExtensions();
      const extensions = extensionResult.extensions.length;
      const skills = loader.getSkills().skills.length;
      for (const error of extensionResult.errors) {
        await logger.warn(`pi sdk extension load failed path=${JSON.stringify(error.path)} error=${JSON.stringify(error.error)}`);
      }
      await logger.info(`pi sdk resources loaded ms=${Date.now() - startedAt} role=${role} tools=${useTools} extensions=${extensions} extensionErrors=${extensionResult.errors.length} skills=${skills}`);
      return { loader, settingsManager };
    })().catch((error) => {
      this.resourceLoaders.delete(key);
      throw error;
    });

    this.resourceLoaders.set(key, promise);
    return promise;
  }

  private summarizeActiveTools(names: string[]): string {
    const builtin = names.filter((name) => ["read", "bash", "edit", "write"].includes(name));
    const web = names.filter((name) => ["web_search", "fetch_content", "get_search_content"].includes(name));
    const bot = names.filter((name) => /^(event|telegram|user|auth)_/.test(name));
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
