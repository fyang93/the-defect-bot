export type ScheduleRecurrence =
  | { kind: "once" }
  | { kind: "interval"; unit: "minute" | "hour" | "day" | "week" | "month" | "year"; every: number }
  | { kind: "weekly"; every: number; daysOfWeek: number[] }
  | { kind: "monthly"; every: number; mode: "dayOfMonth"; dayOfMonth: number }
  | { kind: "monthly"; every: number; mode: "nthWeekday"; weekOfMonth: number; dayOfWeek: number }
  | { kind: "yearly"; every: number; month: number; day: number; offsetDays?: number }
  | { kind: "lunarYearly"; month: number; day: number; isLeapMonth?: boolean; leapMonthPolicy?: "same-leap-only" | "prefer-non-leap" | "both"; offsetDays?: number };

export type ScheduleSpecialKind = "birthday" | "festival" | "anniversary" | "memorial";

export type EventView = "menu" | "upcoming" | "routine" | "special" | "special:birthday" | "special:festival" | "special:anniversary" | "special:memorial" | "all";

export type EventSchedule =
  | { kind: "once"; scheduledAt: string }
  | { kind: "interval"; unit: "minute" | "hour" | "day" | "week" | "month" | "year"; every: number; anchorAt: string }
  | { kind: "weekly"; every: number; daysOfWeek: number[]; time: { hour: number; minute: number }; anchorDate?: string }
  | { kind: "monthly"; every: number; mode: "dayOfMonth"; dayOfMonth: number; time: { hour: number; minute: number }; anchorDate?: string }
  | { kind: "monthly"; every: number; mode: "nthWeekday"; weekOfMonth: number; dayOfWeek: number; time: { hour: number; minute: number }; anchorDate?: string }
  | { kind: "yearly"; every: number; month: number; day: number; time: { hour: number; minute: number } }
  | { kind: "lunarYearly"; month: number; day: number; isLeapMonth?: boolean; leapMonthPolicy?: "same-leap-only" | "prefer-non-leap" | "both"; time: { hour: number; minute: number } };

export type Reminder = {
  id: string;
  offsetMinutes: number;
  enabled: boolean;
  label?: string;
};

export type EventOccurrence = {
  scheduledAt: string;
};

export type ReminderInstance = {
  reminderId: string;
  offsetMinutes: number;
  notifyAt: string;
  label?: string;
};

export type ScheduleDeliveryState = {
  currentOccurrence?: {
    scheduledAt: string;
    sentReminderIds: string[];
  };
};

export type EventTimeSemantics = "absolute" | "local";

export type EventTarget = {
  targetKind: "user" | "chat";
  targetId: string;
};

export type EventRecord = {
  id: string;
  title: string;
  note?: string;
  timeSemantics: EventTimeSemantics;
  createdByUserId?: string;
  schedule: EventSchedule;
  reminders: Reminder[];
  category?: "routine" | "special" | "automation";
  specialKind?: "birthday" | "festival" | "anniversary" | "memorial";
  status: "active" | "paused" | "deleted";
  createdAt: string;
  updatedAt?: string;
  targets: EventTarget[];
  deliveryText?: string;
  deliveryTextGeneratedAt?: string;
  deliveryPreparedReminderId?: string;
  deliveryPreparedNotifyAt?: string;
  deliveryState?: ScheduleDeliveryState;
};

export type EventStore = EventRecord[];
