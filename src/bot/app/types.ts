export type AppConfig = {
  feishu: {
    appId: string;
    appSecret: string;
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
  source: "file" | "image" | "audio" | "video";
  durationSeconds?: number;
};

export type AiAttachment = {
  mimeType: string;
  filename?: string;
  url: string;
};

export type SessionState = {
  model: string | null;
  lastActivityAt: string | null;
  lastMaintainedAt: string | null;
  recentUploadsByScope: Record<string, { files: UploadedFile[]; recentUploadsAt: string | null }>;
  recentClarificationsByScope: Record<string, { requestText: string; clarificationMessage: string; updatedAt: string }>;
  userTimezoneCache: Record<string, { timezone: string; updatedAt: string }>;
  feishuUserCache: Record<string, { displayName: string; lastSeenAt: string }>;
  feishuChatCache: Record<string, { type: "p2p" | "group" | "topic"; title?: string; lastSeenAt: string }>;
};
