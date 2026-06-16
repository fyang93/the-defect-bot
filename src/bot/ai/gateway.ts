import path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig, AiAttachment, UploadedFile } from "bot/app/types";
import { logger } from "bot/app/logger";
import { formatIsoInTimezoneParts } from "bot/app/time";
import { state, touchActivity } from "bot/app/state";
import { buildAccessConstraintLines, buildProjectSystemPrompt, type RequestAccessRole } from "./prompt";
import { extractAiTurnResultFromText, isDisplayableUserText } from "./response";
import type { AiTurnResult, AssistantPlanResult, AssistantProgressHandler, ReminderTextContext } from "./types";
import { ReplyComposer, type ReplyComposerInputContext } from "./reply-composer";
import { StructuredReasoner } from "./structured-reasoner";

export type { AiTurnResult } from "./types";

type SessionEntry = {
  sessionId: string;
  session: AgentSession;
};

type PromptRole = "assistant" | "maintainer" | "writer";

type AttachmentCapabilityCache = {
  modelKey: string;
  supportsAttachments: boolean;
  checkedAt: number;
};

type ResourceBundle = {
  loader: ResourceLoader;
  settingsManager: SettingsManager;
};

const MODEL_CAPABILITY_CACHE_MS = 60_000;
const MODEL_REGISTRY_REFRESH_CACHE_MS = 60_000;

class SessionBroker {
  constructor(
    private readonly create: (scopeKey?: string, scopeLabel?: string) => Promise<SessionEntry>,
    private readonly abort: (sessionId: string) => Promise<void>,
  ) {}

  private readonly sessions = new Map<string, SessionEntry>();

  private key(scopeKey?: string): string {
    return scopeKey?.trim() || "global";
  }

  async getOrCreate(scopeKey?: string, scopeLabel?: string): Promise<SessionEntry> {
    const key = this.key(scopeKey);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const created = await this.create(scopeKey, scopeLabel);
    this.sessions.set(key, created);
    return created;
  }

  async reset(scopeKey?: string, scopeLabel?: string): Promise<SessionEntry> {
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
}

function parseModel(model: string | null): { providerID: string; modelID: string } | null {
  if (!model) return null;
  const index = model.indexOf("/");
  if (index <= 0 || index === model.length - 1) return null;
  return {
    providerID: model.slice(0, index),
    modelID: model.slice(index + 1),
  };
}

function extractText(message: unknown): string {
  const record = message && typeof message === "object" ? message as { content?: unknown } : {};
  if (typeof record.content === "string") return record.content.trim();
  const typedRecord = record as { content?: Array<{ type?: string; text?: string }> };
  const content = Array.isArray(typedRecord.content) ? typedRecord.content : [];
  const texts = content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text?.trim())
    .filter(Boolean);
  return texts.length > 0 ? texts.join("\n\n") : "";
}

function extractAssistantText(message: unknown): string {
  const record = message && typeof message === "object" ? message as { role?: string } : {};
  if (record.role !== "assistant") return "";
  return extractText(message);
}

function summarizeExecutionParts(parts: unknown): Array<{ tool: string; status: string; inputChars: number; outputChars: number }> {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const record = part as Record<string, unknown>;
    if (record.type !== "tool" && record.type !== "toolCall") return [];
    const tool = typeof record.tool === "string" ? record.tool.trim() : typeof record.name === "string" ? record.name.trim() : "";
    const stateRecord = record.state && typeof record.state === "object" ? record.state as Record<string, unknown> : null;
    const status = stateRecord && typeof stateRecord.status === "string" ? stateRecord.status.trim() : "unknown";
    const input = stateRecord?.input;
    const output = stateRecord?.output;
    return [{
      tool,
      status,
      inputChars: typeof input === "string" ? input.length : JSON.stringify(input || "").length,
      outputChars: typeof output === "string" ? output.length : JSON.stringify(output || "").length,
    }];
  });
}

function summarizeToolResults(messages: unknown): Array<{ tool: string; status: string; inputChars: number; outputChars: number }> {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const record = message as Record<string, unknown>;
    if (record.role !== "toolResult") return [];
    const content = Array.isArray(record.content) ? record.content : [];
    const output = content.map((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text" ? String((part as Record<string, unknown>).text || "") : "").join("\n");
    return [{
      tool: typeof record.toolName === "string" ? record.toolName : "unknown",
      status: record.isError ? "error" : "completed",
      inputChars: 0,
      outputChars: output.length,
    }];
  });
}

