import path from "node:path";
import {
  ModelRegistry,
  ModelRuntime,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig, AiAttachment, UploadedFile } from "bot/app/types";
import { logger } from "bot/app/logger";
import { formatIsoInTimezoneParts } from "bot/app/time";
import { state, touchActivity } from "bot/app/state";
import { buildPersonaStyleLines, buildProjectSystemPrompt, type RequestPermissionMode } from "./prompt";
import { extractAiTurnResultFromText, isDisplayableUserText } from "./response";
import type { AiTurnResult, AssistantPlanResult, AssistantProgressHandler, ReminderTextContext } from "./types";
import { ReplyComposer, type ReplyComposerInputContext } from "./reply-composer";
import { StructuredReasoner } from "./structured-reasoner";
import { PromptTemplateRenderer } from "./prompt-templates";
import { assistantErrorFromMessages, ensureNoToolExecution, extractAssistantText, summarizeMessagesForDebug, summarizeToolResults, type PiPromptRole } from "./pi-response";
import { SessionBroker, type SessionBrokerEntry } from "./session-broker";
import { PiSessionFactory, type CreateSessionOptions } from "./pi-session-factory";
import { quotaText } from "./quota";

export type { AiTurnResult } from "./types";

type SessionEntry = SessionBrokerEntry<AgentSession>;

type PromptRole = PiPromptRole;

type AttachmentCapabilityCache = {
  modelKey: string;
  supportsAttachments: boolean;
  checkedAt: number;
};

