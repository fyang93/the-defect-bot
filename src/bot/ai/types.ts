import type { AiAttachment } from "bot/app/types";

export type ActionTargetReference = {
  id?: number;
  username?: string;
  displayName?: string;
};

export type ScheduleDraft = {
  title: string;
  note?: string;
  schedule: Record<string, unknown>;
  category?: "routine" | "special" | "automation";
  specialKind?: "birthday" | "festival" | "anniversary" | "memorial";
  timeSemantics?: "absolute" | "local";
  timezone?: string;
  subjectTimezone?: string;
  reminders?: Array<{ id?: string; offsetMinutes: number; enabled?: boolean; label?: string }>;
  targetUser?: ActionTargetReference;
  targetUsers?: ActionTargetReference[];
};

export type PendingAuthorizationDraft = {
  username: string;
  expiresAt: string;
};

export type AiTurnResult = {
  message: string;
  files: string[];
  attachments: AiAttachment[];
};

export type AssistantPlanResult = {
  message: string;
  usedNativeExecution: boolean;
  completedActions: string[];
  files?: string[];
  attachments?: AiAttachment[];
};

export type ReminderTextContext = {
  eventScheduledAt?: string;
  reminderLabel?: string;
  reminderOffsetMinutes?: number;
  specialKind?: "birthday" | "festival" | "anniversary" | "memorial";
  category?: "routine" | "special" | "automation";
};

export type AssistantProgressHandler = (message: string) => Promise<void> | void;