function summarizeMessagesForDebug(messages: unknown[]): Array<{ role: string; content: string; partTypes: string[]; textChars: number }> {
  return messages.map((message) => {
    const record = message && typeof message === "object" ? message as Record<string, unknown> : {};
    const content = record.content;
    const partTypes = Array.isArray(content)
      ? content.map((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).type === "string" ? String((part as Record<string, unknown>).type) : typeof part).slice(0, 12)
      : [];
    return {
      role: typeof record.role === "string" ? record.role : "unknown",
      content: Array.isArray(content) ? "array" : typeof content,
      partTypes,
      textChars: extractText(message).length,
    };
  });
}

function ensureNoToolExecution(role: PromptRole | undefined, parts: unknown): void {
  if (!role || role === "assistant") return;
  const executionParts = summarizeExecutionParts(parts);
  if (executionParts.length === 0) return;
  throw new Error(`${role} text generation must not execute tools`);
}

export class AiService {
  private config: AppConfig;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly sessionManager: SessionManager;
  private readonly sessions: SessionBroker;
  private readonly replyComposer: ReplyComposer;
  private readonly structuredReasoner: StructuredReasoner;
  private readonly resourceLoaders = new Map<string, Promise<ResourceBundle>>();
  private modelRegistryLastRefreshAt = 0;
  private attachmentCapabilityCache: AttachmentCapabilityCache | null = null;

  constructor(config: AppConfig) {
    this.config = config;
    this.authStorage = AuthStorage.create(path.join(this.piAgentDir(), "auth.json"));
    this.modelRegistry = ModelRegistry.create(this.authStorage, path.join(this.piAgentDir(), "models.json"));
    this.sessionManager = SessionManager.inMemory(this.config.paths.repoRoot);
    this.sessions = new SessionBroker(
      (scopeKey, scopeLabel) => this.createSession(scopeKey, scopeLabel, "assistant"),
      async (_sessionId) => {},
    );
    this.replyComposer = new ReplyComposer(
      config,
      (text) => this.promptInLightTextSession(text, "writer"),
      (text) => this.promptInLightTextSession(text, "writer"),
    );
    this.structuredReasoner = new StructuredReasoner(config, (promptText, attachments, scopeKey) => this.promptAssistantTurn(promptText, attachments, scopeKey), (attachments) => this.attachmentLogSummary(attachments));
  }

  private agentWorkspaceDir(): string {
    return path.join(this.config.paths.repoRoot, "agent");
  }

  private piAgentDir(): string {
    return path.join(this.agentWorkspaceDir(), ".pi");
  }

  reloadConfig(config: AppConfig): void {
    this.config = config;
    this.replyComposer.updateConfig(config);
    this.structuredReasoner.updateConfig(config);
    this.resourceLoaders.clear();
    this.stop();
  }

  async ensureReady(): Promise<void> {
    const startedAt = Date.now();
    if (Date.now() - this.modelRegistryLastRefreshAt > MODEL_REGISTRY_REFRESH_CACHE_MS) {
      this.modelRegistry.refresh();
      this.modelRegistryLastRefreshAt = Date.now();
    }
    const available = this.modelRegistry.getAvailable();
    if (available.length === 0) {
      throw new Error("Pi SDK has no authenticated models available. Configure credentials in agent/.pi/auth.json, environment variables, or agent/.pi/models.json.");
    }
    await logger.info(`pi sdk ready ms=${Date.now() - startedAt} models=${available.length}`);
  }

