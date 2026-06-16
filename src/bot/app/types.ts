export type AppConfig = {
  telegram: {
    botToken: string;
    adminUserId: number | null;
    waitingMessage: string;
    inputMergeWindowSeconds: number;
    menuPageSize: number;
  };
  bot: {
    personaStyle: string;
    language: "zh-CN" | "en";
    defaultTimezone: string;
  };
  paths: {
    repoRoot: string;
    tmpDir: string;
    uploadSubdir: string;
    logFile: string;
    stateFile: string;
  };
  maintenance: {
    enabled: boolean;
    idleAfterMs: number;
    tmpRetentionDays: number;
  };
};

export type UploadedFile = {
  savedPath: string;
  absolutePath: string;
  originalName: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  source: "document" | "photo" | "voice" | "audio" | "video";
  audioTitle?: string;
  audioPerformer?: string;
  durationSeconds?: number;
};

export type AiAttachment = {
  mimeType: string;
  filename?: string;
  url: string;
};

export type PendingAuthorization = {
  kind: "allowed";
  username: string;
  createdBy: number;
  createdAt: string;
  expiresAt: string;
};

export type SessionState = {
  model: string | null;
  lastActivityAt: string | null;
  lastMaintainedAt: string | null;
  recentUploadsByScope: Record<string, { files: UploadedFile[]; recentUploadsAt: string | null }>;
  recentClarificationsByScope: Record<string, { requestText: string; clarificationMessage: string; updatedAt: string }>;
  // Runtime caches hydrated from canonical system registries and refreshed during execution.
  // These improve hot-path reads but are not the source of truth.
  userTimezoneCache: Record<string, { timezone: string; updatedAt: string }>;
  telegramUserCache: Record<string, { username?: string; firstName?: string; lastName?: string; displayName: string; lastSeenAt: string; languageCode?: string }>;
  telegramChatCache: Record<string, { type: string; title?: string; lastSeenAt: string }>;
  pendingAuthorizations: PendingAuthorization[];
};
