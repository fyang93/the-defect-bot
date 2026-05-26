import type { AppConfig, AiAttachment, UploadedFile } from "bot/app/types";
import { logger } from "bot/app/logger";
import { buildPrompt, type RequestAccessRole } from "./prompt";
import type { AiTurnResult } from "./types";

export class StructuredReasoner {
  constructor(
    private config: AppConfig,
    private readonly executePrompt: (promptText: string, attachments: AiAttachment[], scopeKey?: string) => Promise<AiTurnResult>,
    private readonly summarizeAttachments: (attachments: AiAttachment[]) => Array<{ mimeType: string; filename?: string; urlScheme: string }>,
  ) {}

  updateConfig(config: AppConfig): void {
    this.config = config;
  }

  async run(
    text: string,
    uploadedFiles: UploadedFile[] = [],
    attachments: AiAttachment[] = [],
    messageTime?: string,
    accessRole: RequestAccessRole = "allowed",
    scopeKey?: string,
    assistantContextText?: string,
    requesterTimezone?: string | null,
  ): Promise<AiTurnResult> {
    const promptText = buildPrompt(
      text,
      uploadedFiles,
      this.config.bot.defaultTimezone,
      this.config.bot.personaStyle,
      messageTime,
      accessRole,
      assistantContextText,
      requesterTimezone,
    );
    await logger.info(`ai prompt request attachments=${JSON.stringify(this.summarizeAttachments(attachments))}`);
    if (attachments.length > 0) {
      await logger.warn(`deferred ${attachments.length} native attachment(s) for assistant prompt; saved file paths remain available for tool-based handling`);
    }
    return await this.executePrompt(promptText, [], scopeKey);
  }
}