  private getResourceLoader(role: PromptRole, useTools: boolean): Promise<ResourceBundle> {
    const key = `${role}:${useTools ? "tools" : "no-tools"}`;
    const cached = this.resourceLoaders.get(key);
    if (cached) return cached;

    const promise = (async () => {
      const startedAt = Date.now();
      // Use an in-memory settings manager for bot-created sessions. This keeps
      // Pi from re-reading/installing package resources on every /new session
      // while still loading our local agent/.pi resources once per process.
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 2 },
      });
      const loader = new DefaultResourceLoader({
        cwd: this.config.paths.repoRoot,
        agentDir: this.piAgentDir(),
        settingsManager,
        systemPromptOverride: () => this.systemPromptForRole(role),
        appendSystemPromptOverride: () => [],
        noExtensions: !useTools,
        noSkills: !useTools,
        noPromptTemplates: true,
        noContextFiles: !useTools,
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

  private selectedModel(): any | undefined {
    const parsed = parseModel(state.model);
    return parsed ? this.modelRegistry.find(parsed.providerID, parsed.modelID) : undefined;
  }

  private async createSession(scopeKey: string | undefined, scopeLabel: string | undefined, role: PromptRole, useTools = role === "assistant"): Promise<SessionEntry> {
    const startedAt = Date.now();
    await this.ensureReady();
    const selected = this.selectedModel();
    if (state.model && !selected) {
      throw new Error(`Selected model is unavailable: ${state.model}`);
    }
    const { loader, settingsManager } = await this.getResourceLoader(role, useTools);
    const { session } = await createAgentSession({
      cwd: this.config.paths.repoRoot,
      agentDir: this.piAgentDir(),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      model: selected,
      resourceLoader: loader,
      sessionManager: this.sessionManager,
      settingsManager,
      noTools: useTools ? undefined : "all",
    });
    if (scopeLabel?.trim()) session.setSessionName(scopeLabel.trim());
    await logger.info(`pi sdk session created ms=${Date.now() - startedAt} scope=${JSON.stringify(scopeKey || "global")} title=${JSON.stringify(scopeLabel?.trim() || "")} role=${role} tools=${useTools}`);
    return { sessionId: session.sessionId, session };
  }

  private async getOrCreateSession(scopeKey?: string, scopeLabel?: string): Promise<SessionEntry> {
    return this.sessions.getOrCreate(scopeKey, scopeLabel);
  }

  private async disposeSession(scopeKey?: string): Promise<boolean> {
    return this.sessions.dispose(scopeKey);
  }

  async newSession(scopeKey?: string, scopeLabel?: string): Promise<string> {
    const entry = await this.sessions.reset(scopeKey, scopeLabel);
    touchActivity();
    return entry.sessionId;
  }

  async abortCurrentSession(scopeKey?: string, scopeLabel?: string): Promise<boolean> {
    const aborted = await this.disposeSession(scopeKey);
    if (aborted) {
      await logger.warn(`aborted pi sdk session${scopeLabel ? ` for ${scopeLabel}` : ""}`);
      touchActivity();
    }
    return aborted;
  }

  async listModels(): Promise<{ defaults: Record<string, string>; models: string[] }> {
    await this.ensureReady();
    const models = this.modelRegistry.getAvailable().map((model: any) => `${model.provider}/${model.id}`).sort((a, b) => a.localeCompare(b));
    const current = this.selectedModel() || this.modelRegistry.getAvailable()[0];
    const defaults = current ? { [current.provider]: current.id } : {};
    return { defaults, models };
  }

  private async selectedModelSupportsAttachments(): Promise<boolean> {
    const parsed = parseModel(state.model);
    if (!parsed) return true;

    const modelKey = `${parsed.providerID}/${parsed.modelID}`;
    const now = Date.now();
    if (this.attachmentCapabilityCache?.modelKey === modelKey && now - this.attachmentCapabilityCache.checkedAt < MODEL_CAPABILITY_CACHE_MS) {
      return this.attachmentCapabilityCache.supportsAttachments;
    }

    try {
      await this.ensureReady();
      const model = this.modelRegistry.find(parsed.providerID, parsed.modelID) as any;
      const input = Array.isArray(model?.input) ? model.input : [];
      const supportsAttachments = input.length === 0 || input.includes("image");
      this.attachmentCapabilityCache = { modelKey, supportsAttachments, checkedAt: now };
      return supportsAttachments;
    } catch (error) {
      await logger.warn(`failed to inspect pi model attachment capability model=${JSON.stringify(modelKey)} message=${error instanceof Error ? error.message : String(error)}`);
      return true;
    }
  }

  private async filterAttachmentsForSelectedModel(attachments: AiAttachment[], context: string): Promise<AiAttachment[]> {
    if (attachments.length === 0) return attachments;
    if (await this.selectedModelSupportsAttachments()) return attachments;
    await logger.warn(`dropped ${attachments.length} attachment(s) before ${context} because selected model ${JSON.stringify(state.model)} does not support attachments`);
    return [];
  }

  async prompt(
    text: string,
    uploadedFiles: UploadedFile[] = [],
    attachments: AiAttachment[] = [],
    messageTime?: string,
    scopeKey?: string,
    _scopeLabel?: string,
    accessRole: RequestAccessRole = "allowed",
    sharedConversationContextText?: string,
    requesterTimezone?: string | null,
  ): Promise<AiTurnResult> {
    return this.structuredReasoner.run(text, uploadedFiles, attachments, messageTime, accessRole, scopeKey, sharedConversationContextText, requesterTimezone);
  }

  async generateStartupGreeting(input?: ReplyComposerInputContext): Promise<string | null> {
    return this.replyComposer.generateStartupGreeting(input);
  }

  async generateReminderText(reminderText: string, notifyAt: string, recurrenceDescription: string, timezone: string, context?: ReminderTextContext): Promise<string> {
    return this.replyComposer.generateReminderText(reminderText, notifyAt, recurrenceDescription, timezone, context);
  }

  async generateScheduledTaskContent(prompt: string): Promise<string> {
    const taskPrompt = prompt.trim();
    if (!taskPrompt) return "";
    const request = [
      "Generate fresh, useful content for this recurring automated task.",
      "Use tools when needed to gather current external information before writing the final message.",
      `Task prompt: ${taskPrompt}`,
    ].join("\n");
    return this.promptInDisposableAgentTextSession(request, "assistant");
  }

  async composeUserReply(baseMessage: string | null | undefined, facts: string[], input?: ReplyComposerInputContext): Promise<string> {
    return this.replyComposer.composeUserReply(baseMessage, facts, input);
  }

  async runMaintenancePass(request: string): Promise<string> {
    return (await this.promptInTemporaryTextSession(request, "maintainer")).trim();
  }

  async runAssistantTurn(input: {
    userRequestText: string;
    requesterUserId?: number;
    chatId?: number;
    chatType?: string;
    accessRole: RequestAccessRole;
    uploadedFiles?: UploadedFile[];
    attachments?: AiAttachment[];
    messageTime?: string;
    requesterTimezone?: string | null;
    sharedConversationContextText?: string;
    scopeKey?: string;
    scopeLabel?: string;
    isTaskCurrent?: () => boolean;
    onProgress?: AssistantProgressHandler;
  }): Promise<AssistantPlanResult> {
    const localMessageTime = formatIsoInTimezoneParts(input.messageTime, input.requesterTimezone?.trim() || this.config.bot.defaultTimezone);
    const nativeAttachments = input.attachments || [];
    if (nativeAttachments.length > 0) {
      await logger.warn(`deferred ${nativeAttachments.length} native attachment(s) for assistant turn; saved file paths remain available for tool-based handling`);
    }
    const policyFilteredAttachments: AiAttachment[] = [];

    const prompt = [
      "Turn context:",
      `requesterUserId=${input.requesterUserId ?? "unknown"}`,
      `chatId=${input.chatId ?? "unknown"}`,
      `chatType=${input.chatType || "unknown"}`,
      `accessRole=${input.accessRole}`,
      localMessageTime ? `requesterLocalTime=${localMessageTime.localDateTime} (${localMessageTime.timezone})` : "",
      ...buildAccessConstraintLines(input.accessRole),
      input.sharedConversationContextText?.trim() ? "Assistant context:" : "",
      input.sharedConversationContextText?.trim() || "",
      input.uploadedFiles && input.uploadedFiles.length > 0 ? "Saved files:" : "",
      ...(input.uploadedFiles || []).map((file) => `- ${file.savedPath} (${file.mimeType}, ${Math.ceil(file.sizeBytes / 1024)} KB)`),
      input.uploadedFiles && input.uploadedFiles.length > 0 ? "Use repository tools to inspect saved local files when needed. Do not claim the image/file is unsupported just because raw multimodal input is unavailable." : "",
      "User request:",
      input.userRequestText.trim(),
    ].filter(Boolean).join("\n");

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (input.isTaskCurrent && !input.isTaskCurrent()) {
        await logger.warn("assistant agent prompt skipped because task is stale");
        return { message: "", usedNativeExecution: false, completedActions: [], files: [], attachments: [] };
      }
      const attemptPrompt = attempt === 1
        ? prompt
        : [
            prompt,
            "",
            "Your previous output was invalid.",
            "Do not write XML, <invoke ...> blocks, or tool-call text.",
            "Use the needed tools, then return the final user-visible reply for this turn in the configured persona.",
          ].join("\n");
      const promptAttachments = await this.filterAttachmentsForSelectedModel(policyFilteredAttachments, "assistant turn");
      const response = await this.promptInScopedAssistantSession(attemptPrompt, promptAttachments, input.scopeKey, input.scopeLabel, input.onProgress);
      if (input.isTaskCurrent && !input.isTaskCurrent()) {
        await logger.warn("assistant agent response ignored because task became stale");
        return { message: "", usedNativeExecution: false, completedActions: response.completedActions, files: [], attachments: [] };
      }
      const rawText = response.rawText.trim();
      const parsed = extractAiTurnResultFromText(rawText);
      const hasStructuredOutputs = parsed.files.length > 0 || parsed.attachments.length > 0;
      const hasDisplayableMessage = !!parsed.message && isDisplayableUserText(parsed.message);
      if (response.usedNativeExecution) {
        if (hasDisplayableMessage || hasStructuredOutputs) {
          return {
            message: hasDisplayableMessage ? parsed.message : "",
            usedNativeExecution: response.usedNativeExecution,
            completedActions: response.completedActions,
            files: parsed.files,
            attachments: parsed.attachments,
          };
        }
        await logger.warn(`discarded assistant output attempt=${attempt} reason=non-displayable`);
        continue;
      }
      if (hasDisplayableMessage || hasStructuredOutputs) {
        return {
          message: hasDisplayableMessage ? parsed.message : "",
          usedNativeExecution: false,
          completedActions: [],
          files: parsed.files,
          attachments: parsed.attachments,
        };
      }
      await logger.warn(`discarded assistant output attempt=${attempt} reason=no-tools-and-no-displayable-text`);
    }
    throw new Error("Assistant output protocol violation: invalid turn result.");
  }

  stop(): void {
    void this.sessions.disposeAll();
  }

  private buildImages(attachments: AiAttachment[]): Array<{ type: "image"; data: string; mimeType: string }> {
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    for (const attachment of attachments) {
      if (!attachment.mimeType.startsWith("image/") || !attachment.url.startsWith("data:")) continue;
      const comma = attachment.url.indexOf(",");
      if (comma < 0) continue;
      images.push({ type: "image", data: attachment.url.slice(comma + 1), mimeType: attachment.mimeType });
    }
    return images;
  }

  private systemPromptForRole(role: PromptRole): string {
    return buildProjectSystemPrompt(this.config.bot.personaStyle, role);
  }

  private async promptInTemporaryTextSession(text: string, role: "assistant" | "maintainer"): Promise<string> {
    return this.promptInDisposableTextSession({
      title: role === "maintainer" ? "Maintainer" : "Assistant",
      role,
      useTools: role === "assistant",
      requestLog: `pi sdk ${role} text prompt request`,
      rawLogLabel: `pi sdk ${role} text prompt`,
      execute: (session) => this.promptSessionForText(session, text, [], role),
    });
  }

  private async promptInDisposableAgentTextSession(text: string, role: "assistant"): Promise<string> {
    return this.promptInDisposableTextSession({
      title: "Assistant",
      role,
      useTools: true,
      requestLog: `pi sdk ${role} text prompt request`,
      rawLogLabel: `pi sdk ${role} text prompt`,
      execute: async (session) => {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const attemptText = attempt === 1
            ? text
            : [
                text,
                "",
                "Your previous output was invalid.",
                "Use the needed tools, then return only plain user-visible text in the configured persona.",
              ].join("\n");
          const response = await this.promptSessionForAgent(session, attemptText, [], role);
          const rawText = response.rawText.trim();
          if (rawText && isDisplayableUserText(rawText)) return rawText;
          await logger.warn(`discarded ${role} output attempt=${attempt} reason=${rawText ? "non-displayable" : "empty-output"}`);
        }
        throw new Error(`${role} output protocol violation: invalid text result.`);
      },
    });
  }