const MODEL_CAPABILITY_CACHE_MS = 60_000;
const MODEL_REGISTRY_REFRESH_CACHE_MS = 60_000;
const COMPOSER_WEB_TOOLS = ["web_search", "fetch_content", "get_search_content"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function toolNameFromEvent(event: Record<string, unknown>): string {
  const direct = event.tool_name ?? event.toolName ?? event.name;
  if (typeof direct === "string") return direct;
  const tool = asRecord(event.tool) || asRecord(event.toolCall) || asRecord(event.call);
  const nested = tool?.name ?? tool?.toolName ?? tool?.tool_name;
  if (typeof nested === "string") return nested;
  const input = asRecord(event.input) || asRecord(event.args);
  const inputName = input?.toolName ?? input?.name;
  return typeof inputName === "string" ? inputName : "";
}

function isTextGenerationEvent(event: unknown): boolean {
  const record = asRecord(event);
  if (record?.type !== "message_update") return false;
  const delta = asRecord(record.assistantMessageEvent);
  return delta?.type === "text_delta" || delta?.type === "text_start";
}

function isToolProgressEvent(event: unknown): boolean {
  const record = asRecord(event);
  if (!record) return false;
  if (typeof record.type === "string" && record.type.startsWith("tool_execution_")) return true;
  if (record.type !== "message_update") return false;
  const delta = asRecord(record.assistantMessageEvent);
  return delta?.type === "toolcall_start" || delta?.type === "toolcall_end";
}

function toolArgPreview(toolName: string, args: unknown): string {
  const record = asRecord(args);
  if (!record) return "";
  const value = toolName === "bash" ? record.command
    : toolName === "read" || toolName === "write" || toolName === "edit" || toolName === "find" || toolName === "ls" ? record.path
      : toolName === "grep" ? record.pattern
        : Object.values(record).find((item) => typeof item === "string");
  return typeof value === "string" ? value.slice(0, 80) : "";
}

function skillNameFromReadArgs(args: unknown): string | null {
  const filePath = asRecord(args)?.path;
  if (typeof filePath !== "string" || !filePath.endsWith("SKILL.md")) return null;
  return path.basename(path.dirname(filePath));
}

function statusTextFromAgentEvent(event: unknown): string | null {
  const record = asRecord(event);
  if (!record) return null;
  switch (record.type) {
    case "agent_start": return "开始处理…";
    case "turn_start": return "思考中…";
    case "compaction_start": return "正在整理上下文…";
    case "auto_retry_start": {
      const delayMs = typeof record.delayMs === "number" ? record.delayMs : 0;
      return `请求失败，${Math.ceil(delayMs / 1000)} 秒后重试…`;
    }
    case "message_update": {
      const delta = asRecord(record.assistantMessageEvent);
      if (delta?.type === "thinking_delta" || delta?.type === "thinking_start") return "思考中…";
      if (delta?.type === "toolcall_start") return "准备调用工具…";
      if (delta?.type === "toolcall_end") {
        const toolCall = asRecord(delta.toolCall);
        return `准备调用工具：${typeof toolCall?.name === "string" ? toolCall.name : ""}`.trim();
      }
      if (delta?.type === "text_delta" || delta?.type === "text_start") return "正在生成回复…";
      return null;
    }
    case "tool_execution_start": {
      const tool = toolNameFromEvent(record);
      const skill = tool === "read" ? skillNameFromReadArgs(record.args) : null;
      const preview = toolArgPreview(tool, record.args);
      if (skill) return `正在加载 skill：${skill}`;
      return `正在调用工具：${tool}${preview ? ` ${preview}` : ""}`;
    }
    case "tool_execution_update": return `工具运行中：${toolNameFromEvent(record)}`;
    case "tool_execution_end": return `${record.isError ? "工具失败" : "工具完成"}：${toolNameFromEvent(record)}`;
    default: return null;
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

export class AiService {
  private config: AppConfig;
  private readonly modelRuntimePromise: Promise<ModelRuntime>;
  private modelRegistry: ModelRegistry | null = null;
  private readonly sessions: SessionBroker<AgentSession>;
  private readonly replyComposer: ReplyComposer;
  private readonly structuredReasoner: StructuredReasoner;
  private readonly promptTemplates: PromptTemplateRenderer;
  private readonly sessionFactory: PiSessionFactory;
  private modelRegistryLastRefreshAt = 0;
  private attachmentCapabilityCache: AttachmentCapabilityCache | null = null;

  constructor(config: AppConfig) {
    this.config = config;
    this.modelRuntimePromise = ModelRuntime.create({
      authPath: path.join(this.piAgentDir(), "auth.json"),
      modelsPath: path.join(this.piAgentDir(), "models.json"),
    }).then((runtime) => {
      this.modelRegistry = new ModelRegistry(runtime);
      return runtime;
    });
    this.sessions = new SessionBroker(
      (scopeKey, scopeLabel) => this.createSession(scopeKey, scopeLabel, "assistant", true),
    );
    this.promptTemplates = new PromptTemplateRenderer(() => this.piAgentDir());
    this.sessionFactory = new PiSessionFactory({
      config,
      cwd: () => this.agentWorkspaceDir(),
      agentDir: () => this.piAgentDir(),
      modelRuntime: () => this.modelRuntimePromise,
      ensureReady: () => this.ensureReady(),
      selectedModel: () => this.selectedModel(),
      systemPromptForRole: (role) => this.systemPromptForRole(role),
      appendSystemPromptForRole: (role) => this.appendSystemPromptForRole(role),
    });
    this.replyComposer = new ReplyComposer(
      config,
      (text) => this.promptInLightTextSession(text, "writer"),
      (text) => this.promptInLightTextSession(text, "writer"),
      (input) => this.renderPromptTemplate("composer", input),
    );
    this.structuredReasoner = new StructuredReasoner(config, (promptText, attachments, scopeKey) => this.promptAssistantTurn(promptText, attachments, scopeKey), (attachments) => this.attachmentLogSummary(attachments));
  }

  private agentWorkspaceDir(): string {
    return path.join(this.config.paths.repoRoot, "agent");
  }

  private piAgentDir(): string {
    return path.join(this.agentWorkspaceDir(), ".pi");
  }

  private renderPromptTemplate(name: string, variables: Record<string, unknown>): string {
    return this.promptTemplates.render(name, variables);
  }

  reloadConfig(config: AppConfig): void {
    this.config = config;
    this.replyComposer.updateConfig(config);
    this.structuredReasoner.updateConfig(config);
    this.sessionFactory.updateConfig(config);
    this.promptTemplates.clear();
    this.stop();
  }

  async ensureReady(): Promise<void> {
    const startedAt = Date.now();
    await this.modelRuntimePromise;
    const registry = this.requireModelRegistry();
    if (Date.now() - this.modelRegistryLastRefreshAt > MODEL_REGISTRY_REFRESH_CACHE_MS) {
      await registry.refresh();
      this.modelRegistryLastRefreshAt = Date.now();
    }
    const available = registry.getAvailable();
    if (available.length === 0) {
      throw new Error("Pi SDK has no authenticated models available. Configure credentials in agent/.pi/auth.json, environment variables, or agent/.pi/models.json.");
    }
    await logger.info(`pi sdk ready ms=${Date.now() - startedAt} models=${available.length}`);
  }

  async warmAssistantResources(): Promise<void> {
    const entry = await this.createSession(undefined, "Warm assistant resources", "assistant", true);
    await entry.session.abort().catch(() => {});
    entry.session.dispose();
    await logger.info("pi sdk assistant resources warmed");
  }

  private requireModelRegistry(): ModelRegistry {
    if (!this.modelRegistry) throw new Error("Pi model runtime is not initialized");
    return this.modelRegistry;
  }

  private selectedModel(): any | undefined {
    const parsed = parseModel(state.model);
    return parsed ? this.modelRegistry?.find(parsed.providerID, parsed.modelID) : undefined;
  }

  private async createSession(scopeKey: string | undefined, scopeLabel: string | undefined, role: PromptRole, useTools = role === "assistant", options: CreateSessionOptions = {}): Promise<SessionEntry> {
    if (state.model && !this.selectedModel()) {
      throw new Error(`Selected model is unavailable: ${state.model}`);
    }
    return this.sessionFactory.createSession(scopeKey, scopeLabel, role, useTools, options);
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

  async quotaText(): Promise<string> {
    return quotaText(this.piAgentDir(), "left");
  }

  async listModels(): Promise<{ defaults: Record<string, string>; models: string[] }> {
    await this.ensureReady();
    const registry = this.requireModelRegistry();
    const models = registry.getAvailable().map((model: any) => `${model.provider}/${model.id}`).sort((a, b) => a.localeCompare(b));
    const current = this.selectedModel() || registry.getAvailable()[0];
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
      const model = this.requireModelRegistry().find(parsed.providerID, parsed.modelID) as any;
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
    permissionMode: RequestPermissionMode = "full",
    sharedConversationContextText?: string,
    requesterTimezone?: string | null,
  ): Promise<AiTurnResult> {
    return this.structuredReasoner.run(text, uploadedFiles, attachments, messageTime, permissionMode, scopeKey, sharedConversationContextText, requesterTimezone);
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
    const request = this.renderPromptTemplate("composer", {
      task: "scheduled-content",
      context: [
        "Generate fresh, useful content for this recurring automated task.",
        "Use web access when needed to gather current external information before writing the final message.",
        `Task prompt: ${taskPrompt}`,
      ].join("\n"),
      language: this.config.bot.language,
      capabilities: "web: true\nstateMutation: false\nfeishuDelivery: false\nrepoTools: false",
    });
    return this.promptInDisposableComposerWebSession(request);
  }

  async composeMaintenanceReport(facts: string[], input?: ReplyComposerInputContext): Promise<string> {
    return this.replyComposer.composeMaintenanceReport(facts, input);
  }

  async runMaintenancePass(request: string): Promise<string> {
    const rendered = this.renderPromptTemplate("maintainer", {
      context: request.trim(),
      language: this.config.bot.language,
    });
    return (await this.promptInTemporaryTextSession(rendered, "maintainer")).trim();
  }

  async runAssistantTurn(input: {
    userRequestText: string;
    requesterUserId?: string;
    chatId?: string;
    chatType?: string;
    permissionMode: RequestPermissionMode;
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
    const policyFilteredAttachments: AiAttachment[] = nativeAttachments;

    const turnContext = [
      `requesterUserId=${input.requesterUserId ?? "unknown"}`,
      `chatId=${input.chatId ?? "unknown"}`,
      `chatType=${input.chatType || "unknown"}`,
      `permissionMode=${input.permissionMode}`,
      localMessageTime ? `requesterLocalTime=${localMessageTime.localDateTime} (${localMessageTime.timezone})` : "",
    ].filter(Boolean).join("\n");
    const savedFiles = input.uploadedFiles && input.uploadedFiles.length > 0
      ? ["Saved files:", ...(input.uploadedFiles || []).map((file) => `- ${file.savedPath} (${file.mimeType}, ${Math.ceil(file.sizeBytes / 1024)} KB)`)].join("\n")
      : "";
    const prompt = this.renderPromptTemplate("assistant-turn", {
      turnContext,
      assistantContext: input.sharedConversationContextText?.trim() ? `Assistant context:\n${input.sharedConversationContextText.trim()}` : "",
      savedFiles,
      userRequest: input.userRequestText.trim(),
    });

    let lastCompletedActions: string[] = [];
    let lastUsedNativeExecution = false;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt === 3) {
        if (lastCompletedActions.length > 0) break;
        await logger.warn("resetting assistant session after repeated empty output");
        await this.disposeSession(input.scopeKey);
      }
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
            "Use the needed tools, then return the final user-visible reply for this turn.",
          ].join("\n");
      const promptAttachments = await this.filterAttachmentsForSelectedModel(policyFilteredAttachments, "assistant turn");
      const response = await this.promptInScopedAssistantSession(attemptPrompt, promptAttachments, input.scopeKey, input.scopeLabel, input.onProgress);
      if (input.isTaskCurrent && !input.isTaskCurrent()) {
        await logger.warn("assistant agent response ignored because task became stale");
        return { message: "", usedNativeExecution: false, completedActions: response.completedActions, files: [], attachments: [] };
      }
      lastCompletedActions = response.completedActions;
      lastUsedNativeExecution = response.usedNativeExecution;
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
    await logger.warn(`assistant produced no valid output after retries actions=${JSON.stringify(lastCompletedActions)} usedNativeExecution=${lastUsedNativeExecution ? "yes" : "no"}`);
    if (lastCompletedActions.length === 0) await this.disposeSession(input.scopeKey);
    throw new Error("Assistant returned no displayable output.");
  }

  async resetSessions(): Promise<void> {
    await this.sessions.disposeAll();
  }

  stop(): void {
    void this.resetSessions();
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
    return buildProjectSystemPrompt(role);
  }

  private appendSystemPromptForRole(role: PromptRole): string[] {
    const label = role === "maintainer" ? "Summary style" : role === "writer" ? "Reply style" : "Style";
    const lines = buildPersonaStyleLines(this.config.bot.personaStyle, { label });
    return lines.length > 0 ? ["## Persona", ...lines] : [];
  }

  private async promptInTemporaryTextSession(text: string, role: "maintainer"): Promise<string> {
    return this.promptInDisposableTextSession({
      title: "Maintainer",
      role,
      useTools: false,
      requestLog: `pi sdk ${role} text prompt request`,
      rawLogLabel: `pi sdk ${role} text prompt`,
      execute: (session) => this.promptSessionForText(session, text, [], role),
    });
  }

  private async promptInDisposableComposerWebSession(text: string): Promise<string> {
    return this.promptInDisposableTextSession({
      title: "Composer web",
      role: "writer",
      useTools: true,
      sessionOptions: {
        noContextFiles: true,
        noSkills: true,
        toolAllowlist: COMPOSER_WEB_TOOLS,
      },
      requestLog: "pi sdk composer web prompt request",
      rawLogLabel: "pi sdk composer web prompt",
      execute: async (session) => {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const attemptText = attempt === 1
            ? text
            : [
                text,
                "",
                "Your previous output was invalid.",
                "Return only plain user-visible text. Do not claim state changes or delivery.",
              ].join("\n");
          const response = await this.promptSessionForAgent(session, attemptText, [], "assistant");
          const rawText = response.rawText.trim();
          const forbiddenActions = response.completedActions.filter((name) => !COMPOSER_WEB_TOOLS.includes(name));
          if (forbiddenActions.length > 0) throw new Error(`composer web session executed forbidden tools: ${forbiddenActions.join(", ")}`);
          if (rawText && isDisplayableUserText(rawText)) return rawText;
          await logger.warn(`discarded composer web output attempt=${attempt} reason=${rawText ? "non-displayable" : "empty-output"}`);
        }
        throw new Error("composer web output protocol violation: invalid text result.");
      },
    });
  }

  private async promptInScopedAssistantSession(text: string, attachments: AiAttachment[], scopeKey?: string, scopeLabel?: string, onProgress?: AssistantProgressHandler): Promise<{ rawText: string; usedNativeExecution: boolean; completedActions: string[] }> {
    const entry = await this.getOrCreateSession(scopeKey, scopeLabel);
    await logger.info("pi sdk assistant text prompt request");
    const response = await this.promptSessionForAssistant(entry.session, text, attachments, onProgress);
    this.sessions.touch(scopeKey);
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
    sessionOptions?: CreateSessionOptions;
    requestLog: string;
    rawLogLabel: string;
    execute: (session: AgentSession) => Promise<string>;
  }): Promise<string> {
    const session = await this.createSession(undefined, input.title, input.role, input.useTools, input.sessionOptions);
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
            "Return a displayable user-visible reply text for this turn.",
          ].join("\n");

      let rawText = "";
      try {
        await logger.info(attempt === 1 ? "pi sdk prompt request" : "pi sdk prompt retry request");
        rawText = await this.promptSessionForLightText(entry.session, promptText, attachments, "assistant");
        this.sessions.touch(scopeKey);
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

  private async promptSessionForText(session: AgentSession, text: string, attachments: AiAttachment[], role: "maintainer"): Promise<string> {
    const promptAttachments = await this.filterAttachmentsForSelectedModel(attachments, `${role} text prompt`);
    const startedAt = Date.now();
    await logger.info(`pi sdk text prompt start sessionId=${session.sessionId} model=${JSON.stringify(state.model || "default")} textChars=${text.length} attachments=${promptAttachments.length} mode=full role=${role}`);
    const result = await this.runPiPrompt(session, text, promptAttachments, false);
    const rawText = result.rawText.trim();
    await logger.info(`pi sdk text prompt response ms=${Date.now() - startedAt} sessionId=${session.sessionId} rawChars=${rawText.length} mode=full role=${role}`);
    if (!rawText) throw new Error("Pi SDK returned no text output.");
    return rawText;
  }

  async promptSessionForAssistant(session: AgentSession, text: string, attachments: AiAttachment[], onProgress?: AssistantProgressHandler): Promise<{ rawText: string; usedNativeExecution: boolean; completedActions: string[] }> {
    return this.promptSessionForAgent(session, text, attachments, "assistant", onProgress);
  }

  private async promptSessionForAgent(session: AgentSession, text: string, attachments: AiAttachment[], role: "assistant", onProgress?: AssistantProgressHandler): Promise<{ rawText: string; usedNativeExecution: boolean; completedActions: string[] }> {
    const promptAttachments = await this.filterAttachmentsForSelectedModel(attachments, `${role} agent prompt`);
    const startedAt = Date.now();
    await logger.info(`pi sdk text prompt start sessionId=${session.sessionId} model=${JSON.stringify(state.model || "default")} textChars=${text.length} attachments=${promptAttachments.length} mode=full role=${role}`);
    const result = await this.runPiPrompt(session, text, promptAttachments, true, onProgress);
    const rawText = result.rawText.trim();
    const completedActions = result.completedActions;
    const executionParts = summarizeToolResults(result.newMessages);
    await logger.info(`pi sdk text prompt response ms=${Date.now() - startedAt} sessionId=${session.sessionId} rawChars=${rawText.length} messages=${result.newMessages.length} mode=full role=${role} actions=${completedActions.length}`);
    if (!rawText && completedActions.length === 0) {
      await logger.warn(`pi sdk assistant produced no text/actions sessionId=${session.sessionId} messages=${JSON.stringify(summarizeMessagesForDebug(result.newMessages))}`);
    }
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

  private async runPiPrompt(session: AgentSession, text: string, attachments: AiAttachment[], collectTools: boolean, onProgress?: AssistantProgressHandler): Promise<{ rawText: string; completedActions: string[]; newMessages: unknown[] }> {
    const beforeCount = session.messages.length;
    const completedActions: string[] = [];
    const chunks: string[] = [];
    let lastToolProgressAt = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") chunks.push(event.assistantMessageEvent.delta);
      if (collectTools && event.type === "tool_execution_end" && !event.isError) completedActions.push(toolNameFromEvent(event));
      const progress = onProgress ? statusTextFromAgentEvent(event) : null;
      if (progress) {
        const isToolProgress = isToolProgressEvent(event);
        if (isToolProgress) lastToolProgressAt = Date.now();
        // Keep fast tool calls visible long enough for the debounced waiting-message edit.
        if (isTextGenerationEvent(event) && Date.now() - lastToolProgressAt < 3_000) return;
        void Promise.resolve(onProgress!(progress)).catch((error) => {
          void logger.warn(`assistant progress handler failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    });
    try {
      await session.prompt(text, { images: this.buildImages(attachments), expandPromptTemplates: false, source: "api" as any });
    } finally {
      unsubscribe();
    }
    const newMessages = session.messages.slice(beforeCount);
    const modelError = assistantErrorFromMessages(newMessages);
    if (modelError) throw new Error(`Pi model request failed: ${modelError}`);
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
