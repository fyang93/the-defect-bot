import path from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
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
import { PromptTemplateRenderer } from "./prompt-templates";
import { ensureNoToolExecution, extractAssistantText, summarizeMessagesForDebug, summarizeToolResults, type PiPromptRole } from "./pi-response";
import { SessionBroker, type SessionBrokerEntry } from "./session-broker";
import { PiSessionFactory, type CreateSessionOptions } from "./pi-session-factory";

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

const STATE_CHANGE_ACTION_PATTERN = /删除|删掉|取消|移除|暂停|恢复|修改|更新|设置|创建|新增|添加|发送|转发|delete|remove|cancel|pause|resume|update|set|create|add|send/i;
const STATE_OBJECT_PATTERN = /提醒|日程|事件|组会|会议|用户|权限|授权|消息|文件|reminder|schedule|event|meeting|user|access|auth|message|file/i;
const COMPLETED_STATE_CHANGE_PATTERN = /已|已经|完成|成功|好了|删除了|删掉了|取消了|设置了|创建了|添加了|发送了|done|deleted|removed|cancelled|created|updated|sent|scheduled/i;

function isStateChangingRequest(text: string): boolean {
  return STATE_CHANGE_ACTION_PATTERN.test(text) && STATE_OBJECT_PATTERN.test(text);
}

function claimsCompletedStateChange(text: string): boolean {
  return COMPLETED_STATE_CHANGE_PATTERN.test(text) && STATE_OBJECT_PATTERN.test(text);
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
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly sessionManager: SessionManager;
  private readonly sessions: SessionBroker<AgentSession>;
  private readonly replyComposer: ReplyComposer;
  private readonly structuredReasoner: StructuredReasoner;
  private readonly promptTemplates: PromptTemplateRenderer;
  private readonly sessionFactory: PiSessionFactory;
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
    this.promptTemplates = new PromptTemplateRenderer(() => this.piAgentDir());
    this.sessionFactory = new PiSessionFactory({
      config,
      agentDir: () => this.piAgentDir(),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: this.sessionManager,
      ensureReady: () => this.ensureReady(),
      selectedModel: () => this.selectedModel(),
      systemPromptForRole: (role) => this.systemPromptForRole(role),
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

  async warmAssistantResources(): Promise<void> {
    const entry = await this.createSession(undefined, "Warm assistant resources", "assistant", true);
    await entry.session.abort().catch(() => {});
    entry.session.dispose();
    await logger.info("pi sdk assistant resources warmed");
  }

  private selectedModel(): any | undefined {
    const parsed = parseModel(state.model);
    return parsed ? this.modelRegistry.find(parsed.providerID, parsed.modelID) : undefined;
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
    const request = this.renderPromptTemplate("composer", {
      task: "scheduled-content",
      context: [
        "Generate fresh, useful content for this recurring automated task.",
        "Use web access when needed to gather current external information before writing the final message.",
        `Task prompt: ${taskPrompt}`,
      ].join("\n"),
      language: this.config.bot.language,
      style: this.config.bot.personaStyle?.trim() || "default",
      capabilities: "web: true\nstateMutation: false\ntelegramDelivery: false\nrepoTools: false",
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
      style: this.config.bot.personaStyle?.trim() || "default",
    });
    return (await this.promptInTemporaryTextSession(rendered, "maintainer")).trim();
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
    const stateChangingRequest = isStateChangingRequest(input.userRequestText);

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
            stateChangingRequest ? "This request changes bot state; you must call the repository tool. If no tool can run, say you did not complete it." : "",
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
      if (stateChangingRequest && hasDisplayableMessage && claimsCompletedStateChange(parsed.message)) {
        await logger.warn(`discarded assistant output attempt=${attempt} reason=claimed-state-change-without-tool`);
        if (attempt < 2) continue;
        return {
          message: this.config.bot.language === "en"
            ? "I did not actually complete that change because no repository tool ran. Please specify the exact reminder/event and try again."
            : "我没有实际完成这次修改，因为没有工具执行记录。请指定要操作的提醒/日程后再试一次。",
          usedNativeExecution: false,
          completedActions: [],
          files: [],
          attachments: [],
        };
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