  private async promptInScopedAssistantSession(text: string, attachments: AiAttachment[], scopeKey?: string, scopeLabel?: string, onProgress?: AssistantProgressHandler): Promise<{ rawText: string; usedNativeExecution: boolean; completedActions: string[] }> {
    const entry = await this.getOrCreateSession(scopeKey, scopeLabel);
    await logger.info("pi sdk assistant text prompt request");
    const response = await this.promptSessionForAssistant(entry.session, text, attachments, onProgress);
    touchActivity();
    await logger.info(`pi sdk assistant text prompt raw=${JSON.stringify(response.rawText)}`);
    return response;
  }

  private async promptInLightTextSession(text: string, role?: PromptRole): Promise<string> {
    return this.promptInDisposableTextSession({
      title: "Light text",
      role: role || "writer",
      useTools: role === "assistant",
      requestLog: "pi sdk light text prompt request",
      rawLogLabel: "pi sdk light text prompt",
      execute: (session) => this.promptSessionForLightText(session, text, [], role),
    });
  }

  private async promptInDisposableTextSession(input: {
    title: string;
    role: PromptRole;
    useTools: boolean;
    requestLog: string;
    rawLogLabel: string;
    execute: (session: AgentSession) => Promise<string>;
  }): Promise<string> {
    const session = await this.createSession(undefined, input.title, input.role, input.useTools);
    try {
      await logger.info(input.requestLog);
      const rawText = await input.execute(session.session);
      touchActivity();
      await logger.info(`${input.rawLogLabel} raw=${JSON.stringify(rawText)}`);
      return rawText;
    } finally {
      await session.session.abort().catch(() => {});
      session.session.dispose();
    }
  }

  private async promptAssistantTurn(text: string, attachments: AiAttachment[], scopeKey?: string): Promise<AiTurnResult> {
    const entry = await this.getOrCreateSession(scopeKey, scopeKey);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const promptText = attempt === 1
        ? text
        : [
            text,
            "",
            "Your previous output was invalid.",
            "Return a displayable user-visible reply text for this turn in the configured persona.",
          ].join("\n");

      let rawText = "";
      try {
        await logger.info(attempt === 1 ? "pi sdk prompt request" : "pi sdk prompt retry request");
        rawText = await this.promptSessionForLightText(entry.session, promptText, attachments, "assistant");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/no text output/i.test(message) && attempt < 2) {
          await logger.warn(`discarded assistant output attempt=${attempt} reason=empty-output`);
          continue;
        }
        throw error;
      }
      touchActivity();
      const parsed = extractAiTurnResultFromText(rawText);
      if (parsed.message.trim() && isDisplayableUserText(parsed.message)) {
        return parsed;
      }
      await logger.warn(`discarded assistant output attempt=${attempt} reason=non-displayable`);
    }
    throw new Error("Model returned no displayable user reply.");
  }

  private async promptSessionForText(session: AgentSession, text: string, attachments: AiAttachment[], role: "assistant" | "maintainer"): Promise<string> {
    if (role === "assistant") {
      return (await this.promptSessionForAssistant(session, text, attachments)).rawText;
    }
    const promptAttachments = await this.filterAttachmentsForSelectedModel(attachments, `${role} text prompt`);
    const startedAt = Date.now();
    await logger.info(`pi sdk text prompt start sessionId=${session.sessionId} model=${JSON.stringify(state.model || "default")} textChars=${text.length} attachments=${promptAttachments.length} mode=full role=${role}`);
    const result = await this.runPiPrompt(session, text, promptAttachments, false);
    const rawText = result.rawText.trim();
    await logger.info(`pi sdk text prompt response ms=${Date.now() - startedAt} sessionId=${session.sessionId} rawChars=${rawText.length} mode=full role=${role}`);
    if (!rawText) throw new Error("Pi SDK returned no text output.");
    return rawText;
  }

  async promptSessionForAssistant(session: AgentSession, text: string, attachments: AiAttachment[], _onProgress?: AssistantProgressHandler): Promise<{ rawText: string; usedNativeExecution: boolean; completedActions: string[] }> {
    return this.promptSessionForAgent(session, text, attachments, "assistant");
  }

  private async promptSessionForAgent(session: AgentSession, text: string, attachments: AiAttachment[], role: "assistant"): Promise<{ rawText: string; usedNativeExecution: boolean; completedActions: string[] }> {
    const promptAttachments = await this.filterAttachmentsForSelectedModel(attachments, `${role} agent prompt`);
    const startedAt = Date.now();
    await logger.info(`pi sdk text prompt start sessionId=${session.sessionId} model=${JSON.stringify(state.model || "default")} textChars=${text.length} attachments=${promptAttachments.length} mode=full role=${role}`);
    const result = await this.runPiPrompt(session, text, promptAttachments, true);
    const rawText = result.rawText.trim();
    const completedActions = result.completedActions;
    const executionParts = summarizeToolResults(result.newMessages);
    await logger.info(`pi sdk text prompt response ms=${Date.now() - startedAt} sessionId=${session.sessionId} rawChars=${rawText.length} messages=${result.newMessages.length} mode=full role=${role} actions=${completedActions.length}`);
    if (executionParts.length > 0) {
      await logger.info(`pi sdk ${role} execution parts ${JSON.stringify(executionParts)}`);
    }
    return { rawText, usedNativeExecution: completedActions.length > 0, completedActions };
  }

  private async promptSessionForLightText(session: AgentSession, text: string, attachments: AiAttachment[], role?: PromptRole): Promise<string> {
    const promptAttachments = await this.filterAttachmentsForSelectedModel(attachments, `${role || "default"} light prompt`);
    const startedAt = Date.now();
    await logger.info(`pi sdk text prompt start sessionId=${session.sessionId} model=${JSON.stringify(state.model || "default")} textChars=${text.length} attachments=${promptAttachments.length} mode=light${role ? ` role=${role}` : ""}`);
    const result = await this.runPiPrompt(session, text, promptAttachments, role === "assistant");
    ensureNoToolExecution(role, result.newMessages.flatMap((message: any) => Array.isArray(message?.content) ? message.content : []));
    const rawText = result.rawText.trim();
    await logger.info(`pi sdk text prompt response ms=${Date.now() - startedAt} sessionId=${session.sessionId} rawChars=${rawText.length} messages=${result.newMessages.length} mode=light`);
    if (!rawText) {
      await logger.warn(`pi sdk returned no assistant text model=${JSON.stringify(state.model || "default")} sessionId=${session.sessionId} messages=${JSON.stringify(summarizeMessagesForDebug(result.newMessages))}`);
      throw new Error(`Pi SDK returned no text output from model ${state.model || "default"}.`);
    }
    if (rawText === text.trim()) throw new Error("Pi SDK echoed the input prompt instead of returning assistant text.");
    return rawText;
  }

  private async runPiPrompt(session: AgentSession, text: string, attachments: AiAttachment[], collectTools: boolean): Promise<{ rawText: string; completedActions: string[]; newMessages: unknown[] }> {
    const beforeCount = session.messages.length;
    const completedActions: string[] = [];
    const chunks: string[] = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") chunks.push(event.assistantMessageEvent.delta);
      if (collectTools && event.type === "tool_execution_end" && !event.isError) completedActions.push(event.toolName);
    });
    try {
      await session.prompt(text, { images: this.buildImages(attachments), expandPromptTemplates: false, source: "api" as any });
    } finally {
      unsubscribe();
    }
    const newMessages = session.messages.slice(beforeCount);
    const lastAssistantText = [...newMessages].reverse().map(extractAssistantText).find((item) => item.trim()) || chunks.join("");
    return { rawText: lastAssistantText, completedActions, newMessages };
  }

  private attachmentLogSummary(attachments: AiAttachment[]): Array<{ mimeType: string; filename?: string; urlScheme: string }> {
    return attachments.map((attachment) => ({
      mimeType: attachment.mimeType,
      filename: attachment.filename,
      urlScheme: attachment.url.startsWith("data:") ? "data" : attachment.url.startsWith("http") ? "http" : "other",
    }));
  }
}
